/**
 * Builds one screen so the main process can photograph it for the README.
 * Everything here is invented for the screenshot - the parent writes a
 * throwaway profile with made up people, so a real profile, a real contact or
 * a real message can never end up in the repository.
 */
(async () => {
  const report = { ok: false, shot: window.__SHOT || 'shot', steps: [], checks: [], errors: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
      await wait(150);
    }
  };
  const note = (step) => report.steps.push(step);
  const clickText = (selector, text) => {
    const node = [...document.querySelectorAll(selector)].find((n) => n.textContent.includes(text));
    if (!node) throw new Error('not found: ' + selector + ' with ' + text);
    node.click();
    return node;
  };
  const rail = (id) => {
    const node = document.querySelector('.rail__btn[data-id="' + id + '"]');
    if (!node) throw new Error('no rail button for ' + id);
    node.click();
  };
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  try {
    await until(() => {
      const app = document.getElementById('app');
      return app && !app.hidden;
    }, 30000, 'app visible');
    const S = await import(new URL('../js/state.js', location.href).href);
    const chat = await import(new URL('../js/ui/chat.js', location.href).href);
    const { openInvite } = await import(new URL('../js/ui/invite.js', location.href).href);

    const contacts = S.contactList();
    const byName = (name) => {
      const found = contacts.find((c) => c.name === name);
      if (!found) throw new Error('seed contact missing: ' + name);
      return found;
    };
    const say = (peer, message) => {
      S.addMessage(peer.id, {
        id: message.id,
        peerId: peer.id,
        dir: message.dir,
        ts: message.ts,
        authorName: message.dir === 'in' ? peer.name : S.state.profile?.name,
        authorId: message.dir === 'in' ? peer.id : S.state.profile?.id,
        text: message.text || '',
        file: message.file || null,
        state: message.dir === 'out' ? message.state || 'read' : undefined,
        reactions: message.reactions || [],
      });
    };

    const main = byName('Максим');
    const now = Date.now();
    say(main, { id: 'm1', dir: 'in', ts: now - 5 * HOUR, text: 'Привет! Ты уже смотрел тот проект, про который я говорил?' });
    say(main, { id: 'm2', dir: 'out', ts: now - 5 * HOUR + 40000, text: 'Да, открыл вечером. Идея с локальной сетью вместо сервера интересная.' });
    say(main, { id: 'm3', dir: 'in', ts: now - 5 * HOUR + 45000, text: 'Вот схема, как я это вижу. Скинул файлом, там же таблица.' });
    say(main, {
      id: 'm4',
      dir: 'in',
      ts: now - 5 * HOUR + 46000,
      file: { name: 'схема.pdf', size: 486213, mime: 'application/pdf', path: '' },
    });
    say(main, { id: 'm5', dir: 'out', ts: now - 4 * HOUR, text: 'Понял. Давай обсудим в субботу созвоном, я накидаю ещё схему со стороны клиента.', reactions: [{ emoji: '👍', from: 'in' }] });
    say(main, { id: 'm6', dir: 'in', ts: now - 3 * HOUR, text: 'Договорились. Скину код приглашения вечером, чтобы ты проверил со второй стороны.' });
    say(main, { id: 'm7', dir: 'out', ts: now - 40 * MIN, text: 'Жду. Проверю с телефона и с ноутбука одновременно.' });

    const irina = byName('Ирина');
    say(irina, { id: 'i1', dir: 'in', ts: now - 26 * HOUR, text: 'Ключи от квартиры заберу в среду, спасибо!' });
    say(irina, { id: 'i2', dir: 'out', ts: now - 25 * HOUR, text: 'Хорошо, я буду после шести.' });

    const timur = byName('Тимур');
    say(timur, { id: 't1', dir: 'in', ts: now - 2 * HOUR, text: 'Скинь, пожалуйста, конфиг, который мы обсуждали.' });

    /* Two invented neighbours so the discovery screen is not an empty box.
       Discovery is off in the seed settings, so nothing here touches the
       real network. */
    S.setDiscovered(
      {
        id: byName('Ирина').id,
        name: 'Ирина',
        emoji: '🐈',
        color: '#f59e0b',
        fingerprint: '',
        port: 45311,
      },
      false
    );
    S.setDiscovered(
      { id: 'lan-nas-01', name: 'Домашний NAS', emoji: '🗄', color: '#34d399', fingerprint: '', port: 45313 },
      false
    );
    note('seeded');

    if (report.shot === 'chats') {
      rail('chats');
      await until(() => document.querySelectorAll('.crow').length >= 3, 8000, 'contact rows');
      note('chats');
    } else if (report.shot === 'chat') {
      rail('chats');
      await until(() => document.querySelectorAll('.crow').length >= 3, 8000, 'contact rows');
      clickText('.crow', 'Максим');
      await until(() => chat.isOpen(main.id), 8000, 'chat open');
      await until(() => document.querySelectorAll('.msg').length >= 7, 8000, 'bubbles');
      note('chat');
    } else if (report.shot === 'invite') {
      openInvite();
      /* The code is only worth photographing once it is really in there. */
      await until(() => {
        const box = document.querySelector('.code--accent');
        return box && box.textContent.length > 200;
      }, 30000, 'invite code');
      /* The real code carries this machine's public address and open UDP port.
         Nobody's network address belongs in a public repository, so the box
         gets a code built from the documentation range instead - same shape,
         same length, nobody's IP. */
      const C = await import(new URL('../js/crypto.js', location.href).href);
      const box = document.querySelector('.code--accent');
      const fake = await C.packCode({
        v: 1,
        k: 'offer',
        t: C.randomId('t'),
        s: 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' +
          'a=group:BUNDLE 0\r\na=msid-semantic: WMS\r\n' +
          'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
          'c=IN IP4 0.0.0.0\r\na=ice-ufrag:EsA1\r\na=ice-pwd:P0ZxamplePwd0ZxampleP0ZxampleP0Zx\r\n' +
          'a=ice-options:trickle\r\na=fingerprint:sha-256 ' + 'AA:'.repeat(31) + 'BB\r\n' +
          'a=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n' +
          'a=candidate:1 1 udp 2113937151 203.0.113.42 51820 typ srflx raddr 192.168.0.8 rport 59312 ' +
          'generation 0 network-id 1\r\n' +
          'a=end-of-candidates\r\n',
        x: ['candidate:1 1 udp 2113937151 203.0.113.42 51820 typ srflx raddr 0.0.0.0 rport 0 generation 0'],
        p: { id: S.state.profile.id, name: S.state.profile.name, emoji: S.state.profile.emoji },
      });
      box.textContent = fake;
      if (box.textContent !== fake) throw new Error('код в поле не тот, который мы подставили');
      report.checks.push('invite code carries no live address');
      note('invite');
    } else if (report.shot === 'discover') {
      rail('discover');
      await until(() => document.querySelectorAll('.card, .crow, .peer').length >= 1, 8000, 'discover view');
      note('discover');
    } else if (report.shot === 'settings') {
      rail('settings');
      await until(() => document.querySelector('.view--pad, .view')?.textContent?.includes('Настройки'), 8000, 'settings view');
      /* The about card prints the data folder, so the parent puts the profile
         somewhere without a user name in it. This is the check that keeps it
         that way: the Windows account name must not appear anywhere on screen. */
      const forbidden = window.__SHOT_FORBID || '';
      if (forbidden) {
        const printed = document.body.innerText || '';
        if (printed.includes(forbidden)) throw new Error('the screen prints the local user name');
        report.checks.push('no local user name on screen');
      }
      note('settings');
    } else {
      throw new Error('unknown shot: ' + report.shot);
    }

    /* Let the layout, the avatar gradients and the scroll settle. */
    await wait(1200);
    report.ok = true;
  } catch (err) {
    report.errors.push(err && err.message ? err.message : String(err));
  }
  return JSON.stringify(report);
})();
