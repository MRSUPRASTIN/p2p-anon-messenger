'use strict';
/**
 * electron-builder's own winCodeSign step needs symlinks, which a normal
 * (non-elevated) Windows account cannot create, so the download of that tool
 * fails on this machine. We do not sign the app at all, but we still want the
 * icon and the version stamped into the exe - that is all rcedit does, so we
 * run it ourselves right after the app folder is packed and before NSIS turns
 * it into an installer.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const CANDIDATES = [
  path.join(__dirname, 'bin', 'rcedit-x64.exe'),
  path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder',
    'Cache',
    'winCodeSign'
  ),
];

function findRcedit() {
  for (const candidate of CANDIDATES) {
    if (!candidate) continue;
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    // the cache holds one directory per downloaded archive
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      for (const dir of fs.readdirSync(candidate)) {
        const exe = path.join(candidate, dir, 'rcedit-x64.exe');
        if (fs.statSync(exe, { throwIfNoEntry: false })?.isFile()) return exe;
      }
    }
  }
  return null;
}

async function afterPack(context) {
  console.log('[after-pack] hook fired for ' + context.appOutDir);
  const exeName = pkg.productName + '.exe';
  const target = path.join(context.appOutDir, exeName);
  if (!fs.existsSync(target)) {
    console.warn('[after-pack] no exe at ' + target);
    return;
  }

  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn('[after-pack] rcedit not found, the exe keeps the Electron icon');
    return;
  }

  const icon = path.join(ROOT, 'build', 'icon.ico');
  const args = [target, '--set-icon', icon];
  if (fs.existsSync(icon)) {
    args.push(
      '--set-version-string',
      'ProductName',
      pkg.productName,
      '--set-version-string',
      'FileDescription',
      pkg.description,
      '--set-version-string',
      'CompanyName',
      pkg.productName,
      '--set-version-string',
      'LegalCopyright',
      (pkg.author || pkg.productName) + ' ' + pkg.license,
      '--set-file-version',
      pkg.version,
      '--set-product-version',
      pkg.version
    );
  }

  const result = spawnSync(rcedit, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    // never fail the build over cosmetics
    console.warn('[after-pack] rcedit exited with ' + result.status);
  } else {
    console.log('[after-pack] icon and version stamped into ' + exeName);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
