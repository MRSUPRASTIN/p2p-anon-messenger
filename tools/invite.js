/**
 * The no-server path: two instances with LAN discovery switched off, paired by
 * nothing but the invite codes. Proves the promise the app makes - «работает
 * между любыми сетями, сервер не нужен» - without a server in the picture.
 *
 * Run: node tools/invite.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'invite-renderer.js');
const ELECTRON = process.env.MOUTH_PAIR_EXE || require('electron');
const PACKAGED = !!process.env.MOUTH_PAIR_EXE;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mouth-invite-'));
  const sides = [
    { name: 'Alpha', port: 45321, dir: path.join(tmp, 'alpha'), emoji: '🦊', accent: '#22d3ee' },
    { name: 'Bravo', port: 45322, dir: path.join(tmp, 'bravo'), emoji: '🐙', accent: '#f472b6' },
  ];

  const C = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'crypto.js')).href);

  for (const side of sides) {
    const identity = await C.createIdentity();
    side.identity = identity;
    await fsp.mkdir(side.dir, { recursive: true });
    await fsp.writeFile(
      path.join(side.dir, 'profile.json'),
      JSON.stringify({
        id: identity.id,
        name: side.name,
        emoji: side.emoji,
        color: side.accent,
        bio: '',
        createdAt: Date.now(),
        identity,
      })
    );
    await fsp.writeFile(
      path.join(side.dir, 'settings.json'),
      /* discovery off on purpose: the code has to be the only way in */
      JSON.stringify({ theme: 'dark', accent: side.accent, autoConnect: false, lanDiscovery: false, notifications: false, minimiseToTray: false })
    );
  }

  console.log('invite test workspace: ' + tmp);
  for (const side of sides) console.log('  ' + side.name.padEnd(6) + ' id=' + side.identity.id.slice(0, 12));

  const children = sides.map((side) =>
    spawn(ELECTRON, PACKAGED ? [] : [ROOT], {
      env: {
        ...process.env,
        MOUTH_USER_DATA: side.dir,
        MOUTH_UDP_PORT: String(side.port),
        MOUTH_UDP_POOL: String(side.port),
        MOUTH_SCRIPT: SCRIPT,
        MOUTH_NO_SINGLE_INSTANCE: '1',
        ELECTRON_ENABLE_LOGGING: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );

  const logs = sides.map(() => []);
  children.forEach((child, i) => {
    const tag = sides[i].name.padEnd(5);
    const pipe = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        logs[i].push(line);
        if (logs[i].length > 300) logs[i].shift();
        console.log('[' + tag + '] ' + line);
      }
    };
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
  });

  /* longer than the children' own timeouts: the parent must never give up while a
     side is still legitimately waiting for a code */
  const deadline = Date.now() + 300000;
  const reports = [];
  const bridged = new Set();

  /**
   * The two instances cannot see each other's data folder, so this is the
   * messenger: pick up a code one side published and drop it into both folders
   * where the other side is waiting for it. The name matches store.filePath(),
   * which is what the renderer polls through file:stat.
   */
  const bridge = (from, doc, name) => {
    const key = name;
    if (bridged.has(key)) return;
    const src = path.join(sides[from].dir, doc);
    let code = null;
    try {
      code = JSON.parse(fs.readFileSync(src, 'utf8')).code;
    } catch {
      return; // not published yet
    }
    if (!code) return;
    for (const side of sides) {
      fs.mkdirSync(path.join(side.dir, 'files'), { recursive: true });
      fs.writeFileSync(path.join(side.dir, 'files', 'invitetest_' + name), code, 'utf8');
    }
    bridged.add(key);
    console.log('[bridge] ' + name + ' (' + code.length + ' chars) delivered to both sides');
  };

  const collect = () => {
    bridge(0, 'code-offer.json', 'offer.txt');
    bridge(1, 'code-answer.json', 'answer.txt');
    for (const side of sides) {
      if (reports.find((r) => r.name === side.name)) continue;
      const file = path.join(side.dir, 'invite-report.json');
      if (fs.existsSync(file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!parsed.partial) reports.push(parsed);
          else console.log('[' + side.name + '] progress: ' + (parsed.steps || []).slice(-1)[0]);
        } catch {
          /* still being written */
        }
      }
    }
  };
  while (Date.now() < deadline && reports.length < 2) {
    await wait(600);
    collect();
  }
  /* A report can still be mid-write when the last child exits, and a child that
     finished a second early would end the loop above with a report to spare. */
  for (let i = 0; i < 12 && reports.length < 2; i++) {
    await wait(400);
    collect();
  }
  await wait(300);
  collect();

  for (const child of children) if (child.exitCode === null) child.kill();

  const alpha = reports.find((r) => r.name === 'Alpha');
  const bravo = reports.find((r) => r.name === 'Bravo');
  const problems = [];
  if (!alpha) problems.push('Alpha не отчёкся');
  if (!bravo) problems.push('Bravo не отчёкся');
  if (alpha && bravo) {
    if (alpha.peersBeforeExchange || bravo.peersBeforeExchange) problems.push('discovery не выключена, тест ничего не доказывает');
    if (alpha.safety?.join(' ') !== bravo.safety?.join(' ')) problems.push('коды сверки не совпали');
    if (!alpha.gotText) problems.push('Alpha не получил текст');
    if (!bravo.gotText) problems.push('Bravo не получил текст');
    if (!bravo.offerHasSrflx) problems.push('в коде приглашения нет STUN-кандидата — через интернет не соединится');
    if (!alpha.answerHasSrflx) problems.push('в коде ответа нет STUN-кандидата — через интернет не соединится');
    if (alpha.sentState !== 'sent' || bravo.sentState !== 'sent') problems.push('сообщение не ушло (' + alpha.sentState + '/' + bravo.sentState + ')');
  }

  console.log('\n================ INVITE REPORT ================');
  console.log(JSON.stringify(reports, null, 2));
  if (problems.length) console.log('\nPROBLEMS:\n- ' + problems.join('\n- '));
  const ok = reports.length === 2 && reports.every((r) => r.ok) && !problems.length;
  console.log('\nINVITE_RESULT ' + (ok ? 'PASS' : 'FAIL'));
  if (!ok) {
    for (let i = 0; i < logs.length; i++) console.log('\n--- ' + sides[i].name + ' log ---\n' + logs[i].join('').slice(-2000));
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('invite test crashed:', err);
  process.exit(1);
});
