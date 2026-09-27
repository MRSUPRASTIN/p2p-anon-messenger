/**
 * Peer-to-peer transport.
 *
 * Signalling, both variants without any server of ours:
 *   1. LAN  - UDP broadcast discovery, offer/answer/ICE over the same socket,
 *             host candidates only, so a LAN chat touches nothing but the two
 *             machines and the local switch.
 *   2. Pair - copy/paste invite code with the SDP inside. STUN is used here,
 *             because without any relay two peers behind symmetric NAT cannot
 *             meet. There is no TURN, no broker, no account, no database.
 *
 * On top of DTLS every frame is sealed again with a key derived from ECDH
 * between the two identities, so whoever carries the signalling cannot read or
 * rewrite the traffic, and a MITM shows up as a fingerprint mismatch.
 */
import * as C from './crypto.js';

const CHUNK = 48 * 1024;
const CONNECT_TIMEOUT_MS = 12;
/**
 * The invite code is exchanged by a human: copied, pasted, sent over a chat app.
 * Twelve seconds is nothing next to that, and killing the attempt on a timer
 * used to throw away a perfectly good offer, so this path gets minutes and
 * never retries on its own - a new attempt means a new code on both sides.
 */
const INVITE_TIMEOUT_MS = 15 * 60 * 1000;
/** A peer sitting in «соединение…» this long never got its answer. */
const STUCK_MS = 6000;
const ICE_LAN = [];
const ICE_NET = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `a=candidate:...` lines, the raw material of an ICE candidate list. */
const candidateLines = (sdp) => String(sdp || '').match(/a=candidate:[^\r\n]+/g) || [];

/**
 * A candidate line as addIceCandidate wants it: no `a=` prefix, and no ufrag -
 * that extension names the transport which gathered the line, and a candidate
 * carrying a foreign ufrag is rejected outright.
 */
const candidateFor = (line) => line.replace(/^a=/, '').replace(/ ufrag \S+/, '');

/**
 * RTCSessionDescription keeps `type`/`sdp` in prototype getters, so structured
 * clone (IPC) and JSON.stringify both turn it into `{}`. Every SDP that leaves
 * this process has to become a plain object first.
 */
export function sdpInit(desc) {
  if (!desc) return null;
  if (typeof desc === 'string') return { type: 'offer', sdp: desc };
  return { type: desc.type, sdp: desc.sdp };
}

export function publicProfile(profile, identity) {
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color,
    emoji: profile.emoji,
    pubRaw: identity.pubRaw,
    dhRaw: identity.dhRaw,
    fingerprint: identity.fingerprint,
  };
}

export class Net {
  constructor() {
    this.peers = new Map();
    this.listeners = new Map();
    this.hooks = {};
    this.profile = null;
    this.identity = null;
    this.settings = { autoConnect: true, lanDiscovery: true, readReceipts: true, typing: true };
    this.pendingInvites = new Map();
    this.earlyCandidates = new Map();
    this.started = false;
  }

  /* -------------------------------------------------------------- events --- */
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event).delete(handler);
  }

  fire(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[net] ' + event, err);
      }
    }
  }

  /* --------------------------------------------------------------- start --- */
  async start(identity, profile, settings) {
    this.identity = identity;
    this.profile = profile;
    this.settings = { ...this.settings, ...settings };
    if (this.settings.lanDiscovery) {
      await window.mouth.net.start({
        id: profile.id,
        name: profile.name,
        color: profile.color,
        emoji: profile.emoji,
      });
      window.mouth.net.onSignal((msg) => this.onSignal(msg));
    }
    this.started = true;
  }

  async stop() {
    this.started = false;
    for (const peer of [...this.peers.values()]) peer.destroy();
    this.peers.clear();
    this.pendingInvites.clear();
    await window.mouth.net.stop();
  }

  setSettings(settings) {
    this.settings = { ...this.settings, ...settings };
  }

  async updateProfile(patch) {
    this.profile = { ...this.profile, ...patch };
    const payload = publicProfile(this.profile, this.identity);
    for (const peer of this.peers.values()) peer.sendPlain({ t: 'profile', profile: payload });
    this.fire('profile', this.profile);
  }

  /* --------------------------------------------------------------- peers --- */
  isConnected(id) {
    const peer = this.peers.get(id);
    return Boolean(peer && peer.ready && !peer.dead);
  }

  state(id) {
    const peer = this.peers.get(id);
    return peer ? peer.state : 'offline';
  }

  states() {
    const out = {};
    for (const [id, peer] of this.peers) out[id] = peer.state;
    return out;
  }

  /**
   * Start (or restart) a connection attempt.
   *
   * An attempt that has been «connecting» for a while is treated as lost: the
   * discovery hello repeats every few seconds and used to bring the same stuck
   * peer back, which made a lost offer look like a peer that simply never
   * answers. Re-offering is the only thing that can unstick it.
   */
  async dial(id, { lan = true, profile = null, force = false } = {}) {
    const existing = this.peers.get(id);
    if (existing && !force) {
      const lost =
        existing.dead ||
        existing.state === 'failed' ||
        existing.state === 'closed' ||
        (existing.state === 'connecting' && Date.now() - existing.stateAt > STUCK_MS);
      if (!lost) return existing;
    }
    if (existing) existing.destroy();
    const peer = new Peer(this, id, { initiator: true, lan, profile });
    this.peers.set(id, peer);
    try {
      await peer.start();
    } catch (err) {
      peer.destroy();
      this.peers.delete(id);
      this.fire('error', { id, error: err });
      return null;
    }
    return peer;
  }

  accept(id, { lan = true, profile = null } = {}) {
    const existing = this.peers.get(id);
    if (existing && !existing.dead) return existing;
    if (existing) existing.destroy();
    const peer = new Peer(this, id, { initiator: false, lan, profile });
    this.peers.set(id, peer);
    return peer;
  }

  hangup(id, { silent = false } = {}) {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (!silent) peer.sendPlain({ t: 'bye' });
    peer.destroy();
    this.peers.delete(id);
    this.fire('state', { id, state: 'offline' });
  }

  /* ----------------------------------------------------------- signalling --- */
  async onSignal(msg) {
    if (!msg || !msg.id || msg.id === this.profile?.id) return;

    if (msg.t === 'offer') {
      const known = this.hooks.isKnown ? this.hooks.isKnown(msg.id) : false;
      let allowed = known && this.settings.autoConnect;
      if (!allowed && this.hooks.onIncoming) {
        const answer = await this.hooks.onIncoming({ id: msg.id, profile: msg.profile, known });
        allowed = Boolean(answer && answer.accepted);
        if (allowed && answer.contact) allowed = this.rememberPeer(msg.id, msg.profile, answer.contact);
      }
      if (!allowed) {
        window.mouth.net.send(msg.id, { t: 'reject', id: this.profile.id, reason: 'declined' });
        this.fire('declined-out', { id: msg.id });
        return;
      }
      const peer = this.accept(msg.id, { lan: true, profile: msg.profile });
      await peer.handleOffer(msg.sdp, msg.token);
      this.flushEarlyCandidates(msg.id, peer);
      return;
    }

    if (msg.t === 'answer') {
      const peer = this.peers.get(msg.id);
      if (peer) {
        await peer.handleAnswer(msg.sdp, msg.token);
        this.flushEarlyCandidates(msg.id, peer);
      }
      return;
    }

    if (msg.t === 'ice') {
      const peer = this.peers.get(msg.id);
      if (peer) await peer.handleCandidate(msg.candidate);
      else this.stashCandidate(msg.id, msg.candidate);
      return;
    }

    if (msg.t === 'reject') {
      const peer = this.peers.get(msg.id);
      if (peer) {
        this.fire('rejected', { id: msg.id, reason: msg.reason });
        peer.destroy();
        this.peers.delete(msg.id);
        this.fire('state', { id: msg.id, state: 'offline' });
      }
    }
  }

  /**
   * ICE candidates start flowing the moment the local description is set, which
   * is before the offer has finished gathering and left the machine. A candidate
   * that arrives before we know about the peer used to be dropped on the floor,
   * and if that happened for every host candidate the connection could never be
   * established. Hold them until the peer object exists.
   */
  stashCandidate(id, candidate) {
    if (!candidate) return;
    const list = this.earlyCandidates.get(id) || [];
    if (list.length < 32) list.push(candidate);
    this.earlyCandidates.set(id, list);
  }

  flushEarlyCandidates(id, peer) {
    const list = this.earlyCandidates.get(id);
    if (!list || !list.length) return;
    this.earlyCandidates.delete(id);
    peer.serialize(async () => {
      for (const candidate of list) {
        try {
          await peer.pc.addIceCandidate(candidate);
        } catch {
          /* a duplicate or a candidate for a rolled back description */
        }
      }
    });
  }

  rememberPeer(id, profile, contact) {
    const known = this.peers.has(id);
    if (!known) {
      const peer = this.accept(id, { lan: true, profile });
      peer.remoteProfile = profile;
    }
    return Boolean(contact);
  }

  /**
   * A signal that cannot be routed is a dead end, not a hiccup: the peer looked
   * reachable in the UI a moment ago, so say so instead of hanging on
   * «соединение…» until the user gives up.
   */
  async signal(id, payload) {
    const ok = await window.mouth.net.send(id, payload);
    if (!ok) {
      console.error('[net] no route to ' + id + ' for ' + (payload && payload.t));
      this.fire('no-route', { id, t: payload && payload.t });
    }
    return ok;
  }

  /* -------------------------------------------------------------- invite --- */
  /**
   * Chromium never gives the answering side a server-reflexive candidate: that
   * gatherer finishes in ~100ms holding nothing but host addresses, so the
   * answer half of an invite code carries no address the initiator on another
   * network could dial - it just waits for a connection that cannot happen.
   * A throwaway *offerer* does reach STUN, so we borrow its reflexive lines and
   * ship them next to the SDP; the other side feeds them in with
   * addIceCandidate. Returns [] when the network gives no reflexive address at
   * all, which is survivable on one LAN and worth a warning anywhere else.
   */
  async discoverReflexive() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const pc = new RTCPeerConnection({ iceServers: ICE_NET, bundlePolicy: 'max-bundle' });
      try {
        // without a data channel the offer has no m-line, so no ICE transport
        // is created and gathering never starts at all
        pc.createDataChannel('probe');
        await pc.setLocalDescription(await pc.createOffer());
        for (let waited = 0; waited < 3000; waited += 150) {
          const found = candidateLines(pc.localDescription && pc.localDescription.sdp).filter((line) =>
            line.includes('typ srflx'),
          );
          if (found.length) return found.map(candidateFor);
          await sleep(150);
        }
        return []; // nobody answered in three seconds; the same probe would not answer now either
      } catch (err) {
        console.error('[net] reflexive probe failed', err);
      } finally {
        pc.close();
      }
    }
    return [];
  }

  async createInvite() {
    const peer = new Peer(this, 'invite:' + C.randomId(), { initiator: true, lan: false });
    peer.token = C.randomId('t');
    this.pendingInvites.set(peer.token, peer);
    const [sdp, extra] = await Promise.all([peer.createOffer(), this.discoverReflexive()]);
    peer.armWatchdog();
    const code = await C.packCode({
      v: 1,
      k: 'offer',
      t: peer.token,
      s: sdp,
      x: extra.length ? extra : undefined,
      p: publicProfile(this.profile, this.identity),
    });
    return { code, token: peer.token, id: this.profile.id };
  }

  async completeInvite(answerCode) {
    const data = await C.unpackCode(answerCode);
    if (data.k !== 'answer') throw new Error('Это не ответный код');
    const peer = this.pendingInvites.get(data.t);
    if (!peer) throw new Error('Приглашение устарело — создайте новое');
    peer.id = data.p.id;
    peer.remoteProfile = data.p;
    this.peers.set(data.p.id, peer);
    this.pendingInvites.delete(data.t);
    await peer.handleAnswer(data.s, data.t);
    await peer.feedExtra(data.x);
    return data.p.id;
  }

  async answerInvite(inviteCode) {
    const data = await C.unpackCode(inviteCode);
    if (data.k !== 'offer') throw new Error('Это не код приглашения');
    const peer = new Peer(this, data.p.id, { initiator: false, lan: false });
    peer.token = data.t;
    peer.remoteProfile = data.p;
    this.peers.set(data.p.id, peer);
    const [sdp, extra] = await Promise.all([peer.createAnswer(data.s, data.t), this.discoverReflexive()]);
    await peer.feedExtra(data.x);
    const code = await C.packCode({
      v: 1,
      k: 'answer',
      t: data.t,
      s: sdp,
      x: extra.length ? extra : undefined,
      p: publicProfile(this.profile, this.identity),
    });
    return { code, id: data.p.id, profile: data.p };
  }

  cancelInvite(token) {
    const peer = this.pendingInvites.get(token);
    if (peer) {
      peer.destroy();
      this.pendingInvites.delete(token);
    }
  }

  /* ------------------------------------------------------------ messages --- */
  async send(peerId, payload) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.ready) throw new Error('Нет соединения с контактом');
    return peer.send(payload);
  }

  sendTyping(peerId, value) {
    const peer = this.peers.get(peerId);
    if (peer && peer.ready && this.settings.typing) peer.send({ t: 'typing', on: Boolean(value) });
  }

  sendReceipt(peerId, ids, kind = 'read') {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.ready) return;
    if (kind === 'read' && !this.settings.readReceipts) return;
    peer.send({ t: 'receipt', ids, kind });
  }

  /* --------------------------------------------------------------- files --- */
  async sendFile(peerId, file, message) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.ready) throw new Error('Нет соединения с контактом');
    return peer.sendFile(file, message);
  }

  async cancelTransfer(peerId, transferId) {
    const peer = this.peers.get(peerId);
    if (peer) await peer.abortTransfer(transferId, 'cancelled');
  }

  /** Answer an incoming file offer. */
  answerFile(peerId, transferId, ok) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.ready) return;
    peer.send({ t: ok ? 'file-accept' : 'file-reject', transferId });
  }

  stats() {
    return [...this.peers].map(([id, peer]) => ({
      id,
      state: peer.state,
      lan: peer.lan,
      verified: peer.verified,
      sent: peer.bytes,
    }));
  }
}

/* ========================================================================== */
class Peer {
  constructor(net, id, { initiator, lan, profile }) {
    this.net = net;
    this.id = id;
    this.initiator = initiator;
    this.lan = lan !== false;
    this.remoteProfile = profile || null;
    this.pc = null;
    this.ctl = null;
    this.bulk = null;
    this.key = null;
    this.remoteIdentity = null;
    this.ready = false;
    this.verified = false;
    this.dead = false;
    this.state = 'new';
    this.stateAt = Date.now();
    this.token = null;
    this.bytes = 0;
    this.outgoing = new Map();
    this.incoming = new Map();
    this.queue = [];
    this.pendingCandidates = [];
    this.retry = 0;
    this.retryTimer = null;
    this.watchdog = null;
    this.answeredTokens = new Set();
    this.greeted = false;
    /* three nonces, never shared: the one I greeted with, the one the peer
       greeted with, and the one I answered with */
    this.helloNonce = '';
    this.peerNonce = '';
    this.myNonce = '';
    this.chain = Promise.resolve();
    this.inbox = Promise.resolve();
    /* symmetric tie-break: on a collision the smaller id yields */
    this.polite = String(this.net.profile?.id || '') < String(this.remoteId || id);
  }

  get remoteId() {
    return this.remoteProfile?.id || this.id;
  }

  setState(state) {
    this.state = state;
    this.stateAt = Date.now();
    this.net.fire('state', { id: this.remoteId, state });
  }

  /* -------------------------------------------------------------- set-up --- */
  build() {
    if (this.pc) return this.pc;
    this.pc = new RTCPeerConnection({
      iceServers: this.lan ? ICE_LAN : ICE_NET,
      bundlePolicy: 'max-bundle',
    });

    this.pc.onicecandidate = (event) => {
      if (!event.candidate || this.dead) return;
      const candidate = event.candidate.toJSON();
      if (this.lan) {
        this.net.signal(this.id, {
          t: 'ice',
          from: this.net.profile.id,
          to: this.id,
          candidate,
        });
      } else {
        this.pendingCandidates.push(candidate);
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.dead) return;
      const cs = this.pc.connectionState;
      if (cs === 'connected') {
        this.retry = 0;
      } else if (cs === 'failed') {
        this.setState('failed');
        this.scheduleRetry();
      } else if (cs === 'disconnected' || cs === 'connecting') {
        this.setState('connecting');
      } else if (cs === 'closed') {
        this.setState('offline');
      }
    };

    this.pc.ondatachannel = (event) => this.bindChannel(event.channel);

    if (this.initiator) {
      this.bindChannel(this.pc.createDataChannel('ctl', { ordered: true }));
      this.bindChannel(this.pc.createDataChannel('bulk', { ordered: true }));
    }
    return this.pc;
  }

  bindChannel(channel) {
    if (channel.label === 'bulk') this.bulk = channel;
    else this.ctl = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => this.onOpen();
    channel.onclose = () => this.onClose();
    channel.onerror = () => this.net.fire('error', { id: this.remoteId, error: new Error('Канал повреждён') });
    // frames must be handled strictly in order: an `end` that overtakes the last
    // chunk would close the file before its bytes hit the disk
    channel.onmessage = (event) => {
      this.inbox = this.inbox
        .then(() => this.onMessage(event.data))
        .catch((err) => {
          this.net.fire('error', { id: this.remoteId, error: err instanceof Error ? err : new Error(String(err)) });
        });
    };
  }

  onOpen() {
    if (this.dead || !this.ctl || this.ctl.readyState !== 'open') return;
    if (this.initiator && !this.greeted) {
      this.greeted = true;
      this.helloNonce = C.randomId('n');
      this.sendPlain({
        t: 'hello',
        ...publicProfile(this.net.profile, this.net.identity),
        nonce: this.helloNonce,
      });
    }
    // the responder stays silent until the initiator says hello
  }

  onClose() {
    if (this.dead) return;
    this.ready = false;
    this.setState('offline');
    this.net.fire('closed', { id: this.remoteId });
  }

  /* -------------------------------------------------------------- signals --- */
  async start() {
    this.build();
    this.token = C.randomId('t');
    this.setState('connecting');
    this.armWatchdog();
    await this.createOffer();
    return this;
  }

  async createOffer() {
    this.build();
    this.setState('connecting');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitIce();
    if (this.lan) {
      this.net.signal(this.id, {
        t: 'offer',
        from: this.net.profile.id,
        to: this.id,
        token: this.token,
        sdp: sdpInit(this.pc.localDescription),
        profile: publicProfile(this.net.profile, this.net.identity),
      });
    }
    return sdpInit(this.pc.localDescription);
  }

  async createAnswer(remote, token) {
    this.build();
    this.token = token || this.token;
    this.setState('connecting');
    this.armWatchdog();
    await this.pc.setRemoteDescription(remote);
    await this.drainCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitIce();
    if (this.lan) {
      this.net.signal(this.id, {
        t: 'answer',
        from: this.net.profile.id,
        to: this.id,
        token: this.token,
        sdp: sdpInit(this.pc.localDescription),
        profile: publicProfile(this.net.profile, this.net.identity),
      });
    }
    return sdpInit(this.pc.localDescription);
  }

  /**
   * Nothing has a timeout of its own here: a peer connection that never
   * completes ICE just sits at «соединение…» for ever, which is the single most
   * confusing thing this app can do. Give every attempt a deadline, and when it
   * expires say why - the ICE report is what tells us whether the packets never
   * arrived or arrived somewhere useless.
   */
  armWatchdog(seconds = this.lan ? CONNECT_TIMEOUT_MS : INVITE_TIMEOUT_MS) {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => this.onConnectTimeout(), seconds * 1000);
  }

  clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /** A short, human-readable summary of what ICE actually managed to do. */
  async iceReport() {
    const out = {
      connection: this.pc ? this.pc.connectionState : 'none',
      iceConnection: this.pc ? this.pc.iceConnectionState : 'none',
      iceGathering: this.pc ? this.pc.iceGatheringState : 'none',
      signalling: this.pc ? this.pc.signalingState : 'none',
      pairs: [],
    };
    if (!this.pc || !this.pc.getStats) return out;
    try {
      const stats = await this.pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
          out.pairs.push({ state: report.state, nominated: Boolean(report.nominated) });
        }
        if (report.type === 'local-candidate') out.local = (out.local || 0) + 1;
        if (report.type === 'remote-candidate') out.remote = (out.remote || 0) + 1;
      });
    } catch {
      /* stats are best effort */
    }
    if (this.dead) return out;
    return out;
  }

  async onConnectTimeout() {
    if (this.dead || this.ready) return;
    const report = await this.iceReport();
    console.error(
      '[net] ' + this.remoteId + ' did not connect in time: ' + JSON.stringify(report) +
        ' initiator=' + this.initiator + ' lan=' + this.lan
    );
    this.setState('failed');
    this.net.fire('timeout', { id: this.remoteId, report, initiator: this.initiator, invite: !this.lan });
    if (!this.lan) {
      /* Nobody can retry this one for the user: a fresh attempt means a fresh
         code, and the two sides must both make one. Just stop burning CPU. */
      this.hang();
      return;
    }
    // one more try, then give up for good so the UI can tell the user
    if (this.retry < 2) {
      this.retry += 1;
      const again = async () => {
        if (this.dead || this.net.isConnected(this.id)) return;
        try {
          if (this.pc) this.pc.close();
          this.pc = null;
          this.ctl = null;
          this.bulk = null;
          this.greeted = false;
          this.token = C.randomId('t');
          this.setState('connecting');
          this.armWatchdog();
          if (this.initiator) await this.createOffer();
          else this.net.dial(this.id, { lan: this.lan, profile: this.remoteProfile });
        } catch (err) {
          console.error('[net] retry failed for ' + this.remoteId, err);
        }
      };
      setTimeout(again, 800);
    } else {
      this.hang();
    }
  }

  /**
   * Signalling must never interleave: an answer that lands while we are still
   * building our own offer would throw the peer connection into a state where
   * nothing can be negotiated. Every inbound message goes through this chain.
   */
  serialize(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /**
   * Perfect negotiation, lite. Both sides can decide to dial at the same
   * moment, so the peer with the lexicographically smaller id yields: it rolls
   * back its own offer and answers the incoming one.
   */
  async handleOffer(sdp, token) {
    return this.serialize(async () => {
      this.build();
      if (this.dead) return;
      // the same offer reaches us once per route the sender knows about; the
      // first copy wins and the rest are dropped
      if (token) {
        if (this.answeredTokens.has(token)) return;
        this.answeredTokens.add(token);
        if (this.answeredTokens.size > 16) {
          this.answeredTokens = new Set([...this.answeredTokens].slice(-8));
        }
      }
      if (this.pc.signalingState === 'have-local-offer') {
        if (!this.polite) {
          this.net.fire('glare', { id: this.id });
          return; // we keep our offer, the other side will answer it
        }
        try {
          await this.pc.setLocalDescription({ type: 'rollback' });
        } catch {
          /* older Chromium may refuse the rollback; the answer below still works */
        }
      }
      if (this.pc.signalingState !== 'stable') return;
      this.token = token;
      await this.createAnswer(sdp, token);
    });
  }

  async handleAnswer(sdp, token) {
    return this.serialize(async () => {
      if (!this.pc || this.dead) return;
      if (token && this.token && token !== this.token) return;
      // an answer is only ever valid for an offer we are still waiting on
      if (this.pc.signalingState !== 'have-local-offer') return;
      await this.pc.setRemoteDescription(sdp);
      await this.drainCandidates();
      this.setState('connecting');
    });
  }

  async handleCandidate(candidate) {
    return this.serialize(async () => {
      if (!this.pc) return;
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        /* arrived before the description, or after the peer died */
      }
    });
  }

  /**
   * Reflexive lines carried by the code next to the SDP, see
   * Net.discoverReflexive. The bundle is a single data channel, so m-line 0 is
   * the only place they can belong.
   */
  async feedExtra(list) {
    if (!Array.isArray(list) || !list.length) return;
    return this.serialize(async () => {
      if (!this.pc || this.dead) return;
      let taken = 0;
      for (const candidate of list.slice(0, 8)) {
        try {
          await this.pc.addIceCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0 });
          taken += 1;
        } catch {
          /* malformed or already known; the rest of the list is still worth trying */
        }
      }
      console.error('[ice] fed ' + taken + '/' + Math.min(list.length, 8) + ' extra candidates to ' + this.id);
    });
  }

  async drainCandidates() {
    const list = this.pendingCandidates.splice(0);
    for (const candidate of list) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Gather ICE so the candidates end up inside the invite code.
   *
   * Over the internet the private host candidates are of no use to the other
   * side, so what the code really has to carry is the STUN (srflx) candidate -
   * that is why the code path waits longer than the LAN one: a code handed over
   * before STUN answered is a code with no reachable address in it, and the
   * only way to fix that afterwards is to exchange both codes again.
   */
  waitIce(timeout = this.lan ? 1500 : 3000) {
    if (!this.pc) return Promise.resolve();
    const started = Date.now();
    const at = () => (this.pc.localDescription?.sdp.match(/a=candidate:[^\r\n]+/g) || []).length;
    const srflx = () => (this.pc.localDescription?.sdp.match(/typ srflx/g) || []).length;
    if (this.pc.iceGatheringState === 'complete') {
      console.error('[ice] already complete, ' + at() + ' candidates, srflx=' + srflx());
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (why) => {
        clearTimeout(timer);
        clearInterval(poll);
        this.pc.removeEventListener('icegatheringstatechange', check);
        console.error(
          '[ice] ' + why + ' after ' + (Date.now() - started) + 'ms state=' + this.pc.iceGatheringState +
            ' candidates=' + at() + ' srflx=' + srflx()
        );
        resolve();
      };
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') done('complete');
      };
      const timer = setTimeout(() => done('timeout'), timeout);
      /* the state change event is not the only signal, and on some builds it
         simply never arrives - polling is what makes the code trustworthy */
      const poll = setInterval(check, 200);
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }
  scheduleRetry() {
    if (this.dead || !this.net.settings.autoConnect || !this.lan) return;
    if (this.retryTimer) return;
    this.retry = Math.min(this.retry + 1, 5);
    const wait = Math.min(1000 * 2 ** (this.retry - 1), 30000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.dead || this.net.isConnected(this.id)) return;
      this.net.fire('reconnecting', { id: this.remoteId, attempt: this.retry });
      this.net.dial(this.id, { lan: true, profile: this.remoteProfile });
    }, wait);
  }

  /* ------------------------------------------------------------ handshake --- */
  /**
   * Both advertised keys must be usable and the advertised fingerprint must
   * really be the hash of them. Returns the peer's ECDSA verify key and ECDH
   * key, or null when the peer is lying or broken.
   */
  async verifyPeer(hello) {
    let publicKey;
    let dhKey;
    try {
      publicKey = await C.importPublic(hello.pubRaw);
      dhKey = await C.importDhPublic(hello.dhRaw);
    } catch {
      this.hang();
      return null;
    }
    const actual = await C.fingerprintOf(C.unb64u(hello.pubRaw), C.unb64u(hello.dhRaw));
    if (actual !== hello.fingerprint) {
      console.error(
        '[net] fingerprint mismatch for ' + hello.id + ': advertised ' + hello.fingerprint + ', computed ' + actual
      );
      this.net.fire('tamper', { id: hello.id, reason: 'Отпечаток не соответствует ключам' });
      this.hang();
      return null;
    }
    return { publicKey, dhKey };
  }

  /**
   * Responder side. Verifies that the advertised fingerprint really is the hash
   * of the advertised keys, then answers with its own signed nonce.
   */
  async acceptHello(hello) {
    const net = this.net;
    const keys = await this.verifyPeer(hello);
    if (!keys) return;
    this.remoteProfile = hello;
    this.remoteIdentity = { pubRaw: hello.pubRaw, dhRaw: hello.dhRaw, fingerprint: hello.fingerprint, publicKey: keys.publicKey };
    this.key = await C.deriveSessionKey(net.identity, keys.dhKey, hello.dhRaw);
    this.peerNonce = hello.nonce || '';
    this.myNonce = C.randomId('n');
    this.sendPlain({
      t: 'hello-ack',
      ...publicProfile(net.profile, net.identity),
      nonce: this.myNonce,
      sig: await C.sign(
        net.identity.privateKey,
        C.handshakePayload(net.identity.fingerprint, hello.fingerprint, this.peerNonce)
      ),
    });
  }

  /** Initiator side: the ack proves the responder owns its private key. */
  async acceptAck(ack) {
    const keys = await this.verifyPeer(ack);
    if (!keys) return;
    const payload = C.handshakePayload(ack.fingerprint, this.net.identity.fingerprint, this.helloNonce || '');
    const ok = await C.verify(keys.publicKey, ack.sig, payload);
    if (!ok) {
      console.error(
        '[net] ack signature invalid for ' + ack.id + ': peer claims ' + ack.fingerprint +
          ', we are ' + this.net.identity.fingerprint + ', nonce ' + JSON.stringify(this.helloNonce) +
          ', sig ' + String(ack.sig).slice(0, 16) + ', payload ' + payload
      );
      this.net.fire('tamper', { id: ack.id, reason: 'Подпись недействительна' });
      this.hang();
      return;
    }
    this.remoteProfile = ack;
    this.remoteIdentity = { pubRaw: ack.pubRaw, dhRaw: ack.dhRaw, fingerprint: ack.fingerprint, publicKey: keys.publicKey };
    if (!this.key) this.key = await C.deriveSessionKey(this.net.identity, keys.dhKey, ack.dhRaw);
    // and now prove ourselves back
    this.sendPlain({
      t: 'hello-proof',
      sig: await C.sign(
        this.net.identity.privateKey,
        C.handshakePayload(this.net.identity.fingerprint, ack.fingerprint, ack.nonce || '')
      ),
    });
    await this.markOnline();
  }

  /** Responder side: closes the mutual authentication loop. */
  async acceptProof(proof) {
    if (!this.key || !this.remoteIdentity) return;
    const ok = await C.verify(
      this.remoteIdentity.publicKey,
      proof.sig,
      C.handshakePayload(
        this.remoteIdentity.fingerprint,
        this.net.identity.fingerprint,
        this.myNonce || ''
      )
    );
    if (!ok) {
      this.net.fire('tamper', { id: this.remoteId, reason: 'Подпись недействительна' });
      this.hang();
      return;
    }
    await this.markOnline();
  }

  async markOnline() {
    this.verified = true;
    this.ready = true;
    this.clearWatchdog();
    this.setState('online');
    this.net.fire('verified', {
      id: this.remoteId,
      profile: this.remoteProfile,
      lan: this.lan,
      safety: await C.safetyNumber(this.net.identity, {
        fingerprint: this.remoteProfile.fingerprint,
      }),
    });
    // the picture is far too big for a UDP packet, so it goes over the
    // encrypted channel once the session key exists
    if (this.net.profile?.avatar) await this.send({ t: 'avatar', data: this.net.profile.avatar });
    await this.flushQueue();
  }

  /* ------------------------------------------------------------ messaging --- */
  sendPlain(obj) {
    if (!this.ctl || this.ctl.readyState !== 'open') return false;
    try {
      this.ctl.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  async send(payload) {
    if (!this.ctl || this.ctl.readyState !== 'open' || !this.key) {
      this.queue.push(payload);
      return false;
    }
    this.ctl.send(JSON.stringify({ e: await C.seal(this.key, payload) }));
    return true;
  }

  async flushQueue() {
    const pending = this.queue.splice(0);
    for (const payload of pending) await this.send(payload);
  }

  async onMessage(data) {
    if (typeof data !== 'string') {
      await this.onBinary(data);
      return;
    }
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }

    switch (obj.t) {
      case 'hello': {
        this.remoteProfile = obj;
        /* The peer's nonce goes to peerNonce, and helloNonce must stay the one
           we sent: acceptAck checks the ack signature against the nonce the
           peer answered, which is ours. Discovery is symmetric, so both sides
           can end up initiators and greet each other; sharing one field for
           both nonces then checks the signature against the wrong string and
           every such connection dies with «Подпись недействительна». */
        await this.acceptHello(obj);
        return;
      }
      case 'hello-ack':
        await this.acceptAck(obj);
        return;
      case 'hello-proof':
        await this.acceptProof(obj);
        return;
      case 'profile':
        this.remoteProfile = { ...this.remoteProfile, ...obj.profile };
        this.net.fire('peer-profile', { id: this.remoteId, profile: this.remoteProfile });
        return;
      case 'bye':
        this.net.fire('left', { id: this.remoteId });
        this.hang();
        return;
      case 'ping':
        this.sendPlain({ t: 'pong' });
        return;
      case 'pong':
        return;
      default:
        break;
    }

    if (obj.e) {
      if (!this.key) return;
      try {
        this.handle(await C.unseal(this.key, obj.e));
      } catch {
        this.net.fire('error', { id: this.remoteId, error: new Error('Не удалось расшифровать') });
      }
    }
  }

  handle(payload) {
    switch (payload.t) {
      case 'msg':
        this.net.fire('message', { id: this.remoteId, message: payload.m, lan: this.lan });
        break;
      case 'typing':
        this.net.fire('typing', { id: this.remoteId, on: Boolean(payload.on) });
        break;
      case 'receipt':
        this.net.fire('receipt', { id: this.remoteId, ids: payload.ids, kind: payload.kind });
        break;
      case 'file-begin':
        this.registerIncoming(payload);
        this.net.fire('file-begin', {
          id: this.remoteId,
          transferId: payload.id,
          name: payload.name,
          size: payload.size,
          messageId: payload.messageId,
        });
        break;
      case 'file-accept':
        this.outgoing.get(payload.transferId)?.decide?.(true);
        break;
      case 'file-reject':
        this.outgoing.get(payload.transferId)?.decide?.(false);
        break;
      case 'file-ack':
        /* The receiver says the file is on its disk, or that it never made it.
           Without this the sender only knows the bytes left the machine, which
           is not the same as the other end having them. */
        this.outgoing.get(payload.transferId)?.acknowledge?.(payload);
        break;
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- files --- */
  /** [4-byte header length][JSON header][ciphertext] - the header stays plain
   *  so the receiver can route before it has a key, the body never is. */
  frame(kind, extra, payload) {
    const header = new TextEncoder().encode(JSON.stringify({ k: kind, ...extra }));
    const size = payload ? payload.byteLength : 0;
    const buffer = new Uint8Array(4 + header.length + size);
    new DataView(buffer.buffer).setUint32(0, header.length, false);
    buffer.set(header, 4);
    if (size) buffer.set(new Uint8Array(payload), 4 + header.length);
    return buffer;
  }

  async sendRaw(bytes) {
    if (!this.bulk || this.bulk.readyState !== 'open') throw new Error('Канал файлов закрыт');
    let guard = 0;
    while (this.bulk.bufferedAmount > 2 * 1024 * 1024) {
      await new Promise((r) => setTimeout(r, 30));
      if (guard++ > 600) throw new Error('Отправка зависла');
    }
    this.bulk.send(bytes);
  }

  /**
   * Streams a file from disk to the peer in encrypted chunks.
   * The chat message goes first so the bubble can show progress live, then the
   * peer is asked for permission and only then does a single byte move.
   */
  async sendFile(file, message) {
    const transferId = message.id;
    let decide;
    const decision = new Promise((resolve) => (decide = resolve));
    let acknowledge = () => {};
    const job = {
      transferId,
      messageId: message.id,
      cancelled: false,
      decide,
      decision,
      sent: 0,
      /* The last frame only says the bytes are gone. The receiver has to say
         the file is on its disk before the sender may claim it was delivered,
         and before the sender goes quiet the other end is still reading. */
      acknowledge: (payload) => {
        if (job.ackTimer) clearTimeout(job.ackTimer);
        this.outgoing.delete(transferId);
        if (payload && payload.ok === false) {
          this.net.fire('file-failed', {
            id: this.remoteId,
            transferId,
            messageId: message.id,
            error: payload.reason || 'Собеседник не смог сохранить файл',
          });
        } else {
          this.net.fire('file-delivered', {
            id: this.remoteId,
            transferId,
            messageId: message.id,
            name: file.name,
            size: payload && payload.size ? payload.size : file.size,
          });
        }
        acknowledge(payload);
      },
    };
    this.outgoing.set(transferId, job);

    const meta = {
      ...message,
      state: 'sending',
      file: { ...message.file, size: file.size, name: file.name, path: '' },
    };
    await this.send({ t: 'msg', m: meta });
    await this.send({
      t: 'file-begin',
      id: transferId,
      name: file.name,
      size: file.size,
      mime: file.mime || '',
      messageId: message.id,
    });

    try {
      const verdict = await Promise.race([decision, sleep(120000).then(() => 'timeout')]);
      if (verdict !== true) {
        throw new Error(verdict === 'timeout' ? 'Собеседник не ответил' : 'Файл отклонён');
      }
      /* step on by what was actually read, never by the chunk size: one short
         read then skips bytes and the file arrives quietly corrupt */
      let offset = 0;
      let index = 0;
      while (offset < file.size || (file.size === 0 && index === 0)) {
        if (job.cancelled) throw new Error('Отменено');
        const raw = await file.read(offset, CHUNK);
        if (!raw.byteLength && index > 0) break;
        const body = this.key ? await C.encryptBytes(this.key, raw) : { iv: '', ct: C.b64u(raw) };
        const payload = C.unb64u(body.ct);
        await this.sendRaw(this.frame('chunk', { id: transferId, i: index, iv: body.iv, n: raw.byteLength }, payload));
        job.sent += raw.byteLength;
        this.bytes += payload.byteLength;
        this.net.fire('file-progress', {
          id: this.remoteId,
          transferId,
          sent: job.sent,
          total: file.size,
          messageId: message.id,
        });
        offset += raw.byteLength;
        index += 1;
        if (!raw.byteLength) break;
      }
      await this.sendRaw(this.frame('end', { id: transferId, messageId: message.id }));
      this.net.fire('file-sent', { id: this.remoteId, transferId, messageId: message.id, name: file.name });
      job.ackTimer = setTimeout(() => this.outgoing.delete(transferId), 120000);
    } catch (err) {
      await this.abortTransfer(transferId, err.message);
      this.net.fire('file-failed', { id: this.remoteId, transferId, messageId: message.id, error: err.message });
    } finally {
      if (!job.ackTimer) this.outgoing.delete(transferId);
    }
  }

  async abortTransfer(transferId, reason) {
    const job = this.outgoing.get(transferId);
    if (job) job.cancelled = true;
    try {
      await this.sendRaw(this.frame('abort', { id: transferId, reason }));
    } catch {
      /* channel gone */
    }
  }

  registerIncoming(header) {
    this.incoming.set(header.id, {
      name: header.name,
      size: header.size,
      messageId: header.messageId,
      received: 0,
    });
  }

  async onBinary(arrayBuffer) {
    if (arrayBuffer.byteLength < 4) return;
    const headerLen = new DataView(arrayBuffer).getUint32(0, false);
    if (headerLen <= 0 || 4 + headerLen > arrayBuffer.byteLength) return;
    let header;
    try {
      header = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 4, headerLen)));
    } catch {
      return;
    }
    const body = new Uint8Array(arrayBuffer, 4 + headerLen);

    if (header.k === 'chunk') {
      const job = this.incoming.get(header.id);
      if (!job || !body.byteLength) return;
      let bytes = body;
      if (this.key && header.iv) {
        try {
          bytes = await C.decryptBytesRaw(this.key, header.iv, body);
        } catch {
          this.net.fire('error', { id: this.remoteId, error: new Error('Искажённый фрагмент файла') });
          return;
        }
      }
      if (typeof header.n === 'number' && bytes.byteLength !== header.n) {
        this.net.fire('error', { id: this.remoteId, error: new Error('Неверная длина фрагмента') });
        return;
      }
      this.bytes += body.byteLength;
      await window.mouth.files.chunk(header.id, header.i, bytes);
      job.received += bytes.byteLength;
      this.net.fire('file-progress', {
        id: this.remoteId,
        transferId: header.id,
        received: job.received,
        total: job.size,
        messageId: job.messageId,
      });
      if (job.size > 0 && job.received >= job.size) await this.completeIncoming(header.id);
      return;
    }

    if (header.k === 'end') {
      await this.completeIncoming(header.id);
      return;
    }

    if (header.k === 'abort') {
      const job = this.incoming.get(header.id);
      if (job) {
        await window.mouth.files.cancel(header.id);
        this.incoming.delete(header.id);
        this.net.fire('file-abort', {
          id: this.remoteId,
          transferId: header.id,
          messageId: job.messageId,
          reason: header.reason,
        });
      }
    }
  }

  async completeIncoming(transferId) {
    const job = this.incoming.get(transferId);
    if (!job) return;
    this.incoming.delete(transferId);
    let path;
    try {
      path = await window.mouth.files.finish(transferId, job.name, job.size);
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      await window.mouth.files.cancel(transferId);
      this.net.fire('file-abort', {
        id: this.remoteId,
        transferId,
        messageId: job.messageId,
        reason,
      });
      await this.ackTransfer(transferId, false, reason);
      return;
    }
    this.net.fire('file-done', {
      id: this.remoteId,
      transferId,
      messageId: job.messageId,
      path,
      name: job.name,
      size: job.size,
    });
    await this.ackTransfer(transferId, true, '', job.size);
  }

  /** Tell the sender the truth about the file. A silent failure on this side is
   *  indistinguishable from success over there, which is how a truncated
   *  download used to look like a delivered one. */
  async ackTransfer(transferId, ok, reason, size) {
    try {
      await this.send({ t: 'file-ack', transferId, ok, reason: reason || '', size: size || 0 });
    } catch {
      /* the channel went away: the sender will notice on its own */
    }
  }

  hang() {
    this.dead = true;
    this.ready = false;
    this.clearWatchdog();
    try {
      this.pc && this.pc.close();
    } catch {
      /* already closed */
    }
    this.setState('offline');
  }

  destroy() {
    this.dead = true;
    this.ready = false;
    this.clearWatchdog();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const job of this.outgoing.values()) job.cancelled = true;
    try {
      this.pc && this.pc.close();
    } catch {
      /* already closed */
    }
  }
}
