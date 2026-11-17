'use strict';
// AirPlay screen-mirroring receiver (AirPlay 1 "legacy" protocol, as used by UxPlay/RPiPlay).
// RTSP control + FairPlay key exchange + encrypted H.264 mirror stream + AAC-ELD audio.
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const bplist = require('./bplist');
const { FairPlay } = require('./fairplay');
const { Advertiser } = require('./mdns');

const MODEL = 'AppleTV3,2';
const SOURCE_VERSION = '220.68';
const FEATURES = 0x5A7FFEE6; // mirroring + audio + FairPlay + legacy pairing; no HLS video, no H.265
const PI = '2e388006-13ba-4041-9a67-25dd4a43d536';

// ---------- small crypto helpers ----------
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha512 = (...parts) => { const h = crypto.createHash('sha512'); parts.forEach(p => h.update(p)); return h.digest(); };

function ed25519FromConfig(pkcs8b64) {
  let privateKey;
  if (pkcs8b64) {
    try { privateKey = crypto.createPrivateKey({ key: Buffer.from(pkcs8b64, 'base64'), format: 'der', type: 'pkcs8' }); } catch (_) { privateKey = null; }
  }
  if (!privateKey) privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const publicKey = crypto.createPublicKey(privateKey);
  const raw = fromB64url(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, publicKey, raw, pkcs8b64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
}

function x25519Generate() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, raw: fromB64url(publicKey.export({ format: 'jwk' }).x) };
}
const x25519Pub = raw => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64url(raw) }, format: 'jwk' });
const ed25519Pub = raw => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(raw) }, format: 'jwk' });

// ---------- RTSP request parsing ----------
function parseRequests(conn, chunk, onRequest) {
  conn.buf = conn.buf ? Buffer.concat([conn.buf, chunk]) : chunk;
  for (;;) {
    const end = conn.buf.indexOf('\r\n\r\n');
    if (end < 0) {
      if (conn.buf.length > 65536) throw new Error('header too large');
      return;
    }
    const head = conn.buf.toString('utf8', 0, end);
    const lines = head.split('\r\n');
    const [method, url, protocol] = lines[0].split(' ');
    const headers = {};
    for (const l of lines.slice(1)) {
      const i = l.indexOf(':');
      if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    }
    const len = parseInt(headers['content-length'] || '0', 10) || 0;
    if (len > 4 * 1024 * 1024) throw new Error('body too large');
    if (conn.buf.length < end + 4 + len) return;
    const body = conn.buf.subarray(end + 4, end + 4 + len);
    conn.buf = conn.buf.subarray(end + 4 + len);
    onRequest({ method, url, protocol: protocol || 'RTSP/1.0', headers, body: Buffer.from(body) });
  }
}

class AirPlayReceiver extends EventEmitter {
  /**
   * opts: { name, deviceId (Buffer 6), edKey (pkcs8 b64), width, height, fps, approve(info) => Promise<bool> }
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.ed = ed25519FromConfig(opts.edKey);
    this.server = null;
    this.port = 0;
    this.session = null; // the active mirroring session
    this.connections = new Set();
    this.volume = 0;
  }

  get edKeyExport() { return this.ed.pkcs8b64; }
  get deviceIdStr() { return [...this.opts.deviceId].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':'); }
  get pkHex() { return this.ed.raw.toString('hex'); }

  log(msg) { this.emit('log', msg); }

  airplayTxt() {
    return {
      deviceid: this.deviceIdStr,
      features: `0x${FEATURES.toString(16).toUpperCase()},0x0`,
      flags: '0x4',
      model: MODEL,
      pk: this.pkHex,
      pi: PI,
      srcvers: SOURCE_VERSION,
      vv: '2',
    };
  }

  raopTxt() {
    return {
      ch: '2', cn: '0,1,2,3', da: 'true', et: '0,3,5', vv: '2',
      ft: `0x${FEATURES.toString(16).toUpperCase()},0x0`,
      am: MODEL, md: '0,1,2', rhd: '5.6.0.0', pw: 'false', sr: '44100', ss: '16', sv: 'false',
      tp: 'UDP', txtvers: '1', sf: '0x4', vs: SOURCE_VERSION, vn: '65537', pk: this.pkHex,
    };
  }

  async start() {
    this.server = net.createServer(sock => this.onConnection(sock));
    this.server.on('error', e => this.log('RTSP server error: ' + e.message));
    const tryListen = port => new Promise((resolve, reject) => {
      const onErr = e => { this.server.removeListener('listening', onOk); reject(e); };
      const onOk = () => { this.server.removeListener('error', onErr); resolve(); };
      this.server.once('error', onErr);
      this.server.once('listening', onOk);
      this.server.listen(port, '0.0.0.0');
    });
    let ok = false;
    for (const port of [7000, 7100, 7200, 7001, 7002, 0]) {
      try { await tryListen(port); ok = true; break; } catch (e) { this.log(`Порт ${port} зайнятий: ${e.code || e.message}`); }
    }
    if (!ok) throw new Error('Не вдалося відкрити мережевий порт');
    this.port = this.server.address().port;
    this.log(`RTSP сервер слухає порт ${this.port}`);

    this.advertiser = new Advertiser({
      name: this.opts.name,
      hostLabel: 'Mirrorly-' + this.opts.deviceId.toString('hex').slice(-6).toUpperCase(),
      raopPrefix: this.opts.deviceId.toString('hex').toUpperCase(),
      port: this.port,
      airplayTxt: this.airplayTxt(),
      raopTxt: this.raopTxt(),
    });
    this.advertiser.on('log', m => this.log(m));
    this.advertiser.start();
  }

  rename(name) {
    this.opts.name = name;
    if (this.advertiser) this.advertiser.update({ name });
  }

  addresses() { return this.advertiser ? this.advertiser.listAddresses() : []; }

  stop() {
    this.disconnect();
    if (this.advertiser) this.advertiser.stop();
    if (this.server) this.server.close();
    for (const c of this.connections) c.sock.destroy();
  }

  /** Stop the current mirroring session from the PC side. */
  disconnect() {
    if (this.session) {
      const s = this.session;
      this.endSession(s, 'local');
      if (s.conn && s.conn.sock) s.conn.sock.destroy();
    }
  }

  // ---------- RTSP connection ----------
  onConnection(sock) {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10000);
    const conn = {
      sock,
      remote: (sock.remoteAddress || '').replace(/^::ffff:/, ''),
      local: (sock.localAddress || '').replace(/^::ffff:/, ''),
      fairplay: new FairPlay(),
      pair: { status: 'initial', ecdhSecret: null },
      session: null,
      busy: Promise.resolve(),
    };
    this.connections.add(conn);
    sock.on('data', chunk => {
      try {
        parseRequests(conn, chunk, req => {
          // Requests are handled strictly in order (SETUP may wait for user approval).
          conn.busy = conn.busy.then(() => this.handle(conn, req)).catch(e => {
            this.log('Помилка обробки ' + req.method + ' ' + req.url + ': ' + (e && e.stack || e));
            this.reply(conn, req, 500, 'Internal Server Error');
          });
        });
      } catch (e) {
        this.log('RTSP: ' + e.message);
        sock.destroy();
      }
    });
    sock.on('error', () => { /* handled by close */ });
    sock.on('close', () => {
      this.connections.delete(conn);
      if (conn.session) this.endSession(conn.session, 'closed');
    });
  }

  reply(conn, req, code, reason, headers = {}, body = null) {
    if (conn.sock.destroyed) return;
    const h = [`${req.protocol || 'RTSP/1.0'} ${code} ${reason}`];
    if (req.headers.cseq) h.push(`CSeq: ${req.headers.cseq}`);
    h.push(`Server: AirTunes/${SOURCE_VERSION}`);
    for (const [k, v] of Object.entries(headers)) h.push(`${k}: ${v}`);
    h.push(`Content-Length: ${body ? body.length : 0}`);
    const out = Buffer.concat([Buffer.from(h.join('\r\n') + '\r\n\r\n', 'utf8'), body || Buffer.alloc(0)]);
    conn.sock.write(out);
  }

  ok(conn, req, body = null, contentType = null, extra = {}) {
    const headers = { ...extra };
    if (body && contentType) headers['Content-Type'] = contentType;
    this.reply(conn, req, 200, 'OK', headers, body);
  }

  async handle(conn, req) {
    const path = (req.url || '').replace(/^rtsp:\/\/[^/]+/, '');
    const m = req.method;
    if (m === 'GET' && path === '/info') return this.handleInfo(conn, req);
    if (m === 'POST' && path === '/pair-setup') return this.handlePairSetup(conn, req);
    if (m === 'POST' && path === '/pair-verify') return this.handlePairVerify(conn, req);
    if (m === 'POST' && path === '/fp-setup') return this.handleFpSetup(conn, req);
    if (m === 'POST' && path === '/feedback') { if (conn.session) conn.session.lastFeedback = Date.now(); return this.ok(conn, req); }
    if (m === 'POST' && path === '/audioMode') return this.ok(conn, req);
    if (m === 'OPTIONS') return this.ok(conn, req, null, null, { Public: 'SETUP, RECORD, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER' });
    if (m === 'SETUP') return this.handleSetup(conn, req);
    if (m === 'RECORD') return this.ok(conn, req, null, null, { 'Audio-Latency': '11025', 'Audio-Jack-Status': 'connected; type=analog' });
    if (m === 'GET_PARAMETER') return this.handleGetParameter(conn, req);
    if (m === 'SET_PARAMETER') return this.handleSetParameter(conn, req);
    if (m === 'FLUSH') return this.ok(conn, req);
    if (m === 'TEARDOWN') return this.handleTeardown(conn, req);
    this.log(`Невідомий запит: ${m} ${req.url}`);
    return this.reply(conn, req, 404, 'Not Found');
  }

  handleInfo(conn, req) {
    const ctype = req.headers['content-type'] || '';
    const res = {};
    let qualifier = null;
    if (ctype.includes('application/x-apple-binary-plist') && req.body.length) {
      try { const p = bplist.decode(req.body); if (Array.isArray(p.qualifier)) qualifier = p.qualifier[0]; } catch (_) { /* ignore */ }
    }
    const txtBlob = obj => {
      const parts = [];
      for (const [k, v] of Object.entries(obj)) { const b = Buffer.from(`${k}=${v}`, 'utf8'); parts.push(Buffer.from([b.length]), b); }
      return Buffer.concat(parts);
    };
    if (qualifier === 'txtAirPlay') res.txtAirPlay = txtBlob(this.airplayTxt());
    if (qualifier === 'txtRAOP') res.txtRAOP = txtBlob(this.raopTxt());
    if (!ctype) {
      Object.assign(res, {
        deviceID: this.deviceIdStr,
        macAddress: this.deviceIdStr,
        pk: this.ed.raw,
        features: new bplist.UInt(FEATURES),
        name: this.opts.name,
        pi: PI,
        vv: 2,
        statusFlags: 68,
        keepAliveLowPower: true,
        sourceVersion: SOURCE_VERSION,
        keepAliveSendStatsAsBody: true,
        model: MODEL,
        initialVolume: new bplist.Real(this.volume),
        audioLatencies: [
          { type: 100, inputLatencyMicros: 0, audioType: 'default', outputLatencyMicros: false },
          { type: 101, audioType: 'default', inputLatencyMicros: 0, outputLatencyMicros: false },
        ],
        audioFormats: [
          { audioOutputFormats: 0x3fffffc, type: 100, audioInputFormats: 0x3fffffc },
          { audioOutputFormats: 0x3fffffc, type: 101, audioInputFormats: 0x3fffffc },
        ],
        displays: [{
          uuid: 'e0ff8a27-6738-3d56-8a16-cc53aacee925',
          widthPhysical: 0, heightPhysical: 0,
          width: this.opts.width, height: this.opts.height,
          widthPixels: this.opts.width, heightPixels: this.opts.height,
          rotation: false,
          refreshRate: new bplist.Real(1 / 60),
          maxFPS: this.opts.fps,
          overscanned: false,
          features: 14,
        }],
      });
    }
    this.ok(conn, req, bplist.encode(res), 'application/x-apple-binary-plist');
  }

  handlePairSetup(conn, req) {
    if (req.body.length !== 32) return this.reply(conn, req, 400, 'Bad Request');
    conn.pair.status = 'setup';
    this.ok(conn, req, Buffer.from(this.ed.raw), 'application/octet-stream');
  }

  handlePairVerify(conn, req) {
    const d = req.body;
    if (d.length < 4) return this.reply(conn, req, 400, 'Bad Request');
    if (d[0] === 1) {
      if (d.length !== 4 + 32 + 32) return this.reply(conn, req, 400, 'Bad Request');
      const theirEcdh = d.subarray(4, 36);
      const theirEd = d.subarray(36, 68);
      const ours = x25519Generate();
      const secret = crypto.diffieHellman({ privateKey: ours.privateKey, publicKey: x25519Pub(theirEcdh) });
      conn.pair = { status: 'handshake', ecdhSecret: secret, ourEcdh: ours.raw, theirEcdh: Buffer.from(theirEcdh), theirEd: Buffer.from(theirEd) };
      const sig = crypto.sign(null, Buffer.concat([ours.raw, theirEcdh]), this.ed.privateKey);
      const key = sha512(Buffer.from('Pair-Verify-AES-Key'), secret).subarray(0, 16);
      const iv = sha512(Buffer.from('Pair-Verify-AES-IV'), secret).subarray(0, 16);
      const c = crypto.createCipheriv('aes-128-ctr', key, iv);
      const encSig = c.update(sig);
      return this.ok(conn, req, Buffer.concat([ours.raw, encSig]), 'application/octet-stream');
    }
    if (d[0] === 0) {
      const p = conn.pair;
      if (p.status !== 'handshake' || d.length !== 4 + 64) return this.reply(conn, req, 400, 'Bad Request');
      const key = sha512(Buffer.from('Pair-Verify-AES-Key'), p.ecdhSecret).subarray(0, 16);
      const iv = sha512(Buffer.from('Pair-Verify-AES-IV'), p.ecdhSecret).subarray(0, 16);
      const c = crypto.createDecipheriv('aes-128-ctr', key, iv);
      c.update(Buffer.alloc(64)); // skip the keystream used for our own signature
      const sig = c.update(d.subarray(4, 68));
      let valid = false;
      try { valid = crypto.verify(null, Buffer.concat([p.theirEcdh, p.ourEcdh]), ed25519Pub(p.theirEd), sig); } catch (_) { valid = false; }
      if (!valid) {
        this.log('pair-verify: невірний підпис клієнта');
        this.reply(conn, req, 470, 'Connection Authorization Required');
        conn.sock.end();
        return;
      }
      p.status = 'finished';
      return this.ok(conn, req, null, 'application/octet-stream');
    }
    return this.reply(conn, req, 400, 'Bad Request');
  }

  handleFpSetup(conn, req) {
    let res = null;
    if (req.body.length === 16) {
      if (req.body[4] !== 0x03) return this.reply(conn, req, 501, 'Not Implemented');
      res = conn.fairplay.setup(req.body);
    } else if (req.body.length === 164) {
      res = conn.fairplay.handshake(req.body);
    }
    if (!res) return this.reply(conn, req, 400, 'Bad Request');
    this.ok(conn, req, res, 'application/octet-stream');
  }

  handleGetParameter(conn, req) {
    const body = req.body.toString('utf8');
    if (body.includes('volume')) {
      return this.ok(conn, req, Buffer.from(`volume: ${this.volume.toFixed(6)}\r\n`), 'text/parameters');
    }
    this.ok(conn, req);
  }

  handleSetParameter(conn, req) {
    const ctype = req.headers['content-type'] || '';
    if (ctype === 'text/parameters') {
      const s = req.body.toString('utf8');
      const mv = /volume:\s*(-?[\d.]+)/.exec(s);
      if (mv) {
        this.volume = parseFloat(mv[1]);
        this.emit('volume', this.volume);
      }
    }
    this.ok(conn, req);
  }

  handleTeardown(conn, req) {
    let types = [];
    try { const p = bplist.decode(req.body); if (Array.isArray(p.streams)) types = p.streams.map(s => s.type); } catch (_) { /* no body */ }
    const s = conn.session;
    this.ok(conn, req, null, null, { Connection: 'close' });
    if (!s) return;
    if (types.includes(96) && !types.includes(110)) {
      this.stopAudio(s);
    } else {
      this.endSession(s, 'teardown');
    }
  }

  async handleSetup(conn, req) {
    let p;
    try { p = bplist.decode(req.body); } catch (e) { return this.reply(conn, req, 400, 'Bad Request'); }
    const res = {};

    if (Buffer.isBuffer(p.ekey) && Buffer.isBuffer(p.eiv)) {
      // ---- first SETUP: keys + timing ----
      const info = { deviceId: p.deviceID || '', name: p.name || 'iPhone', model: p.model || '', address: conn.remote };
      const allowed = this.opts.approve ? await this.opts.approve(info) : true;
      if (!allowed) {
        this.log(`Підключення від ${info.name} відхилено`);
        this.reply(conn, req, 403, 'Forbidden');
        setTimeout(() => conn.sock.destroy(), 200);
        return;
      }
      if (p.ekey.length !== 72 || p.eiv.length !== 16) return this.reply(conn, req, 400, 'Bad Request');
      let aesKey = conn.fairplay.decrypt(p.ekey);
      if (!aesKey) return this.reply(conn, req, 400, 'Bad Request');
      if (conn.pair.ecdhSecret) aesKey = sha512(aesKey, conn.pair.ecdhSecret).subarray(0, 16);

      // A new client replaces any existing session (one screen at a time).
      if (this.session && this.session.conn !== conn) {
        const old = this.session;
        this.endSession(old, 'replaced');
        old.conn.sock.destroy();
      }
      const s = {
        id: crypto.randomBytes(4).toString('hex'),
        conn, info, aesKey, aesIv: Buffer.from(p.eiv),
        timingRport: Number(p.timingPort) || 0,
        lastNtpReply: Date.now(), lastFeedback: Date.now(),
        mirrorServer: null, mirrorSocket: null,
        audio: null, ntp: null, ended: false,
      };
      conn.session = s;
      this.session = s;
      await this.startNtp(s);
      res.timingPort = s.ntp ? s.ntp.address().port : 0;
      res.eventPort = 0;
      this.log(`Підключено: ${info.name} (${info.model}) з ${conn.remote}`);
      this.emit('session-start', { ...info });
    }

    const s = conn.session;
    if (Array.isArray(p.streams)) {
      if (!s) return this.reply(conn, req, 400, 'Bad Request');
      res.streams = [];
      for (const st of p.streams) {
        if (st.type === 110) {
          const port = await this.startMirror(s, st.streamConnectionID);
          res.streams.push({ dataPort: port, type: 110 });
        } else if (st.type === 96) {
          const ports = await this.startAudio(s, st);
          res.streams.push({ dataPort: ports.data, controlPort: ports.control, type: 96 });
        }
      }
    }
    this.ok(conn, req, bplist.encode(res), 'application/x-apple-binary-plist');
  }

  endSession(s, reason) {
    if (!s || s.ended) return;
    s.ended = true;
    if (s.ntp) { clearInterval(s.ntpTimer); try { s.ntp.close(); } catch (_) { /* ignore */ } }
    if (s.mirrorSocket) s.mirrorSocket.destroy();
    if (s.mirrorServer) s.mirrorServer.close();
    this.stopAudio(s);
    if (s.conn) s.conn.session = null;
    if (this.session === s) {
      this.session = null;
      this.log(`Сесію завершено (${reason})`);
      this.emit('session-end', { reason });
    }
  }

  // ---------- NTP timing (receiver polls the sender; also detects a vanished phone) ----------
  startNtp(s) {
    if (!s.timingRport) return Promise.resolve();
    const sock = dgram.createSocket('udp4');
    s.ntp = sock;
    sock.on('error', () => { /* ignore */ });
    sock.on('message', msg => { if (msg.length >= 32 && (msg[1] & 0x7f) === 0x53) s.lastNtpReply = Date.now(); });
    const send = () => {
      const req = Buffer.alloc(32);
      req[0] = 0x80; req[1] = 0xd2; req[3] = 0x07;
      const now = Date.now() / 1000 + 2208988800;
      req.writeUInt32BE(Math.floor(now) >>> 0, 24);
      req.writeUInt32BE(Math.floor((now % 1) * 4294967296) >>> 0, 28);
      sock.send(req, s.timingRport, s.conn.remote, () => { /* ignore */ });
      if (Date.now() - s.lastNtpReply > 20000 && Date.now() - s.lastFeedback > 20000) {
        this.log('Телефон перестав відповідати');
        this.endSession(s, 'timeout');
        if (s.conn) s.conn.sock.destroy();
      }
    };
    s.ntpTimer = setInterval(send, 3000);
    return new Promise(resolve => sock.bind(0, '0.0.0.0', () => { send(); resolve(); }));
  }

  // ---------- mirror (video) stream ----------
  startMirror(s, streamConnectionID) {
    const idStr = BigInt.asUintN(64, BigInt(streamConnectionID)).toString();
    const key = sha512(Buffer.from('AirPlayStreamKey' + idStr), s.aesKey).subarray(0, 16);
    const iv = sha512(Buffer.from('AirPlayStreamIV' + idStr), s.aesKey).subarray(0, 16);
    if (s.mirrorSocket) s.mirrorSocket.destroy();
    if (s.mirrorServer) s.mirrorServer.close();
    s.video = { decipher: crypto.createDecipheriv('aes-128-ctr', key, iv), avcc: null, width: 0, height: 0, paused: false, frames: 0, badFrames: 0 };
    return new Promise(resolve => {
      const srv = net.createServer(sock => {
        if (s.mirrorSocket) s.mirrorSocket.destroy();
        s.mirrorSocket = sock;
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 10000);
        let buf = Buffer.alloc(0);
        sock.on('data', chunk => {
          buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
          while (buf.length >= 128) {
            const size = buf.readUInt32LE(0);
            if (size > 16 * 1024 * 1024) { this.log('Пошкоджений відеопотік'); sock.destroy(); return; }
            if (buf.length < 128 + size) break;
            const header = buf.subarray(0, 128);
            const payload = buf.subarray(128, 128 + size);
            try { this.onMirrorPacket(s, header, payload); } catch (e) { this.log('Відео: ' + e.message); }
            buf = buf.subarray(128 + size);
          }
        });
        sock.on('error', () => { /* ignore */ });
        sock.on('close', () => { if (s.mirrorSocket === sock) s.mirrorSocket = null; });
      });
      srv.on('error', e => this.log('Відеопорт: ' + e.message));
      srv.listen(0, '0.0.0.0', () => resolve(srv.address().port));
      s.mirrorServer = srv;
    });
  }

  onMirrorPacket(s, header, payload) {
    const type = header[4];
    const v = s.video;
    if (type === 0x00) {
      if (!payload.length) return;
      const data = v.decipher.update(payload);
      // Validate the AVCC (length-prefixed) NAL structure produced by decryption.
      let off = 0, key = false, ok = true;
      while (off + 4 <= data.length) {
        const n = data.readUInt32BE(off);
        if (n <= 0 || off + 4 + n > data.length) { ok = false; break; }
        const nalType = data[off + 4] & 0x1f;
        if (data[off + 4] & 0x80) { ok = false; break; }
        if (nalType === 5) key = true;
        off += 4 + n;
      }
      if (off !== data.length) ok = false;
      if (!ok) { v.badFrames++; if (v.badFrames < 5) this.log('Не вдалося розшифрувати кадр'); return; }
      if (!v.avcc) return;
      v.frames++;
      const ts = Number(header.readBigUInt64LE(8) & 0xffffffffffffn);
      this.emit('video-frame', { data, key, ts });
    } else if (type === 0x01) {
      const opt = header[6];
      if (opt === 0x56 || opt === 0x5e) {
        if (!v.paused) { v.paused = true; this.emit('video-pause'); }
      } else if (v.paused) { v.paused = false; this.emit('video-resume'); }
      if (payload.length === 0) {
        this.log('Телефон надсилає відео H.265, яке не підтримується');
        return;
      }
      if (payload.length >= 8 && payload.toString('latin1', 4, 8) === 'hvc1') {
        this.log('H.265 не підтримується');
        return;
      }
      const spsSize = payload.readUInt16BE(6);
      const ppsSize = payload.readUInt16BE(9 + spsSize);
      const end = 11 + spsSize + ppsSize;
      if (end > payload.length) { this.log('Пошкоджені SPS/PPS'); return; }
      const avcc = Buffer.from(payload.subarray(0, end));
      avcc[0] = 1; // configurationVersion
      avcc[4] = 0xff; avcc[5] = 0xe1; avcc[8 + spsSize] = 1;
      const width = Math.round(header.readFloatLE(56)) || Math.round(header.readFloatLE(40));
      const height = Math.round(header.readFloatLE(60)) || Math.round(header.readFloatLE(44));
      const changed = !v.avcc || !v.avcc.equals(avcc) || v.width !== width || v.height !== height;
      v.avcc = avcc; v.width = width; v.height = height;
      if (changed) {
        const sps = avcc.subarray(8, 8 + spsSize); // sps[0] = NAL header, sps[1..3] = profile/compat/level
        const codec = 'avc1.' + [sps[1], sps[2], sps[3]].map(b => b.toString(16).padStart(2, '0')).join('');
        this.log(`Відео: ${width}×${height}, ${codec}`);
        this.emit('video-config', { avcc, width, height, codec });
      }
    }
    // 0x02 (keep-alive) and 0x05 (streaming report) carry nothing we need.
  }

  // ---------- audio stream ----------
  startAudio(s, st) {
    this.stopAudio(s);
    const ct = Number(st.ct) || 0;
    const a = { ct, data: dgram.createSocket('udp4'), control: dgram.createSocket('udp4'), decoder: null, lastSeq: -1 };
    s.audio = a;
    if (ct === 8) {
      try { const { AacEldDecoder } = require('./aac'); a.decoder = new AacEldDecoder(); } catch (e) { this.log('Аудіо: ' + e.message); }
    } else {
      this.log(`Аудіоформат ct=${ct} не підтримується (лише AAC-ELD у режимі повтору екрана)`);
    }
    const handle = (msg, offset) => {
      if (msg.length < offset + 12) return;
      const pt = msg[offset + 1] & 0x7f;
      if (pt !== 0x60) return;
      const seq = msg.readUInt16BE(offset + 2);
      if (a.lastSeq >= 0) {
        const d = (seq - a.lastSeq + 65536) % 65536;
        if (d === 0 || d > 32768) return; // duplicate / late
      }
      a.lastSeq = seq;
      const enc = msg.subarray(offset + 12);
      const n = enc.length - (enc.length % 16);
      const out = Buffer.alloc(enc.length);
      if (n > 0) {
        const d = crypto.createDecipheriv('aes-128-cbc', s.aesKey, s.aesIv);
        d.setAutoPadding(false);
        d.update(enc.subarray(0, n)).copy(out, 0);
      }
      enc.copy(out, n, n);
      if (a.decoder) {
        const pcm = a.decoder.decode(out);
        if (pcm) this.emit('audio', pcm);
      }
    };
    a.data.on('message', msg => handle(msg, 0));
    a.control.on('message', msg => { if ((msg[1] & 0x7f) === 0x56) handle(msg, 4); });
    a.data.on('error', () => { /* ignore */ });
    a.control.on('error', () => { /* ignore */ });
    const bind = sock => new Promise(r => sock.bind(0, '0.0.0.0', () => r(sock.address().port)));
    return Promise.all([bind(a.data), bind(a.control)]).then(([data, control]) => ({ data, control }));
  }

  stopAudio(s) {
    if (s && s.audio) {
      try { s.audio.data.close(); } catch (_) { /* ignore */ }
      try { s.audio.control.close(); } catch (_) { /* ignore */ }
      s.audio = null;
    }
  }
}

module.exports = { AirPlayReceiver };
