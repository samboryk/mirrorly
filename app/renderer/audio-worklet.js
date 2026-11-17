/* global registerProcessor, AudioWorkletProcessor, sampleRate */
// Jitter-buffered PCM player for the AirPlay audio stream (interleaved stereo Int16, 44.1 kHz).
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 44100 * 2; // 2 s of stereo frames
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.filled = 0;
    this.playing = false;
    this.target = Math.round(sampleRate * 0.08);   // start playing after 80 ms is buffered
    this.maxFill = Math.round(sampleRate * 0.35);  // drop backlog above 350 ms (keeps lip-sync)
    this.port.onmessage = e => {
      if (e.data === 'flush') { this.read = this.write = this.filled = 0; this.playing = false; return; }
      const pcm = e.data; // Int16Array
      const frames = pcm.length >> 1;
      for (let i = 0; i < frames; i++) {
        this.l[this.write] = pcm[2 * i] / 32768;
        this.r[this.write] = pcm[2 * i + 1] / 32768;
        this.write = (this.write + 1) % this.size;
      }
      this.filled = Math.min(this.size, this.filled + frames);
      if (this.filled > this.maxFill) {
        const drop = this.filled - this.target;
        this.read = (this.read + drop) % this.size;
        this.filled -= drop;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (!this.playing && this.filled >= this.target) this.playing = true;
    if (!this.playing || this.filled < n) {
      if (this.playing && this.filled < n) this.playing = false; // underrun: re-buffer
      L.fill(0); if (R !== L) R.fill(0);
      return true;
    }
    for (let i = 0; i < n; i++) {
      L[i] = this.l[this.read];
      R[i] = this.r[this.read];
      this.read = (this.read + 1) % this.size;
    }
    this.filled -= n;
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
