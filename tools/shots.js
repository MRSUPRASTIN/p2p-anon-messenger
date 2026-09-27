'use strict';
/**
 * Photographs the app for the README. One throwaway profile with invented
 * people, one app run per screen, real windows captured through
 * webContents.capturePage() - no mockups and nothing of the real profile.
 *
 *   node tools/shots.js [name ...]
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const electron = require('electron');
const exe = typeof electron === 'string' ? electron : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const SCRIPT = path.join(__dirname, 'shots-renderer.js');

const SHOTS = ['chats', 'chat', 'invite', 'discover', 'settings'];

/** The people in the screenshots. Nothing here is a real contact. */
const PEOPLE = [
  { name: 'Максим', emoji: '🧭', color: '#22d3ee', bio: 'Проекты и велосипеды', verified: true, lan: true },
  { name: 'Ирина', emoji: '🐈', color: '#f59e0b', bio: '', verified: true, lan: true },
  { name: 'Тимур', emoji: '🛰', color: '#a78bfa', bio: 'Работа', verified: false, lan: true },
];

async function seedProfile(dir) {
  const C = await import(pathToFileURL(path.join(ROOT, 'src', 'renderer', 'js', 'crypto.js')).href);
  const me = await C.createIdentity();
  const contacts = [];
  for (const person of PEOPLE) {
    /* A real key pair per contact: the header shows a safety number, and that
       number has to come from actual keys to be worth looking at. */
    const identity = await C.createIdentity();
    contacts.push({
      id: identity.id,
      name: person.name,
      emoji: person.emoji,
      color: person.color,
      bio: person.bio,
      avatar: '',
      pubRaw: identity.pubRaw,
      dhRaw: identity.dhRaw,
      fingerprint: identity.fingerprint,
      note: '',
      pinned: person.name === 'Максим',
      verified: person.verified,
      lan: person.lan,
      createdAt: Date.now() - 86400000 * 30,
      lastSeen: Date.now() - 60000,
    });
  }
  await fsp.mkdir(path.join(dir, 'chats'), { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'profile.json'),
    JSON.stringify({
      id: me.id,
      name: 'Алексей',
      emoji: '🦊',
      color: '#a78bfa',
      bio: 'Никому ничего лишнего',
      createdAt: Date.now() - 86400000 * 30,
      identity: me,
    })
  );
  await fsp.writeFile(path.join(dir, 'contacts.json'), JSON.stringify(contacts));
  await fsp.writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      theme: 'dark',
      accent: '#a78bfa',
      /* No discovery and no dialling while the camera is on: the screenshots
         must not depend on, or disturb, whoever is on the network. */
      autoConnect: false,
      lanDiscovery: false,
      notifications: false,
      minimiseToTray: false,
      readReceipts: true,
      typing: true,
    })
  );
  return { me, contacts };
}

function run(shot, profile) {
  return new Promise((resolve) => {
    const child = spawn(exe, ['.'], {
      cwd: ROOT,
      env: {
        ...process.env,
        MOUTH_USER_DATA: profile,
        MOUTH_SCRIPT: SCRIPT,
        MOUTH_SHOT: shot,
        MOUTH_SHOT_FORBID: os.userInfo().username,
        MOUTH_SHOT_DIR: OUT,
        MOUTH_UDP_PORT: '45331',
        MOUTH_NO_SINGLE_INSTANCE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const errors = [...out.matchAll(/SCRIPT_ERROR (.*)/g)].map((m) => m[1]);
      const failed = out.includes('SCRIPT_RESULT FAIL') || (code !== 0 && !out.includes('SCRIPT_RESULT'));
      resolve({ shot, ok: !failed, log: out, errors });
    });
  });
}

(async () => {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : SHOTS;
  const unknown = wanted.filter((s) => !SHOTS.includes(s));
  if (unknown.length) {
    console.error('unknown shot(s): ' + unknown.join(', ') + '\navailable: ' + SHOTS.join(', '));
    process.exit(1);
  }
  /* The settings screen prints the data folder, and the temp folder carries
     the Windows user name, so the screenshots get a profile in Public. */
  const profile = path.join(os.tmpdir().startsWith('C:') ? 'C:\\Users\\Public' : os.tmpdir(), 'p2panon-shots-' + process.pid);
  await fsp.mkdir(profile, { recursive: true });
  await fsp.mkdir(OUT, { recursive: true });
  const results = [];
  try {
    for (const shot of wanted) {
      const target = path.join(OUT, shot + '.png');
      await fsp.rm(target, { force: true });
      /* A clean profile per screen, so one run cannot inherit another's state */
      await seedProfile(profile);
      for (const f of await fsp.readdir(path.join(profile, 'chats')).catch(() => [])) {
        await fsp.rm(path.join(profile, 'chats', f), { force: true });
      }
      const result = await run(shot, profile);
      const exists = fs.existsSync(target);
      const checks = [...result.log.matchAll(/"checks": \[([^\]]*)\]/g)].map((m) => m[1].replace(/[\s"]/g, ''));
      results.push({ ...result, ok: result.ok && exists, checks });
      const size = exists ? fs.statSync(target).size : 0;
      console.log(
        '  ' + (result.ok && exists ? 'ok  ' : 'FAIL') + '  ' + shot.padEnd(9) +
          (exists ? (size / 1024).toFixed(0) + ' KB' : 'no png') +
          (checks.length ? '  [' + checks.join(' ') + ']' : '') +
          (result.errors.length ? '  ' + result.errors.join('; ') : '')
      );
    }
  } finally {
    await fsp.rm(profile, { recursive: true, force: true });
  }
  const bad = results.filter((r) => !r.ok);
  console.log('SHOTS_RESULT ' + (bad.length ? 'FAIL' : 'PASS') + ' ' + (results.length - bad.length) + '/' + results.length);
  console.log('written to ' + OUT);
  process.exit(bad.length ? 1 : 0);
})();
