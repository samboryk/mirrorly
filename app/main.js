'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, powerSaveBlocker, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { AirPlayReceiver } = require('./receiver/airplay');
const { Updater } = require('./updater');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('ua.nersi.mirrorly');
// Keep decoding smooth when the window is in the background.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const isTest = process.env.MIRRORLY_TEST === '1';
const userDir = isTest ? path.join(os.tmpdir(), 'mirrorly-test') : app.getPath('userData');
const settingsFile = path.join(userDir, 'settings.json');
const logFile = path.join(userDir, 'mirrorly.log');

// ---------------- settings ----------------
const DEFAULTS = {
  name: '',
  quality: '1080',     // 1080 | 720 | 1440
  fps: 60,             // 60 | 30
  audio: true,
  askPermission: true,
  trusted: [],         // [{ deviceId, name }]
  alwaysOnTop: false,
  autoFullscreen: false,
  launchAtLogin: false,
  closeToTray: true,
  trayHintShown: false,
  autoUpdate: true,
  deviceId: '',
  edKey: '',
};
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch (_) { settings = { ...DEFAULTS }; }
  if (!settings.name) settings.name = defaultName();
  if (!/^[0-9a-f]{12}$/.test(settings.deviceId)) {
    const b = crypto.randomBytes(6);
    b[0] = (b[0] | 0x02) & 0xfe; // locally administered, unicast
    settings.deviceId = b.toString('hex');
  }
}
function saveSettings() {
  try { fs.mkdirSync(userDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { log('Не вдалося зберегти налаштування: ' + e.message); }
}
function defaultName() {
  const host = (os.hostname() || 'Windows').replace(/\.local$/i, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim();
  return host || 'Windows PC';
}
function cleanName(s) {
  return String(s || '').replace(/[.@\\]/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
}

// ---------------- logging ----------------
const logLines = [];
function log(msg) {
  const line = `[${new Date().toLocaleTimeString('uk-UA')}] ${msg}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  if (isTest || process.env.MIRRORLY_DEBUG) console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch (_) { /* ignore */ }
  send('log', line);
}

// ---------------- window ----------------
let win = null;
let tray = null;
let receiver = null;
let quitting = false;
let streaming = false;
let updater = null;
let blockerId = -1;
let idleBounds = null;
let pendingApproval = null;

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function iconPath(name) { return path.join(__dirname, 'assets', name); }

function createWindow() {
  const isWin = process.platform === 'win32';
  win = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 360,
    minHeight: 560,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: isWin ? { color: '#00000000', symbolColor: '#ffffff', height: 40 } : false,
    backgroundColor: '#0b0b12',
    title: 'Mirrorly',
    icon: iconPath('icon.png'),
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!(process.argv.includes('--hidden') && settings.closeToTray)) win.show();
  });
  win.on('close', e => {
    if (!quitting && settings.closeToTray && !isTest) {
      e.preventDefault();
      if (win.isFullScreen()) win.setFullScreen(false);
      win.hide();
      if (!settings.trayHintShown && Notification.isSupported()) {
        new Notification({ title: 'Mirrorly працює у фоні', body: 'Іконка — у системному треї. Щоб закрити повністю, оберіть «Вийти» в меню іконки.', icon: iconPath('icon.png') }).show();
        settings.trayHintShown = true; saveSettings();
      }
    }
  });
  win.on('enter-full-screen', () => send('fullscreen', true));
  win.on('leave-full-screen', () => send('fullscreen', false));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath(process.platform === 'win32' ? 'tray.ico' : 'icon.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Mirrorly — повтор екрана iPhone');
  tray.on('click', showWindow);
  updateTrayMenu();
}
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Відкрити Mirrorly', click: showWindow },
    ...(updater && updater.state.status === 'ready' ? [{ label: `Встановити оновлення ${updater.state.version}`, click: () => installUpdate() }] : []),
    { label: streaming ? 'Відключити iPhone' : 'Очікування підключення…', enabled: streaming, click: () => receiver && receiver.disconnect() },
    { type: 'separator' },
    { label: 'Поверх інших вікон', type: 'checkbox', checked: settings.alwaysOnTop, click: m => applySetting('alwaysOnTop', m.checked) },
    { label: 'Запускати разом з Windows', type: 'checkbox', checked: settings.launchAtLogin, click: m => applySetting('launchAtLogin', m.checked) },
    { type: 'separator' },
    { label: 'Вийти', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------------- window sizing for the phone picture ----------------
function fitWindowToVideo(w, h) {
  if (!win || win.isFullScreen() || win.isMaximized() || !w || !h) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const area = display.workArea;
  const maxW = Math.floor(area.width * 0.9), maxH = Math.floor(area.height * 0.9);
  let height = Math.min(maxH, h >= w ? 900 : 640);
  let width = Math.round(height * w / h);
  if (width > maxW) { width = maxW; height = Math.round(width * h / w); }
  const b = win.getBounds();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  let x = Math.round(cx - width / 2), y = Math.round(cy - height / 2);
  x = Math.max(area.x, Math.min(x, area.x + area.width - width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  win.setMinimumSize(200, 200);
  win.setAspectRatio(w / h);
  win.setBounds({ x, y, width, height }, true);
}
function restoreIdleWindow() {
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  win.setAspectRatio(0);
  win.setMinimumSize(360, 560);
  if (idleBounds) win.setBounds(idleBounds, true);
  idleBounds = null;
}

// ---------------- receiver ----------------
function qualitySize() {
  if (settings.quality === '720') return { width: 1280, height: 720 };
  if (settings.quality === '1440') return { width: 2560, height: 1440 };
  return { width: 1920, height: 1080 };
}

function approve(info) {
  if (!settings.askPermission) return Promise.resolve(true);
  if (settings.trusted.some(t => t.deviceId === info.deviceId)) return Promise.resolve(true);
  return new Promise(resolve => {
    if (pendingApproval) pendingApproval.resolve(false);
    const id = crypto.randomBytes(4).toString('hex');
    const timer = setTimeout(() => finish(false, false), 30000);
    const finish = (ok, remember) => {
      if (!pendingApproval || pendingApproval.id !== id) return;
      clearTimeout(timer);
      pendingApproval = null;
      send('approval-close', id);
      if (ok && remember && info.deviceId) {
        settings.trusted = settings.trusted.filter(t => t.deviceId !== info.deviceId).concat([{ deviceId: info.deviceId, name: info.name }]);
        saveSettings();
        sendSettings();
      }
      resolve(ok);
    };
    pendingApproval = { id, resolve: ok => finish(ok, false), finish };
    showWindow();
    if (win) win.flashFrame(true);
    send('approval', { id, name: info.name, model: info.model, address: info.address });
  });
}

async function startReceiver() {
  const { width, height } = qualitySize();
  receiver = new AirPlayReceiver({
    name: settings.name,
    deviceId: Buffer.from(settings.deviceId, 'hex'),
    edKey: settings.edKey,
    width, height,
    fps: settings.fps,
    approve,
  });
  if (receiver.edKeyExport !== settings.edKey) { settings.edKey = receiver.edKeyExport; saveSettings(); }
  receiver.on('log', log);
  receiver.on('session-start', info => {
    streaming = true;
    if (win && !idleBounds) idleBounds = win.getBounds();
    send('session-start', info);
    updateTrayMenu();
    if (blockerId < 0) blockerId = powerSaveBlocker.start('prevent-display-sleep');
    if (win && !win.isVisible()) showWindow();
  });
  receiver.on('session-end', info => {
    streaming = false;
    send('session-end', info);
    restoreIdleWindow();
    updateTrayMenu();
    if (blockerId >= 0) { powerSaveBlocker.stop(blockerId); blockerId = -1; }
  });
  receiver.on('video-config', cfg => {
    send('video-config', { avcc: new Uint8Array(cfg.avcc), width: cfg.width, height: cfg.height, codec: cfg.codec });
    if (settings.autoFullscreen && win && !win.isFullScreen()) win.setFullScreen(true);
  });
  receiver.on('video-frame', f => send('video-frame', { data: new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.length), key: f.key, ts: f.ts }));
  receiver.on('video-pause', () => send('video-pause'));
  receiver.on('video-resume', () => send('video-resume'));
  receiver.on('audio', pcm => { if (settings.audio) send('audio', pcm); });
  receiver.on('volume', v => send('volume', v));
  try {
    await receiver.start();
  } catch (e) {
    log('Помилка запуску: ' + e.message);
    send('fatal', e.message);
  }
  sendStatus();
}

function networkInfo() {
  const list = receiver ? receiver.addresses() : [];
  return list.map(a => ({ ifname: a.ifname, address: a.address }));
}
function sendStatus() { send('status', { name: settings.name, port: receiver ? receiver.port : 0, network: networkInfo(), streaming }); }
function sendSettings() { send('settings', publicSettings()); }
function publicSettings() {
  const { edKey, deviceId, ...rest } = settings; // keep the private key out of the renderer
  return { ...rest, version: app.getVersion(), platform: process.platform };
}

function applySetting(key, value) {
  if (!(key in DEFAULTS) || key === 'edKey' || key === 'deviceId') return;
  if (key === 'name') {
    value = cleanName(value) || defaultName();
    settings.name = value;
    if (receiver) receiver.rename(value);
    sendStatus();
  } else if (key === 'alwaysOnTop') {
    settings.alwaysOnTop = !!value;
    if (win) win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  } else if (key === 'launchAtLogin') {
    settings.launchAtLogin = !!value;
    if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ['--hidden'] });
  } else if (key === 'quality' || key === 'fps') {
    settings[key] = key === 'fps' ? (Number(value) === 30 ? 30 : 60) : (['720', '1080', '1440'].includes(String(value)) ? String(value) : '1080');
    if (receiver) { const q = qualitySize(); receiver.opts.width = q.width; receiver.opts.height = q.height; receiver.opts.fps = settings.fps; }
  } else if (key === 'trusted') {
    settings.trusted = Array.isArray(value) ? value.filter(t => t && typeof t.deviceId === 'string') : [];
  } else {
    settings[key] = typeof DEFAULTS[key] === 'boolean' ? !!value : value;
  }
  saveSettings();
  sendSettings();
  updateTrayMenu();
}

// ---------------- IPC ----------------
ipcMain.handle('init', () => ({ update: updater ? updater.state : null, settings: publicSettings(), status: { name: settings.name, port: receiver ? receiver.port : 0, network: networkInfo(), streaming }, log: logLines.slice(-200) }));
ipcMain.on('set', (_e, { key, value }) => applySetting(key, value));
ipcMain.on('approval-answer', (_e, { id, ok, remember }) => { if (pendingApproval && pendingApproval.id === id) pendingApproval.finish(!!ok, !!remember); });
ipcMain.on('disconnect', () => receiver && receiver.disconnect());
ipcMain.on('toggle-fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
ipcMain.on('exit-fullscreen', () => { if (win && win.isFullScreen()) win.setFullScreen(false); });
ipcMain.on('fit-video', (_e, { width, height }) => fitWindowToVideo(width, height));
ipcMain.on('minimize', () => win && win.minimize());
ipcMain.on('close', () => win && win.close());
ipcMain.on('open-log', () => shell.openPath(logFile));
ipcMain.on('update-check', () => updater && updater.check(true, true));
ipcMain.on('update-install', () => installUpdate());

function installUpdate() {
  if (!updater) return;
  if (updater.install()) {
    log(`Встановлення оновлення ${updater.state.version}…`);
    send('update-installing');
  } else if (process.platform !== 'win32') {
    log('Оновлення встановлюється лише на Windows');
  }
}

function startUpdater() {
  updater = new Updater();
  updater.on('state', st => {
    send('update', st);
    updateTrayMenu();
    if (st.status === 'error' && st.manual) log('Оновлення: ' + st.error);
    if (st.status === 'ready' && !win.isVisible() && Notification.isSupported()) {
      const n = new Notification({ title: `Mirrorly ${st.version} готова`, body: 'Натисніть, щоб оновити програму.', icon: iconPath('icon.png') });
      n.on('click', () => { showWindow(); });
      n.show();
    }
  });
  const auto = () => { if (settings.autoUpdate) updater.check(false, true); };
  setTimeout(auto, isTest ? 1500 : 15000);
  setInterval(auto, 6 * 60 * 60 * 1000);
}
ipcMain.handle('save-screenshot', async (_e, data) => {
  const dir = path.join(app.getPath('pictures'), 'Mirrorly');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const file = path.join(dir, `Знімок ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}.png`);
  fs.writeFileSync(file, Buffer.from(data));
  return file;
});
ipcMain.on('show-file', (_e, file) => { if (typeof file === 'string' && fs.existsSync(file)) shell.showItemInFolder(file); });

// ---------------- app lifecycle ----------------
app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; if (receiver) receiver.stop(); });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  loadSettings();
  saveSettings();
  if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ['--hidden'] });
  createWindow();
  if (!isTest) createTray();
  await startReceiver();
  if (!isTest || process.env.MIRRORLY_UPDATE_API) startUpdater();
  if (isTest && process.env.MIRRORLY_TEST_HOOK) require(process.env.MIRRORLY_TEST_HOOK)({ app, win, receiver, settings, send, applySetting });
});
