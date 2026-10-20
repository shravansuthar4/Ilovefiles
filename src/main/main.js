// I love files runs in the background only (menu bar / system tray). There is no main window:
// drag any file, press C, and a translucent ring of formats appears around it. Move the file
// onto a format (it turns blue) and let go: the converted copy appears next to the original.
const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage, Notification, systemPreferences,
} = require('electron');
const sharp = require('sharp');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { FORMATS, fromMime } = require('./formats');
const { detect, convert, targetsFor, hasLibreOffice } = require('./converter');
const dragSource = require('./drag-source');

const isMac = process.platform === 'darwin';
const RING_SIZE = 480; // the overlay is a square window centred on the cursor
const LIBREOFFICE_URL = 'https://www.libreoffice.org/download/download/';

// DC_DEBUG=1 npm start  -> logs every step of drag + C detection
const debug = process.env.DC_DEBUG ? (...a) => console.log('[dc]', ...a) : () => {};

let overlay = null;
let tray = null;
let hookRunning = false;
const recent = [];
const active = new Map(); // conversions in progress: id -> progress 0..1

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

// ---------- global drag tracking ----------
// On macOS, once Finder starts a drag it stops telling other apps about mouse moves, the release,
// and the drag itself (our window gets no drop events). So everything is tracked here instead:
// the dragged files come from the drag pasteboard, the cursor is polled, and the release is
// watched. Windows reports drags normally; the same flow is used there for consistency.
const drag = { buttonDown: false, moving: false };
let cHeld = false; // ignore key auto-repeat while C is held down

// The drag the ring was opened for, until the mouse button is released.
// { files: [paths], hovered: target id or null }
let session = null;

function startHook() {
  if (hookRunning) return;
  if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) return;

  uIOhook.on('mousedown', (e) => {
    if (e.button === 1) { drag.buttonDown = true; drag.moving = false; }
  });
  uIOhook.on('mousedrag', () => {
    if (drag.buttonDown) drag.moving = true;
  });
  uIOhook.on('mouseup', (e) => {
    if (e.button !== 1) return;
    drag.buttonDown = false;
    drag.moving = false;
    if (session) released();
    else dragSource.resetBaseline(); // a plain click: remember the idle drag-pasteboard state
  });
  uIOhook.on('keyup', (e) => {
    if (e.keycode === UiohookKey.C) cHeld = false;
  });
  uIOhook.on('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.keycode === UiohookKey.Escape) return closeOverlay();
    if (e.keycode !== UiohookKey.C || cHeld) return;
    cHeld = true;
    debug('C pressed, buttonDown=' + drag.buttonDown, 'moving=' + drag.moving);
    if (overlay.isVisible()) return closeOverlay();
    // macOS may not have reported the mouse-down that started a Finder drag; the probe checks for real.
    if (isMac || drag.buttonDown) openForCurrentDrag();
  });

  try {
    uIOhook.start();
    hookRunning = true;
    debug('input hook started');
  } catch (err) {
    console.error('Could not start global input hook:', err);
  }
  updateTray();
}

let opening = false;

async function openForCurrentDrag() {
  if (opening) return;
  opening = true;
  try {
    const probe = await dragSource.probe();
    debug('probe', probe);
    if (probe.buttonDown === false) return; // just typing a "c"
    // Pressing C again in the same drag (after closing the ring) reuses what was found the first time.
    const files = probe.files.length ? probe.files : (session ? session.files : []);
    // Nothing identifiable and no sign of an actual drag: probably just a held click.
    if (!files.length && !drag.moving) return;
    session = { files, hovered: null };
    if (probe.buttonDown) dragSource.watchRelease(() => { if (session) released(); });
    await showOverlay(files);
  } finally {
    opening = false;
  }
}

// ---------- overlay ----------
function createOverlay() {
  overlay = new BrowserWindow({
    width: RING_SIZE,
    height: RING_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,     // never steal focus from the app the drag started in
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true, // the ring may hang off a screen edge
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js') },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, '../renderer/overlay.html'));
}

let cursorTimer = null;
let origin = { x: 0, y: 0 };

async function showOverlay(files) {
  const c = screen.getCursorScreenPoint();
  origin = { x: Math.round(c.x - RING_SIZE / 2), y: Math.round(c.y - RING_SIZE / 2) };
  overlay.setBounds({ ...origin, width: RING_SIZE, height: RING_SIZE });
  // If the files are unknown (e.g. a drag from the Windows desktop), the ring fills in once the drag enters it.
  overlay.webContents.send('overlay:shown', files.length ? await describe(files) : null);
  overlay.showInactive();

  // Follow the cursor so the ring can light up the format under it.
  clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    overlay.webContents.send('overlay:cursor', { x: p.x - origin.x, y: p.y - origin.y });
  }, 16);
}

function closeOverlay() {
  clearInterval(cursorTimer);
  cursorTimer = null;
  if (session) session.hovered = null;
  if (overlay && overlay.isVisible()) overlay.hide();
}

async function describe(files) {
  const id = await detect(files[0]);
  const { targets, moreWithLibreOffice } = targetsFor(id);
  return {
    format: id ? FORMATS[id].label : null,
    name: files.length === 1 ? path.basename(files[0]) : `${files.length} files`,
    targets,
    moreWithLibreOffice,
  };
}

// The mouse button went up: convert if the file was let go over a format.
async function released() {
  const s = session;
  session = null;
  dragSource.resetBaseline();
  clearInterval(cursorTimer);
  cursorTimer = null;
  debug('released over', s && s.hovered);
  if (!overlay.isVisible() || !s || !s.hovered) return closeOverlay();

  if (s.hovered === 'libreoffice') {
    shell.openExternal(LIBREOFFICE_URL);
    return closeOverlay();
  }
  // Files not identified up front: use the paths from the drop itself, if it reached the ring.
  const files = s.files.length ? s.files : await waitForDrop(600);
  if (!files.length) return closeOverlay();
  runConversion(files, s.hovered);
}

let dropWaiter = null;
let droppedPaths = null;

function waitForDrop(ms) {
  if (droppedPaths) { const p = droppedPaths; droppedPaths = null; return Promise.resolve(p); }
  return new Promise((resolve) => {
    dropWaiter = resolve;
    setTimeout(() => { if (dropWaiter === resolve) { dropWaiter = null; resolve([]); } }, ms);
  });
}

async function runConversion(files, target) {
  const label = FORMATS[target].label;
  overlay.webContents.send('overlay:status', { state: 'working', target, label });

  // Big files (videos) keep converting after the ring closes; a notification reports the result.
  let backgrounded = false;
  const slow = setTimeout(() => { backgrounded = true; closeOverlay(); }, 1500);

  const results = await convertAll(files, target);
  clearTimeout(slow);
  const ok = results.filter((r) => r.output);
  const message = ok.length === 1
    ? `Saved ${path.basename(ok[0].output)}${ok[0].count > 1 ? ` (+${ok[0].count - 1} pages)` : ''}`
    : ok.length ? `${ok.length} files converted to ${label}` : (results[0] ? results[0].error : 'Nothing to convert');

  if (backgrounded || !overlay.isVisible()) {
    notify(ok.length ? 'Converted' : 'Conversion failed', message, ok[0] && ok[0].output);
  } else {
    overlay.webContents.send('overlay:status', { state: ok.length ? 'done' : 'error', target, label, message });
    setTimeout(closeOverlay, ok.length ? 1100 : 2200);
  }
}

// ---------- tray ----------
// A heart, matching the app icon.
const TRAY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <path d="M16 27C10 22.5 4.5 18.5 4.5 12.5a6.5 6.5 0 0 1 11.5-4.2 6.5 6.5 0 0 1 11.5 4.2C27.5 18.5 22 22.5 16 27z"
    fill="none" stroke="#000" stroke-width="2.8" stroke-linejoin="round"/></svg>`;

async function createTray() {
  const svg = isMac ? TRAY_SVG : TRAY_SVG.replace('fill="none" stroke="#000"', 'fill="#ff4f7e" stroke="#ff4f7e"');
  const icon = nativeImage.createFromBuffer(await sharp(Buffer.from(svg)).png().toBuffer(), { scaleFactor: 2 });
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const needsPermission = isMac && !hookRunning;
  const openAtLogin = app.getLoginItemSettings().openAtLogin;

  const items = [
    { label: needsPermission ? '⚠︎ Needs Accessibility permission' : 'Drag any file and press C', enabled: false },
  ];
  if (needsPermission) {
    items.push({ label: 'Grant Permission…', click: requestPermission });
  }
  if (active.size) {
    const pct = Math.round(([...active.values()].reduce((a, b) => a + b, 0) / active.size) * 100);
    items.push({ label: `Converting ${active.size} file(s)… ${pct}%`, enabled: false });
  }
  if (recent.length) {
    items.push({ type: 'separator' }, { label: 'Recent', enabled: false });
    for (const r of recent) items.push({ label: path.basename(r), click: () => shell.showItemInFolder(r) });
  }
  items.push({ type: 'separator' });
  if (!hasLibreOffice()) {
    items.push({ label: 'Get LibreOffice for more document formats…', click: () => shell.openExternal(LIBREOFFICE_URL) });
  }
  items.push(
    { label: 'Open at Login', type: 'checkbox', checked: openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: 'Quit I love files', click: () => app.quit() },
  );

  tray.setContextMenu(Menu.buildFromTemplate(items));
  const status = active.size ? `${Math.round(([...active.values()].reduce((a, b) => a + b, 0) / active.size) * 100)}%` : '';
  if (isMac) tray.setTitle(status);
  tray.setToolTip(status ? `I love files — converting ${status}` : 'I love files — drag any file and press C');
}

// ---------- permissions (macOS) ----------
// Listening to the C key while Finder owns the drag needs Accessibility permission.
function requestPermission() {
  systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS prompt
  waitForPermission();
}

let permissionTimer = null;
function waitForPermission() {
  if (permissionTimer) return;
  permissionTimer = setInterval(() => {
    if (systemPreferences.isTrustedAccessibilityClient(false)) {
      clearInterval(permissionTimer);
      permissionTimer = null;
      startHook();
      notify('I love files is ready', 'Drag any file and press C to convert it.');
    }
  }, 2000);
}

// ---------- conversions ----------
function notify(title, body, file) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (file) n.on('click', () => shell.showItemInFolder(file));
  n.show();
}

async function convertAll(paths, target) {
  const results = [];
  for (const input of paths) {
    const id = Symbol(input);
    active.set(id, 0);
    updateTray();
    let lastUpdate = 0;
    try {
      const output = await convert(input, target, (p) => {
        active.set(id, p);
        if (Date.now() - lastUpdate > 500) { lastUpdate = Date.now(); updateTray(); }
      });
      const outputs = Array.isArray(output) ? output : [output];
      recent.unshift(...outputs);
      recent.splice(8);
      results.push({ input, output: outputs[0], count: outputs.length });
    } catch (err) {
      results.push({ input, error: err.message });
    } finally {
      active.delete(id);
      updateTray();
    }
  }
  return results;
}


// ---------- IPC from the ring ----------
ipcMain.on('overlay:hover', (_e, target) => {
  if (session) session.hovered = target;
});

// Where the OS does deliver the drop to the ring (Windows), it carries the real paths and
// also marks the release in case the mouse-up wasn't reported.
ipcMain.on('overlay:drop', (_e, paths) => {
  if (dropWaiter) { dropWaiter(paths); dropWaiter = null; return; }
  if (session) {
    if (!session.files.length) session.files = paths;
    released();
  } else {
    droppedPaths = paths;
    setTimeout(() => { droppedPaths = null; }, 1000);
  }
});

// Fallback identification from the drag itself, once it enters the ring.
ipcMain.handle('targets:mime', (_e, mime) => {
  const id = fromMime(mime);
  const { targets, moreWithLibreOffice } = targetsFor(id);
  return { format: id ? FORMATS[id].label : null, name: null, targets, moreWithLibreOffice };
});

async function selfTest(dir) {
  const lines = [];
  for (const name of fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'report.txt')) {
    const input = path.join(dir, name);
    const id = await detect(input);
    for (const t of targetsFor(id).targets) {
      try {
        const out = await convert(input, t.id);
        lines.push(`OK   ${name} -> ${t.id}: ${[].concat(out).map((o) => path.basename(o)).join(', ')}`);
      } catch (err) {
        lines.push(`FAIL ${name} -> ${t.id}: ${err.message}`);
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'report.txt'), lines.join('\n') + '\n');
  app.exit(0);
}

// ---------- lifecycle ----------
if (process.env.ILF_SELFTEST) {
  // ILF_SELFTEST=<folder>: convert every file in the folder to each target, write a report, quit.
  // Used to check an installed build end to end; runs alongside a normal running copy.
  if (isMac) app.dock.hide();
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => selfTest(process.env.ILF_SELFTEST));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (isMac) app.dock.hide();

  app.whenReady().then(async () => {
    createOverlay();
    await createTray();
    dragSource.warmUp();

    // First launch of the installed app: start automatically at login from now on.
    const settings = readSettings();
    if (!settings.firstRunDone) {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
      writeSettings({ ...settings, firstRunDone: true });
      updateTray();
    }

    startHook();
    if (!hookRunning && isMac) requestPermission();
    else if (!settings.firstRunDone) notify('I love files is running', 'Drag any file and press C to convert it.');
  });

  app.on('before-quit', () => {
    if (hookRunning) uIOhook.stop();
    dragSource.stop();
  });
  // No windows to close; the app lives in the tray.
  app.on('window-all-closed', () => {});
}
