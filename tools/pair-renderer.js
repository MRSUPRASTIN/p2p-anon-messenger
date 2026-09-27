/**
 * Renderer half of the two-instance pair test: real discovery, real handshake,
 * real message, real encrypted file. Writes pair-report.json for the parent.
 */
(async () => {
  const report = { ok: false, name: '', steps: [], errors: [], file: {} };
  let persist = () => {};
  const audit = [];
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      audit.push('click ' + (t.id || t.className || t.tagName));
      if (audit.length > 30) audit.shift();
    },
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      audit.push('key ' + e.key + ' ctrl=' + e.ctrlKey);
      if (audit.length > 30) audit.shift();
    },
    true
  );
  const note = (step, extra) => {
    report.steps.push(extra ? step + ': ' + extra : step);
    void persist();
  };
  const M = window.mouth;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /* the parent watches this file, so every step is visible even if we hang */
  persist = () => M.store.set('pair-report.json', { ...report, partial: true }).catch(() => {});
  const until = async (fn, ms, label) => {
    const end = Date.now() + ms;
    for (;;) {
      let value = null;
      try {
        value = await fn();
      } catch (err) {
        value = null;
      }
      if (value) return value;
      if (Date.now() > end) throw new Error('timeout: ' + label);
      await wait(200);
    }
  };
  const btnByText = (label, root = document) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label) || null;
  const sha16 = async (bytes) => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  };

  let done = null;
  const netlog = [];
  try {
    const appEl = document.getElementById('app');
    await until(() => appEl && !appEl.hidden, 25000, 'app visible');
    note('booted');

    const S = await import(new URL('../js/state.js', location.href).href);
    const C = await import(new URL('../js/crypto.js', location.href).href);
    const chat = await import(new URL('../js/ui/chat.js', location.href).href);
    const { net } = await import(new URL('../js/app.js', location.href).href);

    for (const event of ['state', 'error', 'closed', 'reconnecting', 'tamper', 'declined-out', 'rejected']) {
      net.on(event, (payload) => {
        netlog.push(event + ' ' + (payload?.state || payload?.reason || payload?.error?.message || payload?.id || ''));
        if (netlog.length > 60) netlog.shift();
      });
    }
    report.netlog = netlog;
    report.pairFlag = Boolean(S.state.info?.pair);
    report.udpPort = S.state.info?.udpPort || null;
    report.discovered = [...S.state.discovered.values()].map((p) => p.name + '@' + p.addr);

    const me = S.state.profile;
    report.name = me.name;
    report.ownFingerprint = me.identity.fingerprint;
    report.ownId = me.id;

    /* --- who calls whom ------------------------------------------------- */
    /* Only the counterpart counts. A real messenger of the user may well be
       running on this very network and would answer the same broadcast, and
       pairing with it proves nothing about this build. */
    const wanted = report.name === 'Alpha' ? 'Bravo' : 'Alpha';
    report.ignoredPeers = [];
    let peerId;
    if (report.name === 'Alpha') {
      const found = await until(
        () => {
          const list = [...S.state.discovered.values()].filter((p) => p.id && p.id !== me.id);
          for (const p of list) {
            if (p.name !== wanted) report.ignoredPeers.push(p.name);
          }
          return list.find((p) => p.name === wanted);
        },
        40000,
        'UDP discovery of ' + wanted
      );
      report.ignoredPeers = [...new Set(report.ignoredPeers)];
      note('discovered', found.name + ' @ ' + found.addr);
      S.upsertContact({ id: found.id, name: found.name, color: found.color, emoji: found.emoji, lan: true });
      peerId = found.id;
      await net.dial(found.id, { lan: true, profile: null });
      note('dialed', peerId.slice(0, 10));
    } else {
      const guest = await until(() => S.contactList().find((c) => c.name === wanted), 40000, 'incoming contact');
      peerId = guest.id;
      note('incoming', guest.name + ' ' + peerId.slice(0, 10));
    }
    report.peerId = peerId;

    /* --- mutual authentication ----------------------------------------- */
    await until(() => net.peers.get(peerId)?.ready, 40000, 'data channel open');
    note('channelOpen');
    await until(() => net.peers.get(peerId)?.verified, 25000, 'handshake verified');
    note('verified');
    {
      const pc = net.peers.get(peerId).pc;
      const stats = await pc.getStats();
      const pairs = [];
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && (s.nominated || s.selected)) {
          pairs.push(s.state + ' ' + s.bytesSent + '/' + s.bytesReceived);
        }
      });
      report.ice = { conn: pc.connectionState, ice: pc.iceConnectionState, gather: pc.iceGatheringState, pairs };
    }
    report.peerName = S.contact(peerId)?.name || null;
    report.peerFingerprint = S.contact(peerId)?.fingerprint || '';
    report.safety = await C.safetyNumber(me.identity, { fingerprint: report.peerFingerprint });

    /* --- the nonce invariant, checked without any network ---------------- */
    /* Discovery is symmetric, so a peer that reconnects can be an initiator on
       both sides and each greets the other. The ack signature is checked
       against the nonce WE greeted with; if the incoming hello is allowed to
       overwrite it, the check runs against the peer's string and every such
       connection dies with «Подпись недействительна». Driven through the real
       message path on a detached copy, so the outcome cannot depend on which
       packet happens to arrive first. */
    report.tamper = [];
    net.on('tamper', ({ reason }) => report.tamper.push(reason));
    {
      const net2 = await import(new URL('../js/net.js', location.href).href);
      const proto = Object.getPrototypeOf(net.peers.get(peerId));
      /* the restored identity, with live CryptoKeys - the profile on disk holds
         only the exported jwk */
      const id = net.identity;
      const mine2 = net2.publicProfile(me, id);
      const events = [];
      const MINE = 'n-mine-0123456789';
      const probe = {
        net: { identity: id, profile: me, fire: (kind) => events.push(kind) },
        helloNonce: MINE,
        peerNonce: '',
        myNonce: '',
        key: null,
        dead: false,
        remoteProfile: null,
        sendPlain: () => true,
        hang() {
          this.hung = true;
        },
        markOnline() {},
        serialize: (fn) => Promise.resolve().then(fn),
      };
      probe.onMessage = proto.onMessage;
      probe.verifyPeer = proto.verifyPeer;
      probe.acceptHello = proto.acceptHello;
      probe.acceptAck = proto.acceptAck;

      /* a hello from the peer lands while our own ack is still expected */
      await probe.onMessage(JSON.stringify({ t: 'hello', ...mine2, nonce: 'n-peer-98765' }));
      report.nonceKeptAfterHello = probe.helloNonce === MINE;
      /* and now the ack the peer sends in answer to our own greeting */
      await probe.acceptAck({
        t: 'hello-ack',
        ...mine2,
        nonce: 'n-ack-55555',
        sig: await C.sign(id.privateKey, C.handshakePayload(id.fingerprint, id.fingerprint, MINE)),
      });
      report.nonceCheck = {
        kept: probe.helloNonce === MINE,
        hung: Boolean(probe.hung),
        events,
      };
      note('nonceCheck', report.nonceCheck.kept && !probe.hung ? 'ok' : 'BROKEN');
    }

    /* --- one text message, both directions ------------------------------ */
    await chat.open(peerId);
    note('chatOpen', 'bubbles=' + document.querySelectorAll('.bubble').length);

    if (report.name === 'Alpha') {
      const sent = await chat.sendText('Привет из Alpha 🦊');
      report.sentState = sent ? sent.state : null;
      note('sentText', report.sentState);
      report.gotText = await until(
        () => S.messages(peerId).find((m) => m.dir === 'in' && m.text)?.text || null,
        30000,
        'reply from Bravo'
      );
    } else {
      report.gotText = await until(
        () => S.messages(peerId).find((m) => m.dir === 'in' && m.text)?.text || null,
        30000,
        'text from Alpha'
      );
      const reply = await chat.sendText('Привет из Alpha 🦊'.replace('Alpha', 'Bravo'));
      note('replied', reply ? reply.state : 'null');
      report.sentState = reply ? reply.state : null;
    }
    report.bubbles = document.querySelectorAll('.bubble').length;

    /* --- an encrypted file, 70 KB, through the real composer path -------- */
    const payload = new Uint8Array(70000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 255;
    report.file = { size: payload.length, sha: await sha16(payload) };

    if (report.name === 'Bravo') {
      const blob = new Blob([payload], { type: 'application/octet-stream' });
      const message = await chat.sendAttachment({
        name: 'payload.bin',
        size: payload.length,
        blob,
        mime: 'application/octet-stream',
      });
      note('fileSent', message && message.state);
      report.file.transferId = message && message.file && message.file.id;
      /* The script ends the app when it returns, so the sender has to wait for
         the receiver to confirm the file is on its disk. Otherwise the process
         exits mid transfer and the other side sees a dead connection. */
      const delivered = new Promise((resolve) => {
        const off = net.on('file-delivered', (event) => {
          off();
          resolve(event);
        });
      });
      await until(
        () => {
          const m = S.findMessage(peerId, message.id);
          if (m && (m.state === 'sent' || m.state === 'failed')) return m.state;
          const job = chat.transfers.get(message.id);
          return job && job.sent === payload.length ? 'progress-complete' : null;
        },
        45000,
        'file marked sent'
      );
      const ack = await Promise.race([delivered, wait(60000).then(() => null)]);
      if (!ack) throw new Error('timeout: file never confirmed by the receiver');
      report.file.ackSize = ack.size;
      report.file.ackOk = ack.size === payload.length;
      note('fileDelivered', report.file.ackOk ? 'confirmed' : 'SIZE MISMATCH');
      note('chunksDelivered', S.findMessage(peerId, message.id)?.state || '');
    } else {
      done = new Promise((resolve) => {
        const off = net.on('file-done', (event) => {
          off();
          resolve(event);
        });
      });
      const offer = await until(
        () => {
          const button = btnByText('Принять');
          if (!button) return null;
          button.click();
          return 'offered';
        },
        45000,
        'incoming file offer'
      );
      note('offerAccepted', offer);
      const event = await Promise.race([done, wait(60000).then(() => null)]);
      if (!event) throw new Error('timeout: file never completed');
      const got = new Uint8Array(await M.files.read(event.path, 0, event.size));
      report.file.gotSize = got.length;
      report.file.gotSha = await sha16(got);
      report.file.bytesOk = report.file.gotSha === report.file.sha && got.length === payload.length;
      note('fileReceived', report.file.bytesOk ? 'identical' : 'MISMATCH');
      report.file.path = event.path;
    }

    report.ok = report.errors.length === 0;
    if (report.name === 'Alpha' && !report.file.bytesOk) report.ok = false;
    if (report.name === 'Bravo' && !report.file.transferId) report.ok = false;
    if (!report.safety || report.safety.length !== 6) report.ok = false;
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
    report.ok = false;
  }

  try {
    /* keep whatever the transport said, even on failure */
    const { net } = await import(new URL('../js/app.js', location.href).href);
    const peer = net.peers.values().next().value;
    if (peer?.pc) {
      report.ice = {
        conn: peer.pc.connectionState,
        ice: peer.pc.iceConnectionState,
        gather: peer.pc.iceGatheringState,
        signaling: peer.pc.signalingState,
        local: (peer.pc.localDescription?.sdp.match(/a=candidate:[^\r\n]+/g) || []).slice(0, 6),
      };
    }
    const modal = document.querySelector('.modal, .overlay, .sheet');
    if (modal) report.blockedBy = modal.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
    report.audit = audit;
    report.peerLan = net.peers.values().next().value?.lan ?? null;
  } catch {
    /* renderer is going down anyway */
  }

  await M.store.set('pair-report.json', report);
  return JSON.stringify(report);
})();
