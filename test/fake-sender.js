'use strict';
// Simulated iPhone: speaks the AirPlay mirroring protocol to the receiver (for automated testing).
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bplist = require('../app/receiver/bplist');

const sha512 = (...p) => { const h = crypto.createHash('sha512'); p.forEach(x => h.update(x)); return h.digest(); };
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function playfair(msg3, ekey) {
  const w = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(__dirname, '../app/playfair.wasm'))), {}).exports;
  const mem = new Uint8Array(w.memory.buffer);
  mem.set(msg3, w.msg_ptr()); mem.set(ekey, w.cipher_ptr()); w.decrypt();
  return Buffer.from(new Uint8Array(w.memory.buffer, w.out_ptr(), 16));
}

class Rtsp {
  constructor(host, port) { this.host = host; this.port = port; this.cseq = 0; this.buf = Buffer.alloc(0); this.waiters = []; }
  connect() {
    return new Promise((res, rej) => {
      this.sock = net.connect(this.port, this.host, res);
      this.sock.on('error', rej);
      this.sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
    });
  }
  pump() {
    const end = this.buf.indexOf('\r\n\r\n');
    if (end < 0 || !this.waiters.length) return;
    const head = this.buf.toString('utf8', 0, end);
    const m = /content-length:\s*(\d+)/i.exec(head);
    const len = m ? +m[1] : 0;
    if (this.buf.length < end + 4 + len) return;
    const body = this.buf.subarray(end + 4, end + 4 + len);
    this.buf = this.buf.subarray(end + 4 + len);
    const status = +head.split(' ')[1];
    this.waiters.shift()({ status, head, body: Buffer.from(body) });
    this.pump();
  }
  req(method, url, body = Buffer.alloc(0), ctype = null, extra = {}) {
    const h = [`${method} ${url} RTSP/1.0`, `CSeq: ${++this.cseq}`, 'User-Agent: AirPlay/750.6.1', `Content-Length: ${body.length}`];
    if (ctype) h.push(`Content-Type: ${ctype}`);
    for (const [k, v] of Object.entries(extra)) h.push(`${k}: ${v}`);
    this.sock.write(Buffer.concat([Buffer.from(h.join('\r\n') + '\r\n\r\n'), body]));
    return new Promise(r => { this.waiters.push(r); this.pump(); });
  }
}

function annexBToFrames(buf) {
  const nals = [];
  let i = 0, start = -1;
  while (i + 3 < buf.length) {
    let sc = 0;
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) sc = 3;
    else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) sc = 4;
    if (sc) { if (start >= 0) nals.push(buf.subarray(start, i)); start = i + sc; i += sc; } else i++;
  }
  if (start >= 0) nals.push(buf.subarray(start));
  let sps = null, pps = null; const frames = []; let cur = [];
  for (const n of nals) {
    const t = n[0] & 0x1f;
    if (t === 7) sps = n; else if (t === 8) pps = n;
    else if (t === 6 || t === 9) cur.push(n);
    else if (t === 1 || t === 5) { cur.push(n); frames.push({ nals: cur, key: t === 5 }); cur = []; }
  }
  return { sps, pps, frames };
}

async function run({ host = '127.0.0.1', port = 7000, name = 'iPhone (Тест)', seconds = 3, log = console.log } = {}) {
  const c = new Rtsp(host, port);
  await c.connect();
  let r = await c.req('GET', '/info');
  const info = bplist.decode(r.body);
  log('info: ' + info.name + ' features=0x' + info.features.toString(16) + ' model=' + info.model);

  // ---- pair-setup / pair-verify ----
  const ed = crypto.generateKeyPairSync('ed25519');
  const edRaw = fromB64url(ed.publicKey.export({ format: 'jwk' }).x);
  r = await c.req('POST', '/pair-setup', edRaw, 'application/octet-stream');
  const serverEd = r.body;
  const x = crypto.generateKeyPairSync('x25519');
  const xRaw = fromB64url(x.publicKey.export({ format: 'jwk' }).x);
  r = await c.req('POST', '/pair-verify', Buffer.concat([Buffer.from([1, 0, 0, 0]), xRaw, edRaw]), 'application/octet-stream');
  const serverX = r.body.subarray(0, 32);
  const secret = crypto.diffieHellman({ privateKey: x.privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64url(serverX) }, format: 'jwk' }) });
  const key = sha512(Buffer.from('Pair-Verify-AES-Key'), secret).subarray(0, 16);
  const iv = sha512(Buffer.from('Pair-Verify-AES-IV'), secret).subarray(0, 16);
  const ctr = crypto.createDecipheriv('aes-128-ctr', key, iv);
  const serverSig = ctr.update(r.body.subarray(32, 96));
  const okSig = crypto.verify(null, Buffer.concat([serverX, xRaw]), crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(serverEd) }, format: 'jwk' }), serverSig);
  log('server signature valid: ' + okSig);
  const mySig = crypto.sign(null, Buffer.concat([xRaw, serverX]), ed.privateKey);
  const encMySig = ctr.update(mySig); // continues the same keystream
  r = await c.req('POST', '/pair-verify', Buffer.concat([Buffer.from([0, 0, 0, 0]), encMySig]), 'application/octet-stream');
  log('pair-verify step 2: ' + r.status);

  // ---- fp-setup ----
  const fp1 = Buffer.from([0x46, 0x50, 0x4c, 0x59, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x04, 0x02, 0x00, 0x02, 0xbb]);
  r = await c.req('POST', '/fp-setup', fp1, 'application/octet-stream');
  log('fp-setup 1: ' + r.status + ' len=' + r.body.length);
  const msg3 = crypto.randomBytes(164); msg3.write('FPLY', 0, 'latin1'); msg3[4] = 3; msg3[5] = 1; msg3[6] = 3; msg3[12] = 2;
  r = await c.req('POST', '/fp-setup', msg3, 'application/octet-stream');
  log('fp-setup 2: ' + r.status + ' len=' + r.body.length + ' tail ok=' + r.body.subarray(12).equals(msg3.subarray(144)));

  // ---- SETUP 1 ----
  const ekey = crypto.randomBytes(72); const eiv = crypto.randomBytes(16);
  let aesKey = playfair(msg3, ekey);
  aesKey = sha512(aesKey, secret).subarray(0, 16);
  const timing = dgram.createSocket('udp4');
  let ntpRequests = 0;
  timing.on('message', (m, ri) => { ntpRequests++; const rep = Buffer.from(m); rep[1] = 0xd3; timing.send(rep, ri.port, ri.address); });
  await new Promise(res => timing.bind(0, '127.0.0.1', res));
  r = await c.req('SETUP', `rtsp://${host}/1234`, bplist.encode({ ekey, eiv, deviceID: 'AA:BB:CC:DD:EE:FF', name, model: 'iPhone17,1', timingPort: timing.address().port, timingProtocol: 'NTP', sessionUUID: 'x' }), 'application/x-apple-binary-plist');
  log('SETUP 1: ' + r.status);
  if (r.status !== 200) { c.sock.destroy(); timing.close(); return { ok: false, status: r.status }; }
  const s1 = bplist.decode(r.body);

  // ---- SETUP mirror stream ----
  const streamConnectionID = -4321987654321987654n;
  r = await c.req('SETUP', `rtsp://${host}/1234`, bplist.encode({ streams: [{ type: 110, streamConnectionID, timestampInfo: [] }] }), 'application/x-apple-binary-plist');
  const s2 = bplist.decode(r.body);
  const dataPort = s2.streams[0].dataPort;
  log('mirror dataPort=' + dataPort + ' timingPort=' + s1.timingPort);
  // ---- SETUP audio stream ----
  r = await c.req('SETUP', `rtsp://${host}/1234`, bplist.encode({ streams: [{ type: 96, ct: 8, spf: 480, audioFormat: 0x1000000, controlPort: 6001, isMedia: true, usingScreen: true }] }), 'application/x-apple-binary-plist');
  const s3 = bplist.decode(r.body);
  log('audio dataPort=' + s3.streams[0].dataPort + ' controlPort=' + s3.streams[0].controlPort);
  r = await c.req('RECORD', `rtsp://${host}/1234`);
  r = await c.req('SET_PARAMETER', `rtsp://${host}/1234`, Buffer.from('volume: -11.250000\r\n'), 'text/parameters');

  // ---- stream video ----
  const idStr = BigInt.asUintN(64, streamConnectionID).toString();
  const vkey = sha512(Buffer.from('AirPlayStreamKey' + idStr), aesKey).subarray(0, 16);
  const viv = sha512(Buffer.from('AirPlayStreamIV' + idStr), aesKey).subarray(0, 16);
  const vc = crypto.createCipheriv('aes-128-ctr', vkey, viv);
  const vs = net.connect(dataPort, host);
  await new Promise(res => vs.on('connect', res));
  const { sps, pps, frames } = annexBToFrames(fs.readFileSync(path.join(__dirname, 'phone.h264')));
  const avcc = Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), Buffer.from([sps.length >> 8, sps.length & 255]), sps, Buffer.from([1, pps.length >> 8, pps.length & 255]), pps]);
  const hdr = (size, type, opt5, opt6, opt7) => { const h = Buffer.alloc(128); h.writeUInt32LE(size, 0); h[4] = type; h[5] = opt5; h[6] = opt6; h[7] = opt7; h.writeBigUInt64LE(BigInt(Date.now()) << 16n, 8); return h; };
  const ph = hdr(avcc.length, 1, 0, 0x16, 0x01);
  for (const off of [16, 40, 56]) { ph.writeFloatLE(590, off); ph.writeFloatLE(1280, off + 4); }
  vs.write(Buffer.concat([ph, avcc]));

  // audio sender
  const au = dgram.createSocket('udp4');
  const eld = fs.readFileSync(path.join(__dirname, 'eld_frames.bin'));
  const eldFrames = []; for (let o = 0; o < eld.length;) { const n = eld.readUInt16LE(o); eldFrames.push(eld.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  let seq = 1000, ai = 0;
  const audioTimer = setInterval(() => {
    const f = eldFrames[ai++ % eldFrames.length];
    const n = f.length - (f.length % 16);
    const enc = Buffer.from(f);
    if (n) { const cc = crypto.createCipheriv('aes-128-cbc', aesKey, eiv); cc.setAutoPadding(false); cc.update(f.subarray(0, n)).copy(enc, 0); }
    const rtp = Buffer.alloc(12); rtp[0] = 0x80; rtp[1] = 0x60; rtp.writeUInt16BE(seq++ & 0xffff, 2); rtp.writeUInt32BE(ai * 480, 4);
    au.send(Buffer.concat([rtp, enc]), s3.streams[0].dataPort, host);
  }, 480 / 44.1);

  let fi = 0; const total = Math.min(frames.length, seconds * 30);
  await new Promise(res => {
    const t = setInterval(() => {
      if (fi >= total) { clearInterval(t); return res(); }
      const fr = frames[fi++];
      const plain = Buffer.concat(fr.nals.map(nal => { const l = Buffer.alloc(4); l.writeUInt32BE(nal.length); return Buffer.concat([l, nal]); }));
      const enc = vc.update(plain);
      vs.write(Buffer.concat([hdr(enc.length, 0, fr.key ? 0x10 : 0, 0, 0), enc]));
    }, 1000 / 30);
  });
  clearInterval(audioTimer);
  log(`sent ${total} video frames, ntp requests seen: ${ntpRequests}`);
  return {
    ok: true,
    teardown: async () => {
      await c.req('TEARDOWN', `rtsp://${host}/1234`, bplist.encode({ streams: [{ type: 110 }] }), 'application/x-apple-binary-plist');
      vs.destroy(); au.close(); timing.close(); c.sock.destroy();
    },
  };
}

module.exports = { run };
if (require.main === module) run({ port: +(process.argv[2] || 7000) }).then(r => r.teardown && r.teardown());
