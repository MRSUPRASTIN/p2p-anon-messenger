'use strict';
/** Boots the app with MOUTH_SMOKE=1 and prints the renderer self-test report. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const root = path.join(__dirname, '..');
const electron = require('electron');
const exe = typeof electron === 'string' ? electron : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(exe)) {
  console.error('electron binary not found at ' + exe);
  process.exit(1);
}

/**
 * A write that lands while an older one is still in flight must not be lost:
 * the older pass used to clear the dirty flag unconditionally, so the newer
 * value was never written and the app silently lost the last state change.
 */
async function storeRace() {
  const { Store } = require(path.join(root, 'src', 'main', 'store.js'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mouth-store-'));
  const store = new Store(dir);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const problems = [];

  store.write('a.json', { v: 'first' });
  await store.flush('a.json');
  if (read('a.json').v !== 'first') problems.push('single write lost');

  /* Freeze the real write so the second save provably lands while the first is
     still in flight. Timing alone would make this test pass by luck. */
  const fspModule = require('fs/promises');
  const realWriteFile = fspModule.writeFile;
  let entered;
  const atDisk = new Promise((resolve) => (entered = resolve));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  fspModule.writeFile = async (...args) => {
    entered();
    await gate;
    return realWriteFile(...args);
  };
  try {
    const blob = 'x'.repeat(64 * 1024);
    store.write('race.json', { v: 'old', blob });
    const firstFlush = store.flush('race.json');
    await atDisk;
    store.write('race.json', { v: 'new', blob });
    const secondFlush = store.flush('race.json');
    release();
    await Promise.all([firstFlush, secondFlush]);
  } finally {
    fspModule.writeFile = realWriteFile;
  }
  if (read('race.json').v !== 'new') {
    problems.push('write racing an in-flight write lost: ' + JSON.stringify(read('race.json').v));
  }

  const pending = [];
  for (let i = 0; i < 60; i += 1) {
    store.write('c.json', { i });
    pending.push(store.flush('c.json'));
  }
  await Promise.all(pending);
  if (read('c.json').i !== 59) problems.push('burst lost the last value: ' + JSON.stringify(read('c.json')));

  store.write('d.json', { v: 'sync' });
  store.flushSync();
  if (read('d.json').v !== 'sync') problems.push('flushSync lost the value');

  const strays = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  if (strays.length) problems.push('temp files left behind: ' + strays.join(', '));
  await fsp.rm(dir, { recursive: true, force: true });
  return { problems };
}

(async () => {
  const race = await storeRace();
  const storeOk = race.problems.length === 0;
  console.log('STORE_RESULT ' + (storeOk ? 'PASS' : 'FAIL'));
  for (const p of race.problems) console.log('- ' + p);

  /* A private profile: the real one belongs to the user's running app, and two
     Chromium instances on the same user data dir fight over its lock. */
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'mouth-smoke-'));
  const child = spawn(exe, ['.'], {
    cwd: root,
    env: { ...process.env, MOUTH_SMOKE: '1', MOUTH_USER_DATA: profile, MOUTH_NO_SINGLE_INSTANCE: '1', ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  const cleanup = () => fsp.rm(profile, { recursive: true, force: true }).catch(() => {});

  const timer = setTimeout(() => {
    child.kill();
    console.log(out);
    console.log('SMOKE_RESULT TIMEOUT');
    cleanup();
    process.exit(1);
  }, 45000);

  child.on('exit', (code) => {
    clearTimeout(timer);
    cleanup();
    console.log(out.trim());
    const pass = /SMOKE_RESULT PASS/.test(out);
    process.exit(pass && storeOk ? 0 : code === 0 ? 1 : code || 1);
  });
})();
