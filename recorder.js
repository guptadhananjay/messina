/**
 * Recording: capture the mix sample-for-sample and write it as a WAV file.
 *
 * MediaRecorder only offers compressed WebM/Opus, which many music apps won't
 * open, so the audio is captured raw in a worklet and encoded here instead.
 *
 * This one file serves both sides. Loaded with audioWorklet.addModule() it
 * registers the capture processor; imported by app.js it supplies encodeWav().
 * The guard below is what lets it do both, since registerProcessor only exists
 * in the audio thread.
 */

const CHUNK = 4096;              // frames per message, ~85 ms at 48 kHz

if (typeof registerProcessor === 'function') {
  /**
   * Copies its stereo input to the main thread in CHUNK-frame pieces while
   * recording. It has no outputs, so Chrome pulls it without it being wired to
   * the speakers.
   */
  registerProcessor('messina-recorder', class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.recording = false;
      this.fill = 0;
      this.left = new Float32Array(CHUNK);
      this.right = new Float32Array(CHUNK);
      this.port.onmessage = (e) => {
        if (e.data === 'start') { this.recording = true; this.fill = 0; }
        if (e.data === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ done: true }); }
      };
    }

    flush() {
      if (!this.fill) return;
      const left = this.left.slice(0, this.fill), right = this.right.slice(0, this.fill);
      this.port.postMessage({ left, right }, [left.buffer, right.buffer]);
      this.fill = 0;
    }

    process(inputs) {
      if (!this.recording) return true;
      const input = inputs[0];
      const n = input[0]?.length ?? 128;
      for (let i = 0; i < n; i++) {
        // Nothing connected yet reads as silence, not a gap.
        this.left[this.fill] = input[0] ? input[0][i] : 0;
        this.right[this.fill] = input[1] ? input[1][i] : this.left[this.fill];
        if (++this.fill === CHUNK) this.flush();
      }
      return true;
    }
  });
}

/**
 * Float channels -> 24-bit PCM WAV. 24-bit keeps the recording's quiet tails
 * clean and opens in GarageBand, Logic, Audacity and every DAW. Samples
 * outside [-1, 1] are clipped, as any converter would.
 */
export function encodeWav(channels, sampleRate) {
  const frames = channels[0].length;
  const count = channels.length;
  const blockAlign = count * 3;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };

  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);                  // fmt chunk size
  view.setUint16(20, 1, true);                   // integer PCM
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 24, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);

  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      const v = Math.round(s * 8388607);
      view.setUint8(at, v & 0xff);
      view.setUint8(at + 1, (v >> 8) & 0xff);
      view.setUint8(at + 2, (v >> 16) & 0xff);
      at += 3;
    }
  }
  return buffer;
}
