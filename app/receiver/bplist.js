'use strict';
// Minimal binary plist (bplist00) encoder/decoder sufficient for AirPlay.

class Real { constructor(v) { this.value = v; } }
class UInt { constructor(v) { this.value = BigInt(v); } }

function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') {
    throw new Error('not a bplist');
  }
  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6];
  const refSize = buf[trailer + 7];
  const numObjects = Number(buf.readBigUInt64BE(trailer + 8));
  const topObject = Number(buf.readBigUInt64BE(trailer + 16));
  const tableOffset = Number(buf.readBigUInt64BE(trailer + 24));

  const readUIntN = (off, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[off + i];
    return v;
  };
  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) offsets[i] = readUIntN(tableOffset + i * offsetSize, offsetSize);

  const depthGuard = { d: 0 };
  function readLen(off, info) {
    if (info !== 0xf) return { len: info, start: off + 1 };
    const marker = buf[off + 1];
    const n = 1 << (marker & 0xf);
    return { len: readUIntN(off + 2, n), start: off + 2 + n };
  }
  function parse(idx) {
    if (++depthGuard.d > 64) throw new Error('bplist too deep');
    try {
      const off = offsets[idx];
      const marker = buf[off];
      const type = marker >> 4, info = marker & 0xf;
      switch (type) {
        case 0x0:
          if (info === 0x8) return false;
          if (info === 0x9) return true;
          return null;
        case 0x1: {
          const n = 1 << info;
          if (n === 8) { const v = buf.readBigInt64BE(off + 1); return (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)) ? Number(v) : v; }
          if (n === 16) return buf.readBigUInt64BE(off + 9);
          return readUIntN(off + 1, n);
        }
        case 0x2: {
          const n = 1 << info;
          return n === 4 ? buf.readFloatBE(off + 1) : buf.readDoubleBE(off + 1);
        }
        case 0x3: return new Date((buf.readDoubleBE(off + 1) + 978307200) * 1000);
        case 0x4: { const { len, start } = readLen(off, info); return Buffer.from(buf.subarray(start, start + len)); }
        case 0x5: { const { len, start } = readLen(off, info); return buf.toString('latin1', start, start + len); }
        case 0x6: {
          const { len, start } = readLen(off, info);
          const chars = [];
          for (let i = 0; i < len; i++) chars.push(buf.readUInt16BE(start + i * 2));
          return String.fromCharCode(...chars);
        }
        case 0x8: return readUIntN(off + 1, info + 1);
        case 0xa: {
          const { len, start } = readLen(off, info);
          const arr = [];
          for (let i = 0; i < len; i++) arr.push(parse(readUIntN(start + i * refSize, refSize)));
          return arr;
        }
        case 0xd: {
          const { len, start } = readLen(off, info);
          const obj = {};
          for (let i = 0; i < len; i++) {
            const k = parse(readUIntN(start + i * refSize, refSize));
            const v = parse(readUIntN(start + (len + i) * refSize, refSize));
            obj[k] = v;
          }
          return obj;
        }
        default: throw new Error('unsupported bplist type 0x' + type.toString(16));
      }
    } finally { depthGuard.d--; }
  }
  return parse(topObject);
}

function encode(root) {
  const objects = [];
  function flatten(v) {
    const idx = objects.length;
    const entry = { v, refs: null };
    objects.push(entry);
    if (Array.isArray(v)) {
      entry.refs = v.map(flatten);
    } else if (v && typeof v === 'object' && !(v instanceof Real) && !(v instanceof UInt) && !Buffer.isBuffer(v)) {
      const keys = Object.keys(v).filter(k => v[k] !== undefined);
      const kr = keys.map(flatten);
      const vr = keys.map(k => flatten(v[k]));
      entry.refs = kr.concat(vr);
      entry.dictCount = keys.length;
    }
    return idx;
  }
  flatten(root);
  const refSize = objects.length < 256 ? 1 : 2;
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = b => { chunks.push(b); pos += b.length; };
  push(Buffer.from('bplist00', 'latin1'));

  const lenHeader = (type, len) => {
    if (len < 15) return Buffer.from([(type << 4) | len]);
    let intBuf;
    if (len < 256) intBuf = Buffer.from([0x10, len]);
    else if (len < 65536) { intBuf = Buffer.alloc(3); intBuf[0] = 0x11; intBuf.writeUInt16BE(len, 1); }
    else { intBuf = Buffer.alloc(5); intBuf[0] = 0x12; intBuf.writeUInt32BE(len, 1); }
    return Buffer.concat([Buffer.from([(type << 4) | 0xf]), intBuf]);
  };
  const refBuf = refs => {
    const b = Buffer.alloc(refs.length * refSize);
    refs.forEach((r, i) => refSize === 1 ? b.writeUInt8(r, i) : b.writeUInt16BE(r, i * 2));
    return b;
  };
  const intBuf = n => {
    const big = BigInt(n);
    if (big >= 0n && big < 256n) return Buffer.from([0x10, Number(big)]);
    if (big >= 0n && big < 65536n) { const b = Buffer.alloc(3); b[0] = 0x11; b.writeUInt16BE(Number(big), 1); return b; }
    if (big >= 0n && big < 4294967296n) { const b = Buffer.alloc(5); b[0] = 0x12; b.writeUInt32BE(Number(big), 1); return b; }
    const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(BigInt.asIntN(64, big), 1); return b;
  };

  for (const o of objects) {
    offsets.push(pos);
    const v = o.v;
    if (v === null || v === undefined) push(Buffer.from([0x00]));
    else if (v === true) push(Buffer.from([0x09]));
    else if (v === false) push(Buffer.from([0x08]));
    else if (v instanceof Real) { const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v.value, 1); push(b); }
    else if (v instanceof UInt) push(intBuf(v.value));
    else if (typeof v === 'number') {
      if (Number.isInteger(v)) push(intBuf(v));
      else { const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v, 1); push(b); }
    } else if (typeof v === 'bigint') push(intBuf(v));
    else if (Buffer.isBuffer(v)) { push(lenHeader(0x4, v.length)); push(v); }
    else if (typeof v === 'string') {
      if (/^[\x00-\x7f]*$/.test(v)) { push(lenHeader(0x5, v.length)); push(Buffer.from(v, 'latin1')); }
      else {
        const b = Buffer.alloc(v.length * 2);
        for (let i = 0; i < v.length; i++) b.writeUInt16BE(v.charCodeAt(i), i * 2);
        push(lenHeader(0x6, v.length)); push(b);
      }
    } else if (Array.isArray(v)) { push(lenHeader(0xa, v.length)); push(refBuf(o.refs)); }
    else { push(lenHeader(0xd, o.dictCount)); push(refBuf(o.refs)); }
  }
  const tableOffset = pos;
  const offsetSize = tableOffset < 256 ? 1 : tableOffset < 65536 ? 2 : 4;
  const table = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((off, i) => {
    if (offsetSize === 1) table.writeUInt8(off, i);
    else if (offsetSize === 2) table.writeUInt16BE(off, i * 2);
    else table.writeUInt32BE(off, i * 4);
  });
  push(table);
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(tableOffset), 24);
  push(trailer);
  return Buffer.concat(chunks);
}

module.exports = { encode, decode, Real, UInt };
