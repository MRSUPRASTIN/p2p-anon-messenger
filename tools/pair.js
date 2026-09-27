/**
 * Two real p2pAnon instances on this machine, talking to each other over the
 * actual stack: UDP discovery -> WebRTC handshake -> AES-GCM messages -> file.
 *
 * Run: node tools/pair.js
 *      node tools/pair.js --same-port   both instances want 45311, the way two
 *                                       copies of the installed app would
 */
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'pair-renderer.js');
const ELECTRON = process.env.MOUTH_PAIR_EXE || require('electron'); // path to the binary when not inside Electron
const PACKAGED = !!process.env.MOUTH_PAIR_EXE;
/* the mode a user hits in practice: two copies, both asking for the same port */
const SAME_PORT = process.argv.includes('--same-port');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mouth-pair-'));
  const sides = [
    { name: 'Alpha', port: SAME_PORT ? 45311 : 45311, dir: path.join(tmp, 'alpha'), emoji: '🦊', accent: '#22d3ee' },
    { name: 'Bravo', port: SAME_PORT ? 45311 : 45312, dir: path.join(tmp, 'bravo'), emoji: '🐙', accent: '#f472b6' },
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
      JSON.stringify({ theme: 'dark', accent: side.accent, autoConnect: true, lanDiscovery: true, notifications: false, minimiseToTray: false })
    );
  }

  console.log('pair test workspace: ' + tmp);
  console.log('mode: ' + (SAME_PORT ? 'same port 45311 for both' : 'distinct ports'));
  for (const side of sides) {
    console.log('  ' + side.name.padEnd(6) + ' id=' + side.identity.id.slice(0, 12) + ' udp=' + side.port + ' fp=' + side.identity.fingerprint.slice(0, 8));
  }

  const children = sides.map((side, index) =>
    spawn(ELECTRON, PACKAGED ? [] : [ROOT], {
      env: {
        ...process.env,
        MOUTH_USER_DATA: side.dir,
        MOUTH_UDP_PORT: String(side.port),
        /* the same-port mode must find the other side through the port pool
           alone, exactly like two installed copies do */
        MOUTH_UDP_PEER_PORT: SAME_PORT ? '' : String(sides[1 - index].port),
        MOUTH_SCRIPT: SCRIPT,
        MOUTH_NO_SINGLE_INSTANCE: '1',
        MOUTH_PAIR: '1',
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
        if (logs[i].length > 400) logs[i].shift();
        console.log('[' + tag + '] ' + line);
      }
    };
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
  });

  const deadline = Date.now() + 150000;
  const reports = [];
  const collect = () => {
    for (const side of sides) {
      if (reports.find((r) => r.name === side.name)) continue;
      const file = path.join(side.dir, 'pair-report.json');
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
    await wait(900);
    collect();
    if (children.every((c) => c.exitCode !== null || c.killed)) break;
  }
  /* both processes are gone by now, so whatever they wrote is on disk for good
     - a report can land in the same tick the child exits, and that must not be
     mistaken for a side that never answered */
  await wait(300);
  collect();

  console.log(
    'children: ' +
      children.map((c, i) => sides[i].name + ' exit=' + c.exitCode + ' signal=' + c.signalCode).join(', ')
  );

  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  await wait(400);

  const ok = reports.length === 2 && reports.every((r) => r.ok);
  console.log('\n================ PAIR REPORT ================');
  console.log(JSON.stringify(reports, null, 2));

  const problems = [];
  const alpha = reports.find((r) => r.name === 'Alpha');
  const bravo = reports.find((r) => r.name === 'Bravo');
  if (!alpha) problems.push('Alpha не отчитался');
  if (!bravo) problems.push('Bravo не отчитался');
  if (alpha && bravo) {
    if (alpha.safety?.join(' ') !== bravo.safety?.join(' ')) problems.push('коды сверки не совпали');
    if (alpha.peerFingerprint !== bravo.ownFingerprint) problems.push('отпечаток пира не совпал');
    if (!alpha.gotText) problems.push('Alpha не получил текст');
    if (!bravo.gotText) problems.push('Bravo не получил текст');
    if (alpha.file?.sha !== bravo.file?.sha) problems.push('переданный файл отличается');
    if (!alpha.file?.bytesOk) problems.push('Alpha получил битый файл');
    if (!bravo.file?.ackOk) problems.push('получатель не подтвердил файл');
    for (const side of [alpha, bravo]) {
      if (side.tamper?.length) problems.push(side.name + ': рукопожатие отвергнуто (' + side.tamper.join(', ') + ')');
      if (side.nonceCheck && !side.nonceCheck.kept) {
        problems.push(side.name + ': чужой hello затирает свой nonce - рукопожатие падает с «Подпись недействительна»');
      }
      if (side.nonceCheck?.hung) problems.push(side.name + ': соединение рвётся на проверке подписи');
    }
  }
  if (problems.length) {
    console.log('\nPROBLEMS:\n- ' + problems.join('\n- '));
  }
  console.log('\nPAIR_RESULT ' + (ok && !problems.length ? 'PASS' : 'FAIL'));
  if (!ok) {
    for (let i = 0; i < logs.length; i++) {
      console.log('\n--- ' + sides[i].name + ' log ---\n' + logs[i].join('').slice(-2500));
    }
  }
  process.exit(ok && !problems.length ? 0 : 1);
}

main().catch((err) => {
  console.error('pair test crashed:', err);
  process.exit(1);
});
