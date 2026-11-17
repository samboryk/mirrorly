'use strict';
// Self-updater: checks GitHub Releases, downloads the new installer, verifies its SHA-256,
// then runs it silently (/S /UPDATE) and the installer relaunches Mirrorly.
const { app, net } = require('electron');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = 'samboryk/mirrorly';
const API = process.env.MIRRORLY_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_RE = /^Mirrorly-Setup-(\d+\.\d+\.\d+)\.exe$/i;

function parseVer(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? m.slice(1, 4).map(Number) : null;
}
function newer(a, b) { // a > b
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

class Updater extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'idle', current: app.getVersion() };
    this.release = null;
    this.file = null;
    this.busy = false;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async getJson(url) {
    const res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mirrorly-Updater' }, cache: 'no-store' });
    if (res.status === 404) throw new Error('Оновлень ще не опубліковано');
    if (res.status === 403 || res.status === 429) throw new Error('Сервер оновлень тимчасово обмежив запити');
    if (!res.ok) throw new Error(`Сервер оновлень відповів ${res.status}`);
    return res.json();
  }

  async getText(url) {
    const res = await net.fetch(url, { headers: { 'User-Agent': 'Mirrorly-Updater' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  /** @param {boolean} manual  shows "up to date"/errors to the user when true */
  async check(manual = false, autoDownload = true) {
    if (this.busy || ['downloading', 'ready'].includes(this.state.status)) return this.state;
    this.busy = true;
    this.set({ status: 'checking', error: null, manual });
    try {
      const rel = await this.getJson(API);
      if (rel.draft || rel.prerelease) throw new Error('Оновлень ще не опубліковано');
      const asset = (rel.assets || []).find(a => ASSET_RE.test(a.name));
      const version = (rel.tag_name || '').replace(/^v/i, '') || (asset && ASSET_RE.exec(asset.name)[1]);
      if (!asset || !newer(version, app.getVersion())) {
        this.set({ status: 'uptodate', checkedAt: Date.now() });
        return this.state;
      }
      let sha256 = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : null;
      if (!sha256) {
        const sum = (rel.assets || []).find(a => a.name.toLowerCase() === asset.name.toLowerCase() + '.sha256');
        if (sum) sha256 = ((await this.getText(sum.browser_download_url)).match(/[a-f0-9]{64}/i) || [])[0];
      }
      if (!sha256) throw new Error('У релізі немає контрольної суми, оновлення пропущено');
      this.release = { version, url: asset.browser_download_url, size: asset.size, sha256: sha256.toLowerCase(), name: asset.name };
      this.set({ status: 'available', version, notes: String(rel.body || '').slice(0, 2000), size: asset.size, checkedAt: Date.now() });
    } catch (e) {
      this.set({ status: 'error', error: e.message, checkedAt: Date.now() });
      return this.state;
    } finally {
      this.busy = false;
    }
    if (autoDownload) await this.download();
    return this.state;
  }

  async download() {
    const r = this.release;
    if (!r || this.busy || this.state.status === 'ready') return;
    this.busy = true;
    const dir = path.join(app.getPath('temp'), 'mirrorly-update');
    const file = path.join(dir, r.name);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Already downloaded earlier?
      if (fs.existsSync(file) && await this.hashFile(file) === r.sha256) {
        this.file = file;
        this.set({ status: 'ready', progress: 1 });
        return;
      }
      this.set({ status: 'downloading', progress: 0 });
      const res = await net.fetch(r.url, { headers: { 'User-Agent': 'Mirrorly-Updater' } });
      if (!res.ok || !res.body) throw new Error(`Завантаження не вдалося (${res.status})`);
      const total = Number(res.headers.get('content-length')) || r.size || 0;
      const tmp = file + '.part';
      const out = fs.createWriteStream(tmp);
      const hash = crypto.createHash('sha256');
      let got = 0, lastEmit = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        got += buf.length;
        if (!out.write(buf)) await new Promise(ok => out.once('drain', ok));
        if (total && Date.now() - lastEmit > 250) { lastEmit = Date.now(); this.set({ progress: got / total }); }
      }
      await new Promise((ok, fail) => out.end(err => (err ? fail(err) : ok())));
      if (hash.digest('hex') !== r.sha256) {
        fs.rmSync(tmp, { force: true });
        throw new Error('Файл оновлення пошкоджено (не збігається контрольна сума)');
      }
      fs.renameSync(tmp, file);
      this.file = file;
      this.set({ status: 'ready', progress: 1 });
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    } finally {
      this.busy = false;
    }
  }

  hashFile(file) {
    return new Promise((ok, fail) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
    });
  }

  /** Runs the installer silently; it closes Mirrorly, updates files and starts the new version. */
  install() {
    if (this.state.status !== 'ready' || !this.file || !fs.existsSync(this.file)) return false;
    if (process.platform !== 'win32') return false;
    // "start" goes through ShellExecute, so Windows can show the UAC prompt the installer needs.
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', `"${this.file}"`, '/S', '/UPDATE'], {
      detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true,
    });
    child.unref();
    return true;
  }
}

module.exports = { Updater, newer };
