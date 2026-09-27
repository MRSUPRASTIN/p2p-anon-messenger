'use strict';
/**
 * Zero-infrastructure peer discovery + signalling transport over UDP.
 *
 * Peers on the same LAN find each other and exchange WebRTC offers/ICE
 * candidates automatically. No broker, no account, no database: just broadcast
 * packets to 255.255.255.255, to the subnet-directed broadcast address of every
 * up interface, and to each port of a small pool - so a second copy of the app
 * on the same machine gets its own port and still finds the first one.
 *
 * This transport is the fast path. Two machines in different networks pair up
 * with the invite code instead (see renderer/net.js), which needs no discovery
 * at all.
 */
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

const PORT = Number(process.env.MOUTH_UDP_PORT || 45311);
/**
 * Ports a peer may be listening on. We bind the first free one, but we *announce
 * on all of them*, because two copies of the app on one machine cannot share a
 * port: with SO_REUSEADDR Windows happily binds both and then hands every
 * arriving datagram to an arbitrary one of them, so the offer reaches the wrong
 * process and the chat sits on «соединение…» for ever. Instead the second copy
 * takes the next port in the pool, and everybody shouts on the whole pool, so a
 * hello always reaches whoever owns which port.
 */
const POOL = [
  PORT,
  ...String(process.env.MOUTH_UDP_POOL || '45312,45313,45314,45315')
    .split(',')
    .map((n) => Number(n)),
  /* the pair test points both sides straight at each other */
  ...String(process.env.MOUTH_UDP_PEER_PORT || '')
    .split(',')
    .map((n) => Number(n)),
].filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

const MAGIC = 'MOUTH/1';
const BROADCAST_MS = 4000;
const PEER_TTL_MS = 45000;
const ROUTE_TTL_MS = 30000;
const MAX_ROUTES = 6;

/** Wire format: MAGIC + JSON, so foreign traffic is ignored on sight. */
function encode(payload) {
  return Buffer.from(MAGIC + ' ' + JSON.stringify(payload), 'utf8');
}

const listenPorts = () => [...new Set(POOL)];

function broadcastTargets(port) {
  const addrs = new Set(['255.255.255.255', '127.0.0.1']);
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ip = net.address.split('.').map(Number);
      if (ip.length !== 4 || ip.some((n) => !Number.isInteger(n))) continue;
      addrs.add([ip[0], ip[1], ip[2], 255].join('.'));
    }
  }
  const out = [];
  for (const p of [...new Set([port, ...listenPorts()])]) {
    for (const addr of addrs) out.push({ addr, port: p });
  }
  return out;
}

class Discovery extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.profile = null;
    this.timer = null;
    this.peers = new Map(); // id -> { id, name, color, emoji, routes: [{addr, port, at}] }
    this.seen = new Set(); // dedupe hellos
    this.boot = Math.random().toString(36).slice(2, 8);
    this.nonce = 0;
    this.port = PORT;
    this.binding = false;
    this.sendErrors = 0;
  }

  start(profile) {
    this.profile = profile;
    if (this.socket || this.binding) return;
    this.binding = true;
    this.bindIndex(0);
  }

  /** Walk the pool until a port is ours; an ephemeral one is the last resort. */
  bindIndex(index) {
    const ports = listenPorts();
    if (index >= ports.length) {
      this.bindPort(0, index);
      return;
    }
    this.bindPort(ports[index], index);
  }

  bindPort(port, index) {
    /* no SO_REUSEADDR on purpose: two sockets on one UDP port is exactly the
       situation this pool exists to avoid */
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    this.socket = socket;

    socket.on('message', (buf, rinfo) => this.handle(buf, rinfo));
    socket.on('error', (err) => {
      console.error('[discovery] socket error', err.message);
      /* a busy port is a normal outcome of running a second copy, not a fault */
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') this.emit('warn', err.message);
    });

    socket.once('error', (err) => {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') return;
      this.closeSocket();
      if (port !== 0) {
        console.warn('[discovery] udp port ' + port + ' is taken, trying the next one');
        this.bindIndex(index + 1);
      } else {
        this.emit('warn', 'Не удалось занять UDP-порт для поиска в сети');
      }
    });

    socket.bind(port, () => {
      this.port = socket.address().port;
      this.binding = false;
      if (this.port !== PORT) {
        console.log('[discovery] listening on udp ' + this.port + ' (pool: ' + listenPorts().join(', ') + ')');
      }
      this.afterBind();
    });
  }

  closeSocket() {
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }

  afterBind() {
    try {
      this.socket.setBroadcast(true);
    } catch (err) {
      console.error('[discovery] setBroadcast', err.message);
    }
    this.announce();
    this.timer = setInterval(() => this.announce(), BROADCAST_MS);
    this.emit('ready', { port: this.getPort(), targets: broadcastTargets(this.getPort()) });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.binding = false;
    this.closeSocket();
    this.peers.clear();
    this.seen.clear();
  }

  /** The port we are really listening on, which is what peers must send to. */
  getPort() {
    return this.port || PORT;
  }

  /**
   * A datagram that cannot leave is indistinguishable from one that never
   * arrived, and that is exactly how a discovered peer ends up stuck. Count the
   * failures so the log says something when the network eats the signalling.
   */
  ship(buf, port, addr) {
    if (!this.socket) return;
    this.socket.send(buf, 0, buf.length, port, addr, (err) => {
      if (!err) return;
      this.sendErrors += 1;
      if (this.sendErrors <= 5 || this.sendErrors % 20 === 0) {
        console.error('[discovery] send to ' + addr + ':' + port + ' failed: ' + err.message);
      }
    });
  }

  announce() {
    if (!this.profile) return;
    this.nonce = (this.nonce || 0) + 1;
    this.broadcast({
      t: 'hello',
      id: this.profile.id,
      name: this.profile.name,
      color: this.profile.color,
      emoji: this.profile.emoji,
      nonce: this.boot + ':' + this.nonce,
      port: this.getPort(),
      v: 1,
    });
  }

  broadcast(payload) {
    const buf = encode(payload);
    for (const target of broadcastTargets(this.getPort())) {
      this.ship(buf, target.port, target.addr);
    }
  }

  /**
   * Send to every address we have seen for this peer. A multi-homed machine
   * (Wi-Fi + VPN + Hyper-V/WSL adapter) shows up on several interfaces, and the
   * address that spoke last is often the one the other side cannot route to -
   * that is how a discovered peer ends up stuck on «соединение…» forever.
   * Signalling packets are tiny and duplicates are harmless (the peer discards
   * offers it has already answered), so we try them all and let the connection
   * settle on the route that actually works.
   */
  sendTo(peerId, payload) {
    if (!this.socket) return false;
    const peer = this.peers.get(peerId);
    if (!peer || !peer.routes || !peer.routes.length) return false;
    const buf = encode({ ...payload, to: peerId, port: this.getPort() });
    const routes = peer.routes.slice(-MAX_ROUTES);
    for (const route of routes) {
      this.ship(buf, route.port, route.addr);
    }
    return true;
  }

  /**
   * Remember where a packet came from. The announced port wins over the source
   * port of the datagram: if a peer had to move to another port because the
   * usual one was taken, we can only learn it from what it tells us.
   */
  addRoute(peer, rinfo, announcedPort) {
    if (!rinfo || !rinfo.address) return;
    const routes = peer.routes || (peer.routes = []);
    const port = Number(announcedPort) || rinfo.port || PORT;
    const known = routes.find((r) => r.addr === rinfo.address && r.port === port);
    if (known) {
      known.at = Date.now();
      return;
    }
    routes.push({ addr: rinfo.address, port, at: Date.now() });
    if (routes.length > MAX_ROUTES) routes.splice(0, routes.length - MAX_ROUTES);
  }

  handle(buf, rinfo) {
    const text = buf.toString('utf8');
    if (!text.startsWith(MAGIC + ' ')) return;
    let msg;
    try {
      msg = JSON.parse(text.slice(MAGIC.length + 1));
    } catch {
      return;
    }
    if (!msg || msg.t === undefined) return;
    if (this.profile && msg.id === this.profile.id) return; // our own broadcast
    if (msg.to && msg.to !== (this.profile && this.profile.id)) return; // not for us

    if (msg.t === 'hello') {
      // a nonce we have already answered must not trigger another reply (no storms)
      const key = msg.id + ':' + (msg.nonce || '');
      const alreadySeen = this.seen.has(key);
      this.seen.add(key);
      if (this.seen.size > 512) this.seen = new Set([...this.seen].slice(-256));
      const known = this.peers.get(msg.id);
      const peer = {
        id: msg.id,
        name: msg.name || (known && known.name) || 'Unknown',
        color: msg.color || (known && known.color) || '#6366f1',
        emoji: msg.emoji || (known && known.emoji) || '',
        routes: known && known.routes ? known.routes.slice() : [],
        at: Date.now(),
      };
      this.peers.set(msg.id, peer);
      this.addRoute(peer, rinfo, msg.port);
      this.emit('peer', peer, !known);
      if (alreadySeen) return;
      // answer directly so the other side learns us without waiting for the next
      // tick; the reply goes back to the address and port the hello came from and
      // carries the port we are really on
      const reply = encode({
        t: 'hello',
        id: this.profile.id,
        name: this.profile.name,
        color: this.profile.color,
        emoji: this.profile.emoji,
        nonce: msg.nonce,
        port: this.getPort(),
        v: 1,
      });
      this.ship(reply, msg.port || rinfo.port || PORT, rinfo.address);
      return;
    }

    if (msg.t === 'bye') {
      this.peers.delete(msg.id);
      this.emit('bye', msg.id);
      return;
    }

    // a peer may answer from a source port other than the one it announced
    const sender = msg.id || msg.from;
    const known = this.peers.get(sender);
    if (known) {
      this.addRoute(known, rinfo, msg.port);
      known.at = Date.now();
    }

    // signalling payloads carry the sender in `from`; normalise it to `id` so
    // the renderer has one field to route by
    this.emit('signal', { ...msg, id: sender, addr: rinfo.address }, rinfo);
  }

  /** Peers seen recently, newest first. */
  list() {
    const now = Date.now();
    const out = [];
    for (const [id, peer] of this.peers) {
      if (now - peer.at > PEER_TTL_MS) {
        this.peers.delete(id);
        continue;
      }
      peer.routes = (peer.routes || []).filter((r) => now - r.at < ROUTE_TTL_MS);
      const last = peer.routes[peer.routes.length - 1];
      out.push({ ...peer, addr: last ? last.addr : '', port: last ? last.port : this.getPort() });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  remember(peerId, addr) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (addr) {
      peer.routes = peer.routes || [];
      peer.routes.push({ addr, port: this.getPort(), at: Date.now() });
      if (peer.routes.length > MAX_ROUTES) peer.routes.splice(0, peer.routes.length - MAX_ROUTES);
    }
    peer.at = Date.now();
  }

  sayBye() {
    if (!this.socket || !this.profile) return;
    this.broadcast({ t: 'bye', id: this.profile.id });
  }
}

module.exports = { Discovery, PORT, POOL: listenPorts() };
