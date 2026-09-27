/**
 * Renderer-side self test, injected by the main process when MOUTH_SMOKE=1.
 * Returns a JSON report; never throws.
 */
(async () => {
  const report = { ok: true, steps: {}, errors: [] };
  const step = async (name, fn) => {
    try {
      report.steps[name] = await fn();
    } catch (err) {
      report.ok = false;
      report.errors.push(name + ': ' + (err && err.message ? err.message : String(err)));
    }
  };
  const M = window.mouth;

  await step('bridge', () => ({ hasMouth: Boolean(M), keys: M ? Object.keys(M) : [] }));

  await step('info', async () => {
    const info = await M.info();
    return { version: info.version, udpPort: info.udpPort, userData: Boolean(info.userData) };
  });

  await step('store', async () => {
    await M.store.set('smoke.json', { hello: 'world', n: 42 });
    const back = await M.store.get('smoke.json', null);
    return { roundtrip: JSON.stringify(back) };
  });

  await step('crypto', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
    const hash = await crypto.subtle.digest('SHA-256', raw);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { fp: hex.slice(0, 16), bits: raw.byteLength * 8 };
  });

  await step('webcrypto', async () => {
    // WebCrypto must refuse an ECDH key for signing - the reason the identity
    // needs two separate P-256 pairs
    const dh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    let refused = false;
    try {
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dh.privateKey, new Uint8Array([1]));
    } catch {
      refused = true;
    }
    const ecdsa = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      ecdsa.privateKey,
      new TextEncoder().encode('ok')
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      ecdsa.publicKey,
      sig,
      new TextEncoder().encode('ok')
    );
    return { ecdhCannotSign: refused, ecdsaSigns: ok };
  });

  await step('webrtc', async () => {
    const a = new RTCPeerConnection({ iceServers: [] });
    const b = new RTCPeerConnection({ iceServers: [] });
    const dc = a.createDataChannel('t', { ordered: true });
    const got = new Promise((resolve, reject) => {
      b.ondatachannel = (e) => {
        e.channel.onmessage = (m) => resolve(m.data);
      };
      setTimeout(() => reject(new Error('datachannel timeout')), 8000);
    });
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(a.localDescription);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(b.localDescription);
    dc.onopen = () => dc.send('ping');
    const text = await got;
    a.close();
    b.close();
    return { echo: text, state: dc.readyState };
  });

  await step('chatStore', async () => {
    const msgs = [
      { id: 'a', text: 'one', ts: Date.now() },
      { id: 'b', text: 'two', ts: Date.now() + 1 },
    ];
    await M.chat.save('smoke-peer', msgs);
    const back = await M.chat.load('smoke-peer');
    await M.chat.forget('smoke-peer');
    return { count: back.length, first: back[0] && back[0].text };
  });

  await step('discovery', async () => {
    const peers = await M.net.peers();
    return { started: true, peers: peers.length, udp: (await M.info()).udpPort };
  });

  await step('compression', async () => {
    if (typeof CompressionStream === 'undefined') return { supported: false };
    const cs = new CompressionStream('deflate-raw');
    const blob = new Blob([JSON.stringify({ hello: 'world' })]);
    const buf = new Uint8Array(await new Response(blob.stream().pipeThrough(cs)).arrayBuffer());
    return { supported: true, in: 17, out: buf.byteLength };
  });

  await step('identity', async () => {
    const C = await import(new URL('../js/crypto.js', location.href).href);
    const a = await C.createIdentity();
    const b = await C.createIdentity();

    // both halves of the identity are present and the fingerprint is a real hash
    const fpAgain = await C.fingerprintOf(C.unb64u(a.pubRaw), C.unb64u(a.dhRaw));
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3])))];

    // sign / verify really works (this is what the old code got wrong)
    const sig = await C.sign(a.privateKey || (await C.restoreIdentity(a)).privateKey, 'hello');
    const pub = await C.importPublic(a.pubRaw);
    const verified = await C.verify(pub, sig, 'hello');
    const tampered = await C.verify(pub, sig, 'hello!');

    // session key agreement has to match on both ends
    const a2 = await C.restoreIdentity(a);
    const b2 = await C.restoreIdentity(b);
    const dhA = await C.importDhPublic(b.dhRaw);
    const dhB = await C.importDhPublic(a.dhRaw);
    const k1 = await C.deriveSessionKey(a2, dhA, b.dhRaw);
    const k2 = await C.deriveSessionKey(b2, dhB, a.dhRaw);
    const env = await C.encryptBytes(k1, new Uint8Array([9, 8, 7, 6]));
    const back = await C.decryptBytes(k2, env);

    return {
      fpLen: a.fingerprint.length,
      fpMatches: fpAgain === a.fingerprint,
      fpHex: /^[0-9a-f]{64}$/.test(a.fingerprint),
      shaLen: sha.length,
      verified,
      tampered,
      sharedKey: [...back].join(','),
      safety: (await C.safetyNumber(a2, { fingerprint: b.fingerprint })).length,
    };
  });

  await step('inviteCode', async () => {
    const C = await import(new URL('../js/crypto.js', location.href).href);
    const sdp = { type: 'offer', sdp: 'v=0\r\n'.repeat(200) };
    const packed = await C.packCode({ v: 1, k: 'offer', t: 'tok', s: sdp, p: { id: 'x' } });
    const parsed = await C.unpackCode(packed);
    // a copy/paste through a chat app adds spaces, tabs and newlines
    const messy = packed.slice(0, 30) + ' \n\t ' + packed.slice(30);
    const parsed2 = await C.unpackCode(messy);
    const stripped = packed.split('.').join('');
    return {
      len: packed.length,
      head: packed.slice(0, 12),
      sdpIntact: parsed.s.sdp.length === sdp.sdp.length,
      messyOk: parsed2.t === 'tok',
      base64urlSafe: /^[A-Za-z0-9._-]+$/.test(stripped),
      bodyLen: stripped.length,
      bodyMod4: stripped.length % 4,
    };
  });

  await step('modules', async () => {
    const mods = [
      'util.js',
      'icons.js',
      'crypto.js',
      'state.js',
      'net.js',
      'app.js',
      'ui/overlay.js',
      'ui/emoji.js',
      'ui/sidebar.js',
      'ui/chat.js',
      'ui/views.js',
      'ui/info.js',
      'ui/invite.js',
      'ui/onboarding.js',
    ];
    const out = {};
    for (const m of mods) {
      try {
        const mod = await import(new URL('../js/' + m, location.href).href);
        out[m] = Object.keys(mod).length;
      } catch (err) {
        out[m] = 'FAIL ' + err.message;
        report.ok = false;
        report.errors.push('module ' + m + ': ' + err.message);
      }
    }
    return out;
  });

  await step('boot', async () => {
    // if boot() bailed out, the failure screen carries the real message
    const heading = [...document.querySelectorAll('.onboard__card h1')]
      .find((h) => h.textContent === 'Не удалось запустить');
    if (heading) {
      const card = heading.closest('.onboard__card');
      throw new Error('boot failed: ' + heading.textContent + ' / ' + (card.querySelector('p') || {}).textContent);
    }
    const onOnboarding = !!document.querySelector('.onboard__card');
    return { booted: true, onOnboarding };
  });

  await step('ui', async () => {
    const app = document.getElementById('app');
    const rail = document.getElementById('rail');
    const list = document.getElementById('chatList');
    return {
      appVisible: app ? !app.hidden : false,
      railButtons: rail ? rail.querySelectorAll('.rail__btn').length : 0,
      listChildren: list ? list.children.length : 0,
      spriteSymbols: document.querySelectorAll('#sprite symbol').length,
    };
  });

  /** Drive the real onboarding flow the way a first-run user would. */
  await step('onboarding', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const buttons = (root) => [...root.querySelectorAll('button')].map((b) => b.textContent.trim());
    const btn = (root, label) => {
      const found = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
      if (!found) throw new Error('нет кнопки «' + label + '», есть: ' + buttons(root).join('|'));
      found.click();
    };

    const steps = [];
    let host = document.querySelector('.onboard');
    if (host) {
      steps.push('buttons0=' + buttons(host).join(','));
      const input = host.querySelector('input.input');
      input.value = 'Smoke Tester';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(60);
      btn(host, 'Далее');
      await wait(200);

      host = document.querySelector('.onboard');
      steps.push('buttons1=' + buttons(host).join(','));
      steps.push('emojiPicks=' + host.querySelectorAll('.emoji-pick').length);
      steps.push('accents=' + host.querySelectorAll('.accent-dot').length);
      host.querySelectorAll('.emoji-pick')[3].click();
      host.querySelectorAll('.accent-dot')[4].click();
      await wait(60);
      steps.push('previewAvatar=' + Boolean(host.querySelector('.onboard__preview .avatar')));
      btn(host, 'Создать личность');

      for (let i = 0; i < 80 && !document.querySelector('.onboard__done'); i++) await wait(100);
      host = document.querySelector('.onboard');
      steps.push('done=' + Boolean(host && host.querySelector('.onboard__done')));
      if (host) btn(host, 'Начать общение');
      await wait(500);
    }

    for (let i = 0; i < 40 && document.getElementById('app').hidden; i++) await wait(100);
    const profile = await M.store.get('profile.json', null);
    return {
      steps,
      onboardGone: !document.querySelector('.onboard'),
      appVisible: !document.getElementById('app').hidden,
      name: profile && profile.name,
      hasIdentity: Boolean(profile && profile.identity && profile.identity.fingerprint),
      fingerprintLen: profile && profile.identity ? profile.identity.fingerprint.length : 0,
    };
  });

  await step('sections', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    for (const id of ['discover', 'contacts', 'settings', 'chats']) {
      document.querySelector('.rail__btn[data-id="' + id + '"]').click();
      await wait(180);
      const view = document.getElementById('view');
      out[id] = {
        shell: document.getElementById('shell').dataset.section,
        cards: view.querySelectorAll('.card').length,
        head: (view.querySelector('.page-head h2') || {}).textContent || '',
      };
    }
    return out;
  });

  await step('fakePeer', async () => {
    const S = await import(new URL('../js/state.js', location.href).href);
    const chat = await import(new URL('../js/ui/chat.js', location.href).href);
    const id = 'peer-smoke-0001';
    S.upsertContact({ id, name: 'Тестовый Собеседник', color: '#22d3ee', pubRaw: '', fingerprint: '' });
    S.setActive(id);
    await S.ensureChat(id);
    S.addMessage(id, {
      id: 'm1', peerId: id, dir: 'in', kind: 'text',
      text: 'Привет! Это проверка связи 🚀', ts: Date.now() - 60000, state: 'delivered', reactions: [],
    });
    S.addMessage(id, {
      id: 'm2', peerId: id, dir: 'out', kind: 'text',
      text: 'Привет 👋', ts: Date.now() - 30000, state: 'read', reactions: [{ emoji: '👍', count: 1, mine: true }],
    });
    await chat.open(id);
    await new Promise((r) => setTimeout(r, 250));
    const bubbles = document.querySelectorAll('.bubble');
    document.querySelector('.rail__btn[data-id="chats"]').click();
    await new Promise((r) => setTimeout(r, 150));
    return {
      bubbles: bubbles.length,
      reactions: document.querySelectorAll('.reaction').length,
      rows: document.querySelectorAll('.crow').length,
      composer: Boolean(document.querySelector('.composer__input')),
      searchWorks: (() => {
        const input = document.getElementById('search');
        input.value = 'проверка';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const hits = document.querySelectorAll('.crow').length;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return hits;
      })(),
    };
  });

  await step('sendLocal', async () => {
    const chat = await import(new URL('../js/ui/chat.js', location.href).href);
    const S = await import(new URL('../js/state.js', location.href).href);
    const peerId = chat.currentPeer() || S.state.activeId;
    const sent = await chat.sendText('Сообщение из smoke-теста ✅');
    await new Promise((r) => setTimeout(r, 200));
    return {
      peerId,
      added: Boolean(sent),
      stored: S.messages(peerId).length,
      failed: sent ? sent.state : null,
    };
  });

  await step('files', async () => {
    const chat = await import(new URL('../js/ui/chat.js', location.href).href);
    const S = await import(new URL('../js/state.js', location.href).href);
    const peerId = chat.currentPeer();
    const bytes = new Uint8Array(300000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
    await M.files.store({ id: 'smoke-file', name: 'blob.bin', bytes });
    const stat = await M.files.stat('smoke-file', 'blob.bin');
    const read = await M.files.read(stat.path, 10, 8);
    const job = { dir: 'out', sent: 0, received: 0, total: 100 };
    chat.transfers.set('progress-demo', job);
    return {
      stored: stat.size,
      readOk: [...read].join(',') === [...bytes.slice(10, 18)].join(','),
      transfersTracked: chat.transfers.size,
    };
  });

  return JSON.stringify(report);
})();
