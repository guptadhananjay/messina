/**
 * One voice of real-time pitch shifting.
 *
 * Variable delay line with a short splice crossfade. Input is written at 1x; a
 * read head's delay drifts at (1 - ratio) samples per sample, which resamples
 * the signal by `ratio`. The delay can only drift so far before it has to jump,
 * so it wraps over a grain length G, and the wrap is hidden by crossfading with
 * a second head exactly one grain behind (delay d + G) -- at the wrap the two
 * heads read the same position, so the splice is seamless.
 *
 * The crossfade lasts XFADE samples out of each grain period (G / |1 - ratio|
 * samples), so for most of the time the output is a single clean read head.
 * A 50%-overlap window instead leaves two incoherent heads fighting all the
 * time, which buries the carrier under a warble sideband.
 */
class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'ratio',
      defaultValue: 1,
      minValue: 0.25,
      maxValue: 4,
      automationRate: 'k-rate',
    }];
  }

  constructor() {
    super();
    this.size = 16384;                            // ~0.34 s at 48 kHz, power of two
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.write = 0;
    this.grain = Math.round(sampleRate * 0.04);   // 40 ms of drift before a splice
    this.xfade = Math.round(sampleRate * 0.006);  // 6 ms splice crossfade
    this.delay = 0;
  }

  read(delay) {
    const idx = this.write - delay;
    const i0 = Math.floor(idx);
    const frac = idx - i0;
    const a = this.buf[i0 & this.mask];
    const b = this.buf[(i0 + 1) & this.mask];
    return a + (b - a) * frac;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    const input = inputs[0][0];
    const ratio = parameters.ratio[0];
    const G = this.grain;
    const step = 1 - ratio;
    // Crossfade width measured in delay units, so it always spans XFADE samples
    // of wall-clock time however fast the delay is drifting.
    const thr = Math.abs(step) * this.xfade;

    for (let i = 0; i < out.length; i++) {
      this.buf[this.write & this.mask] = input ? input[i] : 0;

      const d = this.delay;
      if (thr > 0 && d < thr) {
        const u = (d / thr) * (Math.PI / 2);
        out[i] = Math.sin(u) * this.read(d) + Math.cos(u) * this.read(d + G);
      } else {
        out[i] = this.read(d);
      }

      this.write++;
      this.delay += step;
      if (this.delay >= G) this.delay -= G;
      else if (this.delay < 0) this.delay += G;
    }
    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
