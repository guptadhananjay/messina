/**
 * Messina engine - one analysis, many voices.
 *
 * Phase 1 ran eight independent resampling shifters. Resampling is a tape
 * speed-up: it scales pitch and formants together, which is why big intervals
 * sounded chipmunky. This engine instead tracks the sung pitch (YIN) and
 * resynthesises with TD-PSOLA, which copies whole pitch periods unmodified and
 * only changes how often they are laid down - so the spectral envelope, and
 * with it the identity of the voice, survives the shift.
 *
 * Analysis happens once per render quantum boundary and is shared by all
 * voices. `resample` mode keeps the Phase 1 algorithm so the two can be
 * A/B-compared on the same held chord.
 *
 * Control is over the port rather than AudioParams: note events are rare, so a
 * render quantum of messaging latency is irrelevant, and it keeps one node
 * where there used to be eight.
 */

const HOP = 256;                 // analysis hop, ~5 ms at 48 kHz
const BUF = 1 << 15;             // input ring, ~0.68 s at 48 kHz
const BUF_MASK = BUF - 1;
const ACC = 1 << 13;             // per-voice overlap-add ring
const ACC_MASK = ACC - 1;
const MAX_VOICES = 8;
const MAX_MARKS = 48;
const YIN_THRESHOLD = 0.12;
const F_MAX = 1000;              // highest f0 we look for
const VOICED_CONFIDENCE = 0.45;
const UNVOICED_DUCK = 0.5;       // harmonies drop ~6 dB on consonants

/** Iterative radix-2 complex FFT with precomputed twiddles. */
class FFT {
  constructor(n) {
    this.n = n;
    this.levels = Math.round(Math.log2(n));
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(2 * Math.PI * i / n);
      this.sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < this.levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r >>> 0;
    }
  }

  transform(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * this.cos[k] + im[l] * this.sin[k];
          const tim = -re[l] * this.sin[k] + im[l] * this.cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  }

  inverse(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.transform(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
  }
}

class MessinaEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BUF);
    this.write = 0;
    this.hopCounter = 0;
    this.reportCounter = 0;

    this.mode = 'psola';
    this.absolute = true;

    this.f0 = 0;
    this.confidence = 0;
    this.voiced = false;
    this.duck = 1;

    this.marks = new Float64Array(MAX_MARKS);
    this.markHead = 0;
    this.markCount = 0;
    this.nextMarkPred = 0;
    this.markInit = false;

    this.grain = Math.round(sampleRate * 0.04);    // resample mode, as in Phase 1
    this.xfade = Math.round(sampleRate * 0.006);

    this.gainCoef = 1 - Math.exp(-1 / (0.012 * sampleRate));
    this.duckCoef = 1 - Math.exp(-1 / (0.020 * sampleRate));
    this.ratioCoef = 0.25;                          // per quantum, ~20 ms glide

    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({
        id: null, active: false, midi: null, semis: 0,
        gain: 0, gainTarget: 0, ratio: 1, ratioTarget: 1,
        nextOut: 0, delayPos: 0,
        acc: new Float32Array(ACC), wsum: new Float32Array(ACC),
      });
    }

    this.duckBuf = new Float32Array(128);
    this.configure(2048, 82);
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  /**
   * Window size follows the lowest pitch we want to track (it must hold ~2
   * cycles). The engine's delay follows from PSOLA needing a grain either side
   * of a mark: two periods of the lowest note, which is the honest cost of the
   * algorithm and identical in any language.
   */
  configure(window, fmin) {
    this.W = window;
    this.fmin = fmin;
    this.N = window * 2;
    this.fft = new FFT(this.N);
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.prefix = new Float64Array(window + 1);
    this.tauMax = Math.min(Math.floor(sampleRate / fmin), window - 1);
    this.tauMin = Math.max(2, Math.floor(sampleRate / F_MAX));
    this.cmnd = new Float64Array(this.tauMax + 2);
    this.T0max = sampleRate / fmin;
    this.T0 = sampleRate / 200;
    this.delay = Math.ceil(2 * this.T0max) + HOP;
    this.markInit = false;
    this.markCount = 0;
    this.markHead = 0;
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'noteOn': {
        let voice = this.voices.find((v) => v.id === msg.id)
          || this.voices.find((v) => !v.active)
          || this.voices[0];
        if (voice.id !== null && voice.id !== msg.id) voice.gainTarget = 0;
        const fresh = !voice.active;
        voice.id = msg.id;
        voice.active = true;
        voice.midi = msg.midi ?? null;
        voice.semis = msg.semis ?? 0;
        voice.gainTarget = 1;
        if (fresh) {
          voice.nextOut = this.write;
          voice.delayPos = 0;
          voice.acc.fill(0);
          voice.wsum.fill(0);
          voice.ratio = this.targetRatio(voice);
        }
        break;
      }
      case 'noteOff': {
        const voice = this.voices.find((v) => v.id === msg.id);
        if (voice) { voice.active = false; voice.gainTarget = 0; voice.id = null; }
        break;
      }
      case 'allOff':
        for (const v of this.voices) { v.active = false; v.gainTarget = 0; v.id = null; }
        break;
      case 'config':
        if (msg.mode) this.mode = msg.mode;
        if (typeof msg.absolute === 'boolean') this.absolute = msg.absolute;
        if (msg.window && msg.fmin && (msg.window !== this.W || msg.fmin !== this.fmin)) {
          this.configure(msg.window, msg.fmin);
        }
        this.postStatus();
        break;
    }
  }

  postStatus() {
    this.port.postMessage({
      type: 'status',
      f0: this.f0,
      confidence: this.confidence,
      voiced: this.voiced,
      delaySamples: this.delay,
      delayMs: this.delay / sampleRate * 1000,
      mode: this.mode,
    });
  }

  /* ---------- analysis ---------- */

  /** YIN, with the difference function built from an FFT autocorrelation. */
  analyse() {
    const W = this.W, N = this.N, re = this.re, im = this.im, pre = this.prefix;
    re.fill(0);
    im.fill(0);
    const start = this.write - W;
    for (let i = 0; i < W; i++) re[i] = this.buf[(start + i) & BUF_MASK];

    pre[0] = 0;
    for (let i = 0; i < W; i++) pre[i + 1] = pre[i] + re[i] * re[i];
    if (pre[W] < 1e-6) {                       // silence: hold the last pitch
      this.confidence = 0;
      this.voiced = false;
      return;
    }

    this.fft.transform(re, im);
    for (let i = 0; i < N; i++) {
      const a = re[i], b = im[i];
      re[i] = a * a + b * b;
      im[i] = 0;
    }
    this.fft.inverse(re, im);                  // re[tau] is now the autocorrelation

    const tauMax = this.tauMax, tauMin = this.tauMin, cmnd = this.cmnd;
    let running = 0;
    cmnd[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      const d = pre[W - tau] + (pre[W] - pre[tau]) - 2 * re[tau];
      running += d;
      cmnd[tau] = running > 1e-12 ? d * tau / running : 1;
    }

    let tauEst = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cmnd[tau] < YIN_THRESHOLD) {
        while (tau + 1 < tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) {                          // nothing convincing: best guess, low confidence
      let best = Infinity;
      for (let tau = tauMin; tau < tauMax; tau++) {
        if (cmnd[tau] < best) { best = cmnd[tau]; tauEst = tau; }
      }
    }
    if (tauEst < tauMin) { this.confidence = 0; this.voiced = false; return; }

    let tau = tauEst;
    if (tauEst > tauMin && tauEst + 1 <= tauMax) {   // parabolic refinement
      const a = cmnd[tauEst - 1], b = cmnd[tauEst], c = cmnd[tauEst + 1];
      const denom = a - 2 * b + c;
      if (Math.abs(denom) > 1e-12) tau = tauEst + 0.5 * (a - c) / denom;
    }

    this.confidence = Math.max(0, Math.min(1, 1 - cmnd[tauEst]));
    this.voiced = this.confidence >= VOICED_CONFIDENCE;
    if (this.voiced) {
      this.T0 = tau;
      this.f0 = sampleRate / tau;
    }
  }

  pushMark(m) {
    this.marks[this.markHead] = m;
    this.markHead = (this.markHead + 1) % MAX_MARKS;
    if (this.markCount < MAX_MARKS) this.markCount++;
  }

  /**
   * Predict the next glottal pulse one period ahead, then snap to the local
   * waveform peak nearby. Marks stay at least a full grain behind the write
   * head so a grain never reads samples that have not arrived.
   */
  updateMarks() {
    const T0 = this.T0;
    const r = Math.max(1, Math.round(T0 / 4));
    if (!this.markInit) {
      this.nextMarkPred = this.write - Math.ceil(T0) - r;
      this.markInit = true;
    }
    let guard = 0;
    while (this.nextMarkPred + Math.ceil(T0) + r < this.write && guard++ < 64) {
      const pred = Math.round(this.nextMarkPred);
      let best = pred, bestV = -Infinity;
      for (let k = -r; k <= r; k++) {
        const val = this.buf[(pred + k) & BUF_MASK];
        if (val > bestV) { bestV = val; best = pred + k; }
      }
      this.pushMark(best);
      this.nextMarkPred = best + T0;
    }
    if (guard >= 64) this.nextMarkPred = this.write - Math.ceil(T0) - r;
  }

  nearestMark(target) {
    if (this.markCount === 0) return null;
    let best = null, bestD = Infinity;
    for (let i = 0; i < this.markCount; i++) {
      const m = this.marks[i];
      const d = Math.abs(m - target);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  /* ---------- synthesis ---------- */

  targetRatio(v) {
    if (this.absolute && v.midi !== null) {
      const hz = 440 * Math.pow(2, (v.midi - 69) / 12);
      if (this.f0 > 0) return Math.max(0.25, Math.min(4, hz / this.f0));
      return v.ratio;                            // no pitch yet: hold
    }
    return Math.max(0.25, Math.min(4, Math.pow(2, v.semis / 12)));
  }

  readInterpolated(pos) {
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = this.buf[i0 & BUF_MASK];
    const b = this.buf[(i0 + 1) & BUF_MASK];
    return a + (b - a) * frac;
  }

  /**
   * Lay down one grain: input centred on an analysis mark, Hann-windowed, added
   * at the output position, with a parallel window sum normalising the
   * overlap-add.
   *
   * The grain half-width is min(analysis period, synthesis period), not simply
   * the analysis period. Shifting up packs synthesis marks closer than the
   * analysis marks, so full-width grains pile several copies of the same
   * waveform on top of each other offset by T1 - and since the waveform repeats
   * every T0, those copies are out of phase and partly cancel. Measured, that
   * cost 3.6 dB at an octave and 8.4 dB at +19 semitones. Sizing the grain to
   * the synthesis period keeps neighbours at a clean 50% overlap and holds the
   * level to within ~1.7 dB across the range.
   */
  placeGrain(v, centerOut, T0, T1) {
    const mark = this.nearestMark(centerOut - this.delay);
    if (mark === null) return;
    const half = Math.max(8, Math.round(Math.min(T0, T1)));
    const center = Math.round(centerOut);
    for (let k = -half; k <= half; k++) {
      const w = 0.5 + 0.5 * Math.cos(Math.PI * k / half);
      const o = (center + k) & ACC_MASK;
      v.acc[o] += w * this.buf[(mark + k) & BUF_MASK];
      v.wsum[o] += w;
    }
  }

  renderPsola(v, out, frameStart, n) {
    const T0 = this.T0;
    const T1 = Math.max(4, T0 / v.ratio);
    const horizon = frameStart + n + T0;
    if (v.nextOut < frameStart) v.nextOut = frameStart;
    let guard = 0;
    while (v.nextOut < horizon && guard++ < 256) {
      this.placeGrain(v, v.nextOut, T0, T1);
      v.nextOut += T1;
    }
    for (let i = 0; i < n; i++) {
      const idx = (frameStart + i) & ACC_MASK;
      const w = v.wsum[idx];
      const s = w > 1e-4 ? v.acc[idx] / w : 0;
      v.acc[idx] = 0;
      v.wsum[idx] = 0;
      v.gain += (v.gainTarget - v.gain) * this.gainCoef;
      out[i] += s * v.gain * this.duckBuf[i];
    }
  }

  /** Phase 1's splice-crossfade resampler, kept for A/B against PSOLA. */
  renderResample(v, out, frameStart, n) {
    const G = this.grain;
    const step = 1 - v.ratio;
    const thr = Math.abs(step) * this.xfade;
    for (let i = 0; i < n; i++) {
      const base = frameStart + i - this.delay;
      const d = v.delayPos;
      let s;
      if (thr > 0 && d < thr) {
        const u = (d / thr) * (Math.PI / 2);
        s = Math.sin(u) * this.readInterpolated(base - d)
          + Math.cos(u) * this.readInterpolated(base - d - G);
      } else {
        s = this.readInterpolated(base - d);
      }
      v.delayPos += step;
      if (v.delayPos >= G) v.delayPos -= G;
      else if (v.delayPos < 0) v.delayPos += G;

      v.gain += (v.gainTarget - v.gain) * this.gainCoef;
      out[i] += s * v.gain * this.duckBuf[i];
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const input = inputs[0][0];
    const n = out.length;

    for (let i = 0; i < n; i++) {
      this.buf[(this.write + i) & BUF_MASK] = input ? input[i] : 0;
    }
    const frameStart = this.write;
    this.write += n;

    this.hopCounter += n;
    if (this.hopCounter >= HOP) {
      this.hopCounter = 0;
      this.analyse();
    }
    this.updateMarks();

    if (this.duckBuf.length !== n) this.duckBuf = new Float32Array(n);
    const duckTarget = this.voiced ? 1 : UNVOICED_DUCK;
    for (let i = 0; i < n; i++) {
      this.duck += (duckTarget - this.duck) * this.duckCoef;
      this.duckBuf[i] = this.duck;
    }

    out.fill(0);
    for (const v of this.voices) {
      if (!v.active && v.gain < 1e-4) continue;
      v.ratioTarget = this.targetRatio(v);
      v.ratio += (v.ratioTarget - v.ratio) * this.ratioCoef;
      if (this.mode === 'psola') this.renderPsola(v, out, frameStart, n);
      else this.renderResample(v, out, frameStart, n);
    }

    this.reportCounter += n;
    if (this.reportCounter >= 2048) {
      this.reportCounter = 0;
      this.postStatus();
    }
    return true;
  }
}

registerProcessor('messina-engine', MessinaEngine);
