'use strict';
// AAC-ELD decoder (Fraunhofer FDK AAC compiled to WebAssembly).
const fs = require('fs');
const path = require('path');

let mod = null;
function getModule() {
  if (!mod) mod = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, '..', 'aac_eld.wasm')));
  return mod;
}

class AacEldDecoder {
  constructor() {
    const stub = () => 0;
    const imports = { wasi_snapshot_preview1: { fd_close: stub, fd_fdstat_get: stub, fd_read: stub, fd_seek: stub, fd_write: stub } };
    this.w = new WebAssembly.Instance(getModule(), imports).exports;
    const r = this.w.init_eld();
    if (r !== 0) throw new Error('AAC-ELD init failed: ' + r);
  }
  /** @returns {Int16Array|null} interleaved stereo PCM (copy) */
  decode(frame) {
    if (!frame || frame.length === 0 || frame.length > 2048) return null;
    new Uint8Array(this.w.memory.buffer).set(frame, this.w.in_ptr());
    const n = this.w.decode(frame.length);
    if (n <= 0) return null;
    return new Int16Array(this.w.memory.buffer.slice(this.w.out_ptr(), this.w.out_ptr() + n * 2));
  }
}

module.exports = { AacEldDecoder };
