/**
 * Renderer half of the invite-code test: no UDP discovery at all, the two sides
 * are handed to each other only by the codes a human would copy. LAN discovery
 * is switched off in settings.json, so anything that connects here connected
 * because of the code.
 *
 * The codes travel through files in the instance's own data folder: the parent
 * test copies them in, the renderer writes its own out through the store. That
 * stands in for the two humans and their messengers, without a server.
 */
(async () => {
  const report = { ok: false, name: '', steps: [], errors: [] };
  const M = window.mouth;
  const netlog = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let persist = () => {};
  const note = (step) => {
    report.steps.push(step);
    void persist();
  };
  persist = () => M.store.set('invite-report.json', { ...report, partial: true }).catch(() => {});

  const until = async (fn, ms, label) => {
    const end = Date.now() + ms;
    for (;;) {
      let value = null;
      try {
        value = await fn();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() > end) throw new Error('timeout: ' + label);
      await wait(250);
    }
  };

  /** The parent drops a file here; file:stat is not cached, so polling works. */
  const readBridge = async (name) => {
    const info = await M.files.stat('invitetest', name);
    if (!info) return null;
    const bytes = await M.files.read(info.path, 0, info.size);
    const text = new TextDecoder().decode(bytes).trim();
    return text || null;
  };

  /**
   * A private host candidate is useless to the other side of the internet, so
   * the code only really works if it also carries a server-reflexive one. Count
   * what is in there rather than trusting that gathering finished: the SDP
   * itself, and the `x` field, which is where the reflexive lines travel once
   * they are borrowed from a throwaway offerer (Chromium's answerer collects
   * none of its own - see Net.discoverReflexive).
   */
  const candidateTypes = (sdp, extra) => {
    const out = { host: 0, srflx: 0, relay: 0 };
    const all = [...(String(sdp || '').match(/a=candidate:[^\r\n]+/g) || [])];
    for (const raw of Array.isArray(extra) ? extra : []) all.push('a=' + String(raw).trim());
    for (const line of all) {
      const type = (line.match(/typ (\w+)/) || [])[1];
      if (type && type in out) out[type] += 1;
    }
    return out;
  };

  try {
    const appEl = document.getElementById('app');
    await until(() => appEl && !appEl.hidden, 25000, 'app visible');
    note('booted');

    const S = await import(new URL('../js/state.js', location.href).href);
    const C = await import(new URL('../js/crypto.js', location.href).href);
    const chat = await import(new URL('../js/ui/chat.js', location.href).href);
    const { net } = await import(new URL('../js/app.js', location.href).href);
    for (const event of ['state', 'error', 'closed', 'tamper', 'reconnecting', 'no-route']) {
      net.on(event, (payload) => {
        netlog.push(
          Date.now() + ' ' + event + ' ' + (payload?.state || payload?.reason || payload?.error?.message || '')
        );
        if (netlog.length > 80) netlog.shift();
      });
    }
    report.netlog = netlog;
    const me = S.state.profile;
    report.name = me.name;
    await wait(1500);
    /* if discovery were on, the peers would find each other by themselves and
       the test would prove nothing about the code */
    report.peersBeforeExchange = net.peers.size;
    note('isolated');

    if (report.name === 'Alpha') {
      const { code } = await net.createInvite();
      report.codeChars = code.length;
      await M.store.set('code-offer.json', { code });
      note('offerReady');
      const answer = await until(() => readBridge('answer.txt'), 90000, 'answer code');
      report.answerChars = answer.length;
      /* the answer must carry a reachable address, not only a private one */
      const unpacked = await C.unpackCode(answer);
      report.answerCandidates = candidateTypes(unpacked.s?.sdp, unpacked.x);
      report.answerHasSrflx = report.answerCandidates.srflx > 0;
      report.answerExtra = Array.isArray(unpacked.x) ? unpacked.x.length : 0;
      report.peerId = await net.completeInvite(answer);
      note('answerApplied');
    } else {
      const offer = await until(() => readBridge('offer.txt'), 90000, 'offer code');
      const unpacked = await C.unpackCode(offer);
      report.offerCandidates = candidateTypes(unpacked.s?.sdp, unpacked.x);
      report.offerHasSrflx = report.offerCandidates.srflx > 0;
      report.offerExtra = Array.isArray(unpacked.x) ? unpacked.x.length : 0;
      report.offerChars = offer.length;
      const { code, id, profile } = await net.answerInvite(offer);
      report.peerId = id;
      report.peerName = profile.name;
      await M.store.set('code-answer.json', { code });
      note('answerReady');
    }

    await until(() => net.peers.get(report.peerId)?.ready, 90000, 'data channel open');
    note('channelOpen');
    await until(() => net.peers.get(report.peerId)?.verified, 30000, 'handshake verified');
    note('verified');
    report.state = net.state(report.peerId);
    report.peerStateAtSend = {
      ready: Boolean(net.peers.get(report.peerId)?.ready),
      verified: Boolean(net.peers.get(report.peerId)?.verified),
      conn: net.peers.get(report.peerId)?.pc?.connectionState,
      ctl: net.peers.get(report.peerId)?.ctl?.readyState,
    };
    report.safety = await C.safetyNumber(me.identity, { fingerprint: S.contact(report.peerId)?.fingerprint || '' });
    report.peerNameSeen = S.contact(report.peerId)?.name || null;
    void persist();

    await chat.open(report.peerId);
    if (report.name === 'Alpha') {
      const sent = await chat.sendText('Привет по коду 🗝');
      report.sentState = sent ? sent.state : null;
      note('sentText');
      report.gotText = await until(
        () => S.messages(report.peerId).find((m) => m.dir === 'in' && m.text)?.text || null,
        30000,
        'reply over the code'
      );
    } else {
      report.gotText = await until(
        () => S.messages(report.peerId).find((m) => m.dir === 'in' && m.text)?.text || null,
        30000,
        'text over the code'
      );
      const reply = await chat.sendText('Ответ по коду 🗝');
      report.sentState = reply ? reply.state : null;
      note('replied');
    }
    report.ok = report.errors.length === 0;
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }

  await M.store.set('invite-report.json', report);
  return JSON.stringify(report);
})();
