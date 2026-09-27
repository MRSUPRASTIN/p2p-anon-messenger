'use strict';
/**
 * p2pAnon Messenger - P2P messenger. Main process: window, storage, LAN
 * discovery, files.
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  nativeImage,
  Notification,
  dialog,
  shell,
  Menu,
  Tray,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const { Store, sanitiseName } = require('./store');
const { Discovery, PORT: UDP_PORT, POOL: DISCOVERY_POOL } = require('./discovery');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ASSET_ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

let win = null;
let tray = null;
let store = null;
let discovery = null;
let quitting = false;

/* ------------------------------------------------------------ protocol --- */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) event.preventDefault();
  });
});

/* ---------------------------------------------------------------- app --- */
if (process.env.MOUTH_USER_DATA) {
  app.setPath('userData', process.env.MOUTH_USER_DATA);
} else {
  /**
   * Pinned to the folder the old build used. Electron derives userData from
   * app.getName(), so renaming the product would otherwise move the whole
   * profile, contact list and chat history into an empty directory - the app
   * would come up as a stranger to the one you already had.
   */
  app.setPath('userData', path.join(app.getPath('appData'), 'Mouth'));
}

/* a second instance on the same machine is only ever wanted by the pair test */
if (process.env.MOUTH_NO_SINGLE_INSTANCE) {
  // no lock: the test drives two windows at once
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady()
  .then(() => {
    app.setAppUserModelId('com.p2panon.messenger');
    serveRenderer();
    store = new Store(app.getPath('userData'));
    discovery = new Discovery();
    registerIpc();
    createWindow();
    Menu.setApplicationMenu(buildMenu());
    createTray();
  })
  .catch((err) => {
    console.error('[main] startup failed:', err && err.stack ? err.stack : err);
  });

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[main] unhandled rejection:', err && err.stack ? err.stack : err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!win) createWindow();
});

app.on('before-quit', () => {
  quitting = true;
  if (discovery) discovery.sayBye();
  if (store) store.flushSync();
});

/* ------------------------------------------------------------- window --- */
function createWindow() {
  const bounds = store.read('window.json', null);
  const display = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: bounds && bounds.w ? bounds.w : Math.min(1180, display.width - 120),
    height: bounds && bounds.h ? bounds.h : Math.min(760, display.height - 120),
    x: bounds && bounds.x != null ? bounds.x : undefined,
    y: bounds && bounds.y != null ? bounds.y : undefined,
    minWidth: 720,
    minHeight: 520,
    show: false,
    frame: false,
    backgroundColor: '#0b0b12',
    titleBarStyle: 'hidden',
    icon: app.isPackaged ? ASSET_ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.loadURL('app://mouth/index.html');

  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error('[main] renderer failed to load', code, description, url);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[main] renderer gone:', JSON.stringify(details));
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[main] preload error:', preloadPath, error && error.message);
  });

  const TEST_RUN = Boolean(process.env.MOUTH_SCRIPT || process.env.MOUTH_SMOKE);

  win.once('ready-to-show', () => {
    /* a driven test must not put windows on the user's desktop */
    if (!TEST_RUN) {
      win.show();
      if (bounds && bounds.maximized) win.maximize();
    }
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const b = win.getBounds();
    store.write('window.json', { ...b, maximized: win.isMaximized() });
  };
  const emitState = () =>
    send('win:changed', { maximized: win.isMaximized(), focused: win.isFocused() });
  win.on('resize', persistBounds);
  win.on('move', persistBounds);
  win.on('maximize', () => {
    persistBounds();
    emitState();
  });
  win.on('unmaximize', () => {
    persistBounds();
    emitState();
  });
  win.on('focus', emitState);
  win.on('blur', emitState);
  win.on('enter-full-screen', emitState);
  win.on('leave-full-screen', emitState);

  win.on('close', (event) => {
    if (!quitting && store.read('settings.json', {}).minimiseToTray !== false) {
      event.preventDefault();
      win.hide();
      if (process.platform === 'darwin') app.dock.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const injected = process.env.MOUTH_SCRIPT;
  if (injected) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => runInjected(win, injected), 600);
    });
  } else if (process.env.MOUTH_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => runInjected(win, path.join(__dirname, '..', '..', 'tools', 'smoke-renderer.js'), 'SMOKE'), 600);
    });
  }
}

/** Dev-only end to end check; enabled with MOUTH_SMOKE=1 or MOUTH_SCRIPT. */
async function runInjected(target, file, label = 'SCRIPT') {
  const log = (...args) => console.log(...args);
  try {
    const src = fs.readFileSync(file, 'utf8');
    target.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) log('[renderer]', message);
    });
    /* tools/shots.js tells the script which screen to build, one app run per
       screenshot, so no handshake between the page and this process. */
    const prelude = process.env.MOUTH_SHOT
      ? 'window.__SHOT = ' + JSON.stringify(process.env.MOUTH_SHOT) + ';\n' +
        'window.__SHOT_FORBID = ' + JSON.stringify(process.env.MOUTH_SHOT_FORBID || '') + ';\n'
      : '';
    const raw = await target.webContents.executeJavaScript(prelude + src, true);
    const report = typeof raw === 'string' ? JSON.parse(raw) : raw;
    log(label + ' ' + JSON.stringify(report, null, 2));
    log(label + '_RESULT ' + (report.ok ? 'PASS' : 'FAIL'));
    if (process.env.MOUTH_SHOT_DIR && report.ok) {
      await shoot(target, report.shot || 'shot');
    }
    try {
      store.flushSync();
    } catch {
      /* the report is on stdout anyway */
    }
    app.exit(report.ok ? 0 : 1);
  } catch (err) {
    log(label + '_RESULT FAIL');
    log(label + '_ERROR ' + err.message);
    try {
      store.flushSync();
    } catch {
      /* nothing to save */
    }
    app.exit(1);
  }
}

/** Dev-only: write the window to a PNG for the README. */
async function shoot(win, name) {
  const dir = process.env.MOUTH_SHOT_DIR;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    /* A hidden or occluded window can come back as a blank frame, and a
       1280x800 page fits the README without upscaling. */
    win.setContentSize(1280, 800);
    await new Promise((r) => setTimeout(r, 450));
    const image = await win.webContents.capturePage();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name + '.png');
    fs.writeFileSync(file, image.toPNG());
    console.log('[shot] ' + file + ' ' + image.getSize().width + 'x' + image.getSize().height);
  } catch (err) {
    console.log('[shot] FAILED ' + name + ': ' + err.message);
  }
}

function serveRenderer() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // stored attachments: app://mouth/file/<id>/<name>
    if (rel.startsWith('/file/')) {
      const rest = rel.slice('/file/'.length);
      const slash = rest.indexOf('/');
      const id = slash === -1 ? rest : rest.slice(0, slash);
      const name = slash === -1 ? 'file' : rest.slice(slash + 1);
      if (!store) return new Response('Not found', { status: 404 });
      const file = store.filePath(id, name);
      try {
        const data = await fsp.readFile(file);
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        return new Response(data, {
          headers: { 'content-type': type, 'cache-control': 'no-cache' },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }

    const target = path.join(RENDERER_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!target.startsWith(RENDERER_DIR)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fsp.readFile(target);
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New chat',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('ui:action', 'new-chat'),
        },
        {
          label: 'Invite contact',
          accelerator: 'CmdOrCtrl+I',
          click: () => send('ui:action', 'invite'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(ASSET_ICON);
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 20, height: 20 }));
    tray.setToolTip('p2pAnon Messenger');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'p2pAnon Messenger', click: () => showWindow() },
        { label: 'Invite contact', click: () => { showWindow(); send('ui:action', 'invite'); } },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } },
      ])
    );
    tray.on('click', () => showWindow());
  } catch (err) {
    console.error('[tray]', err.message);
  }
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.dock.show();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------------------------------------------------------------- ipc --- */
function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => fn(...args));

  /* --- documents ------------------------------------------------------- */
  handle('store:get', (name, fallback) => store.read(name, fallback ?? null));
  handle('store:set', async (name, value) => {
    store.write(name, value);
    await store.flush(name);
    return value;
  });

  /* --- window ---------------------------------------------------------- */
  handle('win:action', (action) => {
    if (!win) return null;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
    else if (action === 'show') showWindow();
    return win.isMaximized();
  });
  handle('win:state', () => (win ? { maximized: win.isMaximized(), focused: win.isFocused() } : null));

  /* --- profile / settings ---------------------------------------------- */
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    /* the port we really hold, which is not always 45311: a second copy of the
       app on this machine takes the next one from the pool */
    udpPort: discovery ? discovery.getPort() : UDP_PORT,
    udpPool: DISCOVERY_POOL,
    userData: app.getPath('userData'),
    platform: process.platform,
    /* the pair test needs both sides to accept each other without a dialog */
    pair: process.env.MOUTH_PAIR === '1',
  }));

  /* --- chat history ---------------------------------------------------- */
  handle('chat:load', (peerId) => store.loadChat(peerId));
  handle('chat:save', (peerId, messages) => store.saveChat(peerId, messages));
  handle('chat:forget', (peerId) => {
    const file = store.chatFileFor(peerId);
    try {
      fs.unlinkSync(file);
    } catch {
      /* nothing stored yet */
    }
    return true;
  });

  /* --- attachments ----------------------------------------------------- */
  handle('file:pick', async (opts) => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Send file',
      properties: opts && opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    if (res.canceled) return [];
    return res.filePaths.map((p) => {
      const st = fs.statSync(p);
      return { path: p, name: path.basename(p), size: st.size, mtime: st.mtimeMs };
    });
  });

  handle('file:read', async (filePath, offset, length) => {
    const fh = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      /* A single read() may come up short well before the end of the file, and
         the sender steps on by the chunk length every time, so one short read
         used to skip bytes and deliver a quietly corrupt file - roughly one
         transfer in five. Fill the buffer instead. */
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await fh.read(buf, filled, length - filled, offset + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, filled).slice();
    } finally {
      await fh.close();
    }
  });

  handle('file:chunk', (transferId, index, data) => store.writeChunk(transferId, index, data));
  handle('file:finish', (transferId, name, size) => store.finishIncoming(transferId, name, size));
  handle('file:cancel', (transferId) => store.cancelIncoming(transferId));

  /**
   * Keeps a copy of what we send, so the sender sees the same image or audio
   * bubble as the receiver instead of an empty attachment card.
   */
  handle('file:store', async ({ id, name, path: src, bytes }) => {
    if (!id || !name) return false;
    const dest = store.filePath(id, name);
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (src) {
        await fsp.copyFile(src, dest);
      } else if (bytes) {
        await fsp.writeFile(dest, Buffer.from(bytes));
      } else {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  });
  handle('file:stat', async (id, name) => {
    const p = store.filePath(id, name);
    try {
      const st = await fsp.stat(p);
      return { path: p, size: st.size, name: path.basename(p) };
    } catch {
      return null;
    }
  });
  handle('file:open', async (id, name) => {
    const info = await store.filePath(id, name).then(async (p) => {
      try {
        await fsp.access(p);
        return p;
      } catch {
        return null;
      }
    });
    if (!info) return false;
    const err = await shell.openPath(info);
    return !err;
  });
  handle('file:reveal', async (id, name) => {
    const p = store.filePath(id, name);
    if (!fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });
  handle('shell:open', (url) => {
    if (/^https?:|^mailto:/.test(url)) return shell.openExternal(url);
    return false;
  });

  /* --- network --------------------------------------------------------- */
  handle('net:start', (profile) => {
    discovery.start(profile);
    return { port: UDP_PORT };
  });
  handle('net:stop', () => {
    discovery.sayBye();
    discovery.stop();
    return true;
  });
  handle('net:broadcast', (payload) => {
    discovery.broadcast(payload);
    return true;
  });
  handle('net:send', (peerId, payload) => {
    const ok = discovery.sendTo(peerId, payload);
    if (!ok) {
      console.error(
        '[net:send] no route to ' + peerId + ' (' + (payload && payload.t) + '), known: ' +
          discovery.list().map((p) => p.id.slice(0, 8) + '@' + p.addr + ':' + p.port).join(' ')
      );
    }
    return ok;
  });
  handle('net:peers', () => discovery.list());
  handle('net:remember', (peerId, addr) => discovery.remember(peerId, addr));

  /* --- notifications ---------------------------------------------------- */
  handle('notify', ({ title, body, silent, peerId }) => {
    const settings = store.read('settings.json', {});
    if (settings.notifications === false) return false;
    if (Notification.isSupported()) {
      const n = new Notification({
        title: title || 'p2pAnon Messenger',
        body: body || '',
        silent: Boolean(silent),
        icon: app.isPackaged ? ASSET_ICON : undefined,
      });
      n.on('click', () => {
        showWindow();
        if (peerId) send('ui:action', { openChat: peerId });
      });
      n.show();
    }
    if (win && !win.isFocused() && !win.isMinimized()) {
      if (process.platform === 'win32') win.flashFrame(true);
      else win.setBadge?.('•');
    }
    return true;
  });
  handle('notify:clear', () => {
    if (win && process.platform === 'darwin') win.setBadge?.('');
    if (win && process.platform === 'win32') win.flashFrame(false);
  });

  /* --- app -------------------------------------------------------------- */
  handle('app:reset', async () => {
    store.flushSync();
    const dir = app.getPath('userData');
    for (const sub of ['chats', 'files', 'incoming']) {
      await fsp.rm(path.join(dir, sub), { recursive: true, force: true });
    }
    for (const f of ['profile.json', 'contacts.json', 'settings.json']) {
      await fsp.rm(path.join(dir, f), { force: true });
    }
    store.cache.clear();
    store.dirty.clear();
    if (discovery) discovery.stop();
    win.webContents.reload();
    return true;
  });
  handle('app:openUserData', () => shell.openPath(app.getPath('userData')));
  handle('app:autostart', (enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin;
  });
  handle('app:autostartState', () => app.getLoginItemSettings().openAtLogin);

  /* --- discovery events ------------------------------------------------- */
  discovery.on('peer', (peer, isNew) => send('net:peer', { peer, isNew }));
  discovery.on('bye', (id) => send('net:bye', id));
  discovery.on('signal', (msg, rinfo) => {
    send('net:signal', msg);
  });
  discovery.on('warn', (message) => send('net:warn', message));
  discovery.on('ready', (info) => send('net:ready', info));
}
