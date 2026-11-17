'use strict';
/* global mirrorly, VideoDecoder, EncodedVideoChunk */
const $ = s => document.querySelector(s);
const body = document.body;
const api = window.mirrorly;

let settings = {};
let status = {};
let deviceName = 'iPhone';

// ======================= UI helpers =======================
let islandTimer = null;
function island(text, { warn = false, ms = 2600, onClick = null } = {}) {
  const el = $('#island');
  $('#island-text').textContent = text;
  $('#island-ico').innerHTML = `<use href="#${warn ? 'i-wifi' : 'i-check'}"/>`;
  el.classList.toggle('warn', warn);
  el.onclick = onClick;
  el.classList.add('show');
  clearTimeout(islandTimer);
  islandTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function setName(name) {
  $('#hero-name').textContent = name;
  $('#step-name').textContent = name;
  if (document.activeElement !== $('#s-name')) $('#s-name').value = name;
}

function renderNetwork(net) {
  const dot = $('#net-dot');
  if (!net || !net.length) {
    dot.className = 'dot bad';
    $('#net-text').textContent = 'Немає підключення до мережі';
    return;
  }
  dot.className = 'dot ok';
  const main = net[0];
  const extra = net.length > 1 ? ` +${net.length - 1}` : '';
  $('#net-text').textContent = `${main.address}${extra} · iPhone має бути в цій самій мережі`;
}

function renderSettings() {
  document.querySelectorAll('.switch[data-key]').forEach(sw => {
    const on = !!settings[sw.dataset.key];
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-checked', on);
  });
  setSegment('#s-quality', String(settings.quality));
  setSegment('#s-fps', String(settings.fps));
  $('#s-version').textContent = `Версія ${settings.version || ''}`;
  $('#c-pin').classList.toggle('on', !!settings.alwaysOnTop);
  const list = $('#trusted-list');
  list.innerHTML = '';
  for (const t of settings.trusted || []) {
    const row = document.createElement('div');
    row.className = 'row';
    const left = document.createElement('span');
    left.className = 'row-label trusted';
    left.innerHTML = '<svg><use href="#i-phone"/></svg>';
    const nm = document.createElement('span');
    nm.textContent = t.name || t.deviceId;
    left.appendChild(nm);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Забути';
    del.onclick = () => api.set('trusted', settings.trusted.filter(x => x.deviceId !== t.deviceId));
    row.append(left, del);
    list.appendChild(row);
  }
}

function setSegment(sel, value) {
  const seg = $(sel);
  const btns = [...seg.querySelectorAll('button')];
  const i = Math.max(0, btns.findIndex(b => b.dataset.v === value));
  btns.forEach((b, j) => b.classList.toggle('sel', j === i));
  const thumb = seg.querySelector('.seg-thumb');
  thumb.style.width = `calc((100% - 4px) / ${btns.length})`;
  thumb.style.transform = `translateX(${i * 100}%)`;
}

// ======================= settings sheet =======================
$('#open-settings').onclick = () => body.classList.add('sheet-open');
$('#close-settings').onclick = () => { $('#s-name').blur(); body.classList.remove('sheet-open'); };
$('#sheet-backdrop').onclick = () => body.classList.remove('sheet-open');
document.querySelectorAll('.switch[data-key]').forEach(sw => {
  sw.onclick = () => { settings[sw.dataset.key] = !settings[sw.dataset.key]; renderSettings(); api.set(sw.dataset.key, settings[sw.dataset.key]); };
});
for (const [sel, key] of [['#s-quality', 'quality'], ['#s-fps', 'fps']]) {
  $(sel).querySelectorAll('button').forEach(b => {
    b.onclick = () => { settings[key] = key === 'fps' ? Number(b.dataset.v) : b.dataset.v; renderSettings(); api.set(key, settings[key]); };
  });
}
const nameInput = $('#s-name');
nameInput.addEventListener('change', () => api.set('name', nameInput.value));
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); if (e.key === 'Escape') { nameInput.value = status.name; nameInput.blur(); } });
$('#s-log').onclick = () => {
  const box = $('#log-box');
  box.classList.toggle('show');
  if (box.classList.contains('show')) box.scrollIntoView({ behavior: 'smooth', block: 'end' });
};
$('#s-log').addEventListener('dblclick', () => api.openLog());
function appendLog(line) {
  const box = $('#log-box');
  box.textContent += (box.textContent ? '\n' : '') + line;
  if (box.textContent.length > 60000) box.textContent = box.textContent.slice(-40000);
  box.scrollTop = box.scrollHeight;
}

$('#btn-min').onclick = () => api.minimize();
$('#btn-close').onclick = () => api.close();

// ======================= approval alert =======================
let alertId = null;
let remember = true;
function openAlert(a) {
  alertId = a.id;
  remember = true;
  $('#alert-remember').classList.add('on');
  $('#alert-name').textContent = `«${a.name}»`;
  $('#alert-backdrop').classList.add('show');
  $('#alert-allow').focus();
}
function closeAlert() { $('#alert-backdrop').classList.remove('show'); alertId = null; }
$('#alert-remember').onclick = () => { remember = !remember; $('#alert-remember').classList.toggle('on', remember); };
$('#alert-allow').onclick = () => { if (alertId) api.answer(alertId, true, remember); closeAlert(); };
$('#alert-deny').onclick = () => { if (alertId) api.answer(alertId, false, false); closeAlert(); };

// ======================= video =======================
const canvas = $('#screen');
const ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
let decoder = null;
let videoCfg = null;
let needKey = true;
let pendingFrame = null;
let rafQueued = false;
let frameCounter = 0;
let fpsCount = 0;
let lastFitKey = '';
let chunkTs = 0;

function resetDecoder() {
  if (decoder) { try { decoder.close(); } catch (_) { /* closed */ } }
  decoder = null;
  needKey = true;
}

async function configureDecoder(cfg) {
  resetDecoder();
  videoCfg = cfg;
  const base = { codec: cfg.codec, description: cfg.avcc, optimizeForLatency: true };
  let config = { ...base, hardwareAcceleration: 'prefer-hardware' };
  try {
    const sup = await VideoDecoder.isConfigSupported(config);
    if (!sup.supported) config = { ...base, hardwareAcceleration: 'no-preference' };
  } catch (_) { config = { ...base }; }
  if (videoCfg !== cfg) return; // superseded meanwhile
  decoder = new VideoDecoder({
    output: frame => {
      if (pendingFrame) pendingFrame.close();
      pendingFrame = frame;
      if (!rafQueued) { rafQueued = true; requestAnimationFrame(draw); }
    },
    error: e => {
      console.warn('decoder error', e);
      // Recreate on the next config/key frame.
      const c = videoCfg; resetDecoder(); if (c) configureDecoder(c);
    },
  });
  try { decoder.configure(config); } catch (e) { console.warn(e); island('Не вдалося запустити декодер відео', { warn: true }); }
}

function draw() {
  rafQueued = false;
  const f = pendingFrame;
  pendingFrame = null;
  if (!f) return;
  if (document.hidden) { f.close(); return; }
  const w = f.displayWidth, h = f.displayHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx2d.drawImage(f, 0, 0, w, h);
  f.close();
  fpsCount++;
  if (!body.classList.contains('has-video')) { body.classList.add('has-video'); showHud(); }
  const key = `${w}x${h}`;
  if (key !== lastFitKey) { lastFitKey = key; api.fitVideo(w, h); $('#res').textContent = `${w}×${h}`; }
}

setInterval(() => { $('#fps').textContent = `${fpsCount} к/с`; fpsCount = 0; }, 1000);

function onVideoFrame(f) {
  if (!decoder || decoder.state !== 'configured') return;
  if (needKey && !f.key) return;
  // If the decoder falls behind (slow PC), skip ahead to the next key frame.
  if (decoder.decodeQueueSize > 12 && !f.key) { needKey = true; return; }
  needKey = false;
  chunkTs += 16667;
  try {
    decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: chunkTs, data: f.data }));
    frameCounter++;
  } catch (e) { console.warn(e); needKey = true; }
}

// ======================= audio =======================
let audioCtx = null, audioNode = null, gainNode = null, muted = false, remoteVolume = 0;
async function ensureAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    await audioCtx.audioWorklet.addModule('audio-worklet.js');
    audioNode = new AudioWorkletNode(audioCtx, 'pcm-player', { outputChannelCount: [2] });
    gainNode = audioCtx.createGain();
    audioNode.connect(gainNode).connect(audioCtx.destination);
    applyGain();
  } catch (e) { console.warn('audio init failed', e); audioCtx = null; }
}
function applyGain() {
  if (!gainNode) return;
  // AirPlay volume: 0 dB = max, -30 dB = min, -144 = mute.
  let g = remoteVolume <= -100 ? 0 : Math.pow(10, Math.max(-30, Math.min(0, remoteVolume)) / 20 * 1.5);
  if (remoteVolume <= -30) g = 0;
  if (muted) g = 0;
  gainNode.gain.setTargetAtTime(g, audioCtx.currentTime, 0.05);
}
$('#c-mute').onclick = () => {
  muted = !muted;
  $('#c-mute').classList.toggle('on', muted);
  $('#c-mute').innerHTML = `<svg><use href="#${muted ? 'i-mute' : 'i-speaker'}"/></svg>`;
  applyGain();
};

// ======================= stream controls / HUD =======================
let hudTimer = null;
function showHud() {
  body.classList.add('hud-on');
  body.classList.remove('hud-off');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => {
    if ($('#stream-controls').matches(':hover')) return showHud();
    body.classList.remove('hud-on');
    body.classList.add('hud-off');
  }, 2600);
}
$('#stream-view').addEventListener('mousemove', showHud);
$('#stream-view').addEventListener('mouseleave', () => { clearTimeout(hudTimer); body.classList.remove('hud-on'); });
canvas.addEventListener('dblclick', () => api.toggleFullscreen());
$('#c-full').onclick = () => api.toggleFullscreen();
$('#c-stop').onclick = () => api.disconnect();
$('#c-pin').onclick = () => { settings.alwaysOnTop = !settings.alwaysOnTop; renderSettings(); api.set('alwaysOnTop', settings.alwaysOnTop); island(settings.alwaysOnTop ? 'Поверх інших вікон' : 'Звичайне вікно'); };
$('#c-shot').onclick = () => {
  if (!body.classList.contains('has-video')) return;
  canvas.toBlob(async blob => {
    if (!blob) return;
    const file = await api.saveScreenshot(new Uint8Array(await blob.arrayBuffer()));
    island('Знімок збережено · показати', { onClick: () => api.showFile(file) });
  }, 'image/png');
};
document.addEventListener('keydown', e => {
  if (e.target && e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') {
    if ($('#alert-backdrop').classList.contains('show')) return $('#alert-deny').click();
    if (body.classList.contains('sheet-open')) return body.classList.remove('sheet-open');
    api.exitFullscreen();
  }
  if (!body.classList.contains('streaming')) return;
  if (e.key === 'F11' || (e.key === 'f' && !e.ctrlKey)) { e.preventDefault(); api.toggleFullscreen(); }
  if (e.key === 'm') $('#c-mute').click();
  if (e.key === 's' && e.ctrlKey) { e.preventDefault(); $('#c-shot').click(); }
});

// ======================= wiring =======================
api.on('status', s => { status = s; setName(s.name); renderNetwork(s.network); });
api.on('settings', s => { settings = s; renderSettings(); });
api.on('log', appendLog);
api.on('fatal', msg => island('Помилка: ' + msg, { warn: true, ms: 8000 }));
api.on('approval', openAlert);
api.on('approval-close', id => { if (id === alertId) closeAlert(); });
api.on('fullscreen', on => {
  body.classList.toggle('fullscreen', on);
  $('#c-full').innerHTML = `<svg><use href="#${on ? 'i-shrink' : 'i-expand'}"/></svg>`;
});
api.on('session-start', info => {
  deviceName = info.name || 'iPhone';
  $('#connecting-name').textContent = deviceName;
  $('#stream-name').textContent = deviceName;
  body.classList.remove('sheet-open', 'has-video', 'paused');
  body.classList.add('streaming');
  body.classList.remove('idle');
  syncPause();
  lastFitKey = '';
  chunkTs = 0;
  island(`Підключено: ${deviceName}`);
  if (settings.audio) ensureAudio();
});
api.on('session-end', info => {
  resetDecoder();
  videoCfg = null;
  if (pendingFrame) { pendingFrame.close(); pendingFrame = null; }
  body.classList.remove('streaming', 'has-video', 'paused', 'hud-on', 'hud-off');
  body.classList.add('idle');
  syncPause();
  if (audioNode) audioNode.port.postMessage('flush');
  island(info && info.reason === 'local' ? 'Повтор екрана зупинено' : `${deviceName} відключено`, { warn: info && info.reason === 'timeout' });
});
api.on('video-config', cfg => configureDecoder(cfg));
api.on('video-frame', onVideoFrame);
api.on('video-pause', () => body.classList.add('paused'));
api.on('video-resume', () => body.classList.remove('paused'));
api.on('audio', pcm => {
  if (!audioCtx) { ensureAudio(); return; }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (audioNode) audioNode.port.postMessage(pcm, [pcm.buffer]);
});
api.on('volume', v => { remoteVolume = v; applyGain(); });

// ======================= updates =======================
let upd = null;
function renderUpdate(st) {
  upd = st;
  if (!st) return;
  const row = $('.upd-row'), btn = $('#u-action'), status = $('#u-status');
  row.classList.toggle('downloading', st.status === 'downloading');
  btn.disabled = ['checking', 'downloading'].includes(st.status);
  btn.classList.toggle('primary', st.status === 'ready');
  const when = st.checkedAt ? new Date(st.checkedAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : '';
  const map = {
    idle: ['Ще не перевірялось', 'Перевірити'],
    checking: ['Перевірка…', 'Перевірити'],
    uptodate: [`Встановлено найновішу версію${when ? ' · ' + when : ''}`, 'Перевірити'],
    available: [`Доступна версія ${st.version}`, 'Завантажити'],
    downloading: [`Завантаження ${st.version}… ${Math.round((st.progress || 0) * 100)}%`, 'Зачекайте'],
    ready: [`Версія ${st.version} готова`, 'Оновити'],
    error: [st.error || 'Не вдалося перевірити', 'Повторити'],
  };
  const [text, action] = map[st.status] || map.idle;
  status.textContent = text;
  btn.textContent = action;
  $('#u-progress i').style.width = `${Math.round((st.progress || 0) * 100)}%`;
  const banner = $('#upd-banner');
  const showBanner = st.status === 'ready' || st.status === 'available';
  banner.hidden = !showBanner;
  if (showBanner) {
    $('#upd-title').textContent = `Mirrorly ${st.version}`;
    $('#upd-sub').textContent = st.status === 'ready' ? 'Оновлення завантажено — готово до встановлення' : 'Доступне оновлення';
    $('#upd-go').textContent = st.status === 'ready' ? 'Оновити' : 'Завантажити';
  }
  $('#open-settings').classList.toggle('badge', showBanner);
}
function updateAction() {
  if (!upd) return api.checkUpdate();
  if (upd.status === 'ready') {
    if (settings.platform !== 'win32') return island('Оновлення встановлюється лише у Windows', { warn: true });
    island('Встановлення оновлення…', { ms: 6000 });
    api.installUpdate();
  } else api.checkUpdate();
}
$('#u-action').onclick = updateAction;
$('#upd-banner').onclick = updateAction;
api.on('update', renderUpdate);
api.on('update-installing', () => island('Підтвердіть встановлення у вікні Windows', { ms: 8000 }));

const syncPause = () => body.classList.toggle('bg-paused', document.hidden || body.classList.contains('streaming'));
document.addEventListener('visibilitychange', syncPause);

(async () => {
  const init = await api.init();
  renderUpdate(init.update || { status: 'idle' });
  settings = init.settings;
  body.classList.add('platform-' + settings.platform);
  status = init.status;
  setName(status.name || '…');
  renderNetwork(status.network);
  renderSettings();
  (init.log || []).forEach(appendLog);
  setTimeout(() => body.classList.add('ready'), 50);
})();
