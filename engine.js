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
const PSOLA_FLOOR = 0.5;         // below an octave down, PSOLA grains stop overlapping
const JUMP_SEMIS = 7;            // a pitch leap this big must prove itself...
const JUMP_CONFIRM = 4;          // ...by holding for this many hops (~21 ms)
const REACQUIRE_HOPS = 20;       // after ~100 ms unvoiced, trust the first reading
const OCTAVE_RESCUE = 0.5;       // YIN dip at the old period that still counts as that pitch

// Where each voice slot sits at full spread (-1 left, 1 right) and which way
// it detunes. Opposite sides detune opposite ways, as a doubler would, and the
// order fills outwards so a three-note chord is already wide.
const VOICE_PAN = [-1, 1, -0.5, 0.5, -0.75, 0.75, -0.25, 0.25];
const VOICE_DETUNE = [1, -1, 0.5, -0.5, 0.75, -0.75, 0.25, -0.25];

// Voice shaping. Defaults are neutral: they reproduce the engine as it was.
const SHAPE_DEFAULTS = {
  attack: 0.036,                 // seconds to ~95%; 36 ms is the old fixed 12 ms time constant
  release: 0.036,
  glide: 0,                      // seconds for a voice to slide to a new note; 0 jumps
  lfoRate: 5,                    // Hz
  lfoDepth: 0,                   // 0..1, scaled per target below
  lfoShape: 'sine',              // sine | triangle | square | random
  lfoTarget: 'pitch',            // pitch | volume | pan | filter
  cutoff: 20000,                 // Hz; at the top the filter is bypassed outright
  resonance: 0,                  // 0..1
  formant: 0,                    // semitones; PSOLA only
};
const LFO_PITCH_SEMIS = 1;       // depth 1 = +/- a semitone of vibrato
const LFO_FILTER_OCTAVES = 3;    // depth 1 = +/- three octaves of sweep
const FILTER_OPEN = 19999;

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
    this.spread = 0;                 // 0 centred .. 1 fully spread
    this.detune = 0;                 // cents at a voice's full offset

    this.f0 = 0;
    this.confidence = 0;
    this.voiced = false;
    this.duck = 1;
    this.unvoicedHops = REACQUIRE_HOPS;
    this.pendingTau = 0;
    this.pendingCount = 0;

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
        nextOut: 0, delayPos: 0, blend: 1,
        pan: VOICE_PAN[i], detune: VOICE_DETUNE[i], gainL: 1, gainR: 1,
        note: 0, ratioOut: 1,                      // glided note; ratio after the LFO
        lfoOffset: i / MAX_VOICES, lfoVal: 0, lfoCycle: -1, lfoHeld: 0,
        ic1: 0, ic2: 0,                            // filter state
        acc: new Float32Array(ACC), wsum: new Float32Array(ACC),
      });
    }

    this.blendCoef = 1 - Math.exp(-1 / (0.030 * sampleRate));
    this.lfoSmoothCoef = 1 - Math.exp(-1 / (0.003 * sampleRate));   // de-clicks square and random
    this.lfoPhase = 0;
    this.setShape(SHAPE_DEFAULTS);
    this.duckBuf = new Float32Array(128);
    this.tmpA = new Float32Array(128);
    this.tmpB = new Float32Array(128);
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
    this.unvoicedHops = REACQUIRE_HOPS;          // T0 was just reset: don't judge leaps against it
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'noteOn': {
        // Prefer a silent voice, then the quietest released one, so long release
        // tails aren't cut short or bent toward the next note.
        let voice = this.voices.find((v) => v.id === msg.id)
          || this.voices.find((v) => !v.active && v.gain < 1e-3)
          || this.voices.filter((v) => !v.active).sort((a, b) => a.gain - b.gain)[0]
          || this.voices[0];
        if (voice.id !== null && voice.id !== msg.id) voice.gainTarget = 0;
        // Only rebuild the grain stream for a genuinely idle voice: doing it to
        // one still ramping down would cut its tail dead and click.
        const fresh = !voice.active && voice.gain < 1e-3;
        voice.id = msg.id;
        voice.active = true;
        voice.midi = msg.midi ?? null;
        voice.semis = msg.semis ?? 0;
        if (fresh || this.glideCoef >= 1) voice.note = this.noteTarget(voice);
        voice.gainTarget = typeof msg.gain === 'number' ? Math.max(0, Math.min(1, msg.gain)) : 1;
        if (fresh) {
          voice.nextOut = this.write;
          voice.delayPos = 0;
          voice.acc.fill(0);
          voice.wsum.fill(0);
          voice.ic1 = voice.ic2 = 0;
          voice.ratio = this.targetRatio(voice);
          voice.ratioOut = voice.ratio;
          voice.blend = this.psolaTarget(voice);
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
        if (typeof msg.spread === 'number') this.spread = Math.max(0, Math.min(1, msg.spread));
        if (typeof msg.detune === 'number') this.detune = Math.max(0, Math.min(50, msg.detune));
        if (msg.shape) this.setShape(msg.shape);
        if (msg.window && msg.fmin && (msg.window !== this.W || msg.fmin !== this.fmin)) {
          this.configure(msg.window, msg.fmin);
        }
        this.postStatus();
        break;
    }
  }

  /** Envelope, glide, LFO, filter and formant settings; unknown keys are ignored. */
  setShape(shape) {
    this.shape = { ...(this.shape || SHAPE_DEFAULTS), ...shape };
    const sh = this.shape;
    // Times are to ~95% of the way (three time constants), which is what an
    // envelope's attack and release read as.
    const coef = (seconds, step) => (seconds <= 0 ? 1 : 1 - Math.exp(-step / (seconds / 3 * sampleRate)));
    this.attackCoef = coef(Math.max(0.001, sh.attack), 1);
    this.releaseCoef = coef(Math.max(0.001, sh.release), 1);
    this.glideCoef = coef(sh.glide, 128);
    this.formantScale = Math.pow(2, Math.max(-12, Math.min(12, sh.formant)) / 12);
  }

  /** What a voice glides toward: an absolute note, or an interval. */
  noteTarget(v) {
    return v.midi !== null ? v.midi : v.semis;
  }

  /** -1..1 for this voice at LFO phase `p`; each voice runs at its own offset. */
  lfoRaw(v, p) {
    const ph = p + v.lfoOffset;
    const frac = ph - Math.floor(ph);
    switch (this.shape.lfoShape) {
      case 'triangle': return 1 - 4 * Math.abs(frac - 0.5);
      case 'square': return frac < 0.5 ? 1 : -1;
      case 'random': {
        const cycle = Math.floor(ph);
        if (cycle !== v.lfoCycle) { v.lfoCycle = cycle; v.lfoHeld = Math.random() * 2 - 1; }
        return v.lfoHeld;
      }
      default: return Math.sin(2 * Math.PI * frac);
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
    const reacquire = this.unvoicedHops >= REACQUIRE_HOPS;
    this.unvoicedHops++;
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
      this.unvoicedHops = 0;
      if (!reacquire) tau = this.octaveRescue(tau);
      if (this.acceptPitch(tau, reacquire)) {
        this.T0 = tau;
        this.f0 = sampleRate / tau;
      }
    }
  }

  /**
   * Vocal fry or a rough onset makes alternate glottal pulses unequal, which
   * doubles the true period, and YIN duly reports an octave low - for as long
   * as the roughness sits in the 43 ms window, so a 30 ms glitch reads as an
   * octave drop for ~50 ms. Every tracked harmony used to drop with it.
   *
   * The tell is that the old period still fits: measured, YIN's dip there stays
   * below 0.26 through such a glitch, but sits above 1.27 when the voice really
   * has gone down an octave. So a reading at twice the current period is sent
   * back to the current period whenever that still fits.
   */
  octaveRescue(tau) {
    if (Math.abs(12 * Math.log2(tau / (2 * this.T0))) > 1) return tau;
    const cmnd = this.cmnd;
    const r = Math.max(2, Math.round(this.T0 * 0.03));
    const lo = Math.max(this.tauMin + 1, Math.round(this.T0) - r);
    const hi = Math.min(this.tauMax - 1, Math.round(this.T0) + r);
    let best = -1;
    for (let k = lo; k <= hi; k++) if (best < 0 || cmnd[k] < cmnd[best]) best = k;
    if (best < 0 || cmnd[best] >= OCTAVE_RESCUE) return tau;
    const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
    const denom = a - 2 * b + c;
    return Math.abs(denom) > 1e-12 ? best + 0.5 * (a - c) / denom : best;
  }

  /**
   * Any other leap of JUMP_SEMIS or more is held back until it repeats for
   * JUMP_CONFIRM hops, so a one-off misreading passes unheard and a real leap
   * is only ~21 ms late. After a pause a new phrase can start anywhere, so the
   * first reading is trusted.
   */
  acceptPitch(tau, reacquire) {
    const leap = Math.abs(12 * Math.log2(this.T0 / tau));
    if (reacquire || leap < JUMP_SEMIS) {
      this.pendingCount = 0;
      return true;
    }
    if (this.pendingCount > 0 && Math.abs(12 * Math.log2(this.pendingTau / tau)) < 1) {
      this.pendingCount++;
    } else {
      this.pendingTau = tau;
      this.pendingCount = 1;
    }
    if (this.pendingCount < JUMP_CONFIRM) return false;
    this.pendingCount = 0;
    return true;
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

  /**
   * Glide moves the voice's note, not its ratio, so a slow glide only slows
   * chord changes - harmonies still follow your own pitch instantly.
   */
  targetRatio(v) {
    const detune = Math.pow(2, v.detune * this.detune / 1200);
    if (this.absolute && v.midi !== null) {
      const hz = 440 * Math.pow(2, (v.note - 69) / 12);
      if (this.f0 > 0) return Math.max(0.25, Math.min(4, detune * hz / this.f0));
      return v.ratio;                            // no pitch yet: hold
    }
    return Math.max(0.25, Math.min(4, detune * Math.pow(2, (v.midi !== null ? 0 : v.note) / 12)));
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
    const fs = this.formantScale;
    if (fs === 1) {
      for (let k = -half; k <= half; k++) {
        const w = 0.5 + 0.5 * Math.cos(Math.PI * k / half);
        const o = (center + k) & ACC_MASK;
        v.acc[o] += w * this.buf[(mark + k) & BUF_MASK];
        v.wsum[o] += w;
      }
      return;
    }
    // Formant shift: read the grain faster or slower than it is written. The
    // spacing of grains still sets the pitch, but squeezing the waveform inside
    // each one scales the spectral envelope by `fs` - the vocal character moves
    // while the note stays put. Reads never pass the newest sample.
    const newest = this.write - 2;
    for (let k = -half; k <= half; k++) {
      const w = 0.5 + 0.5 * Math.cos(Math.PI * k / half);
      const o = (center + k) & ACC_MASK;
      v.acc[o] += w * this.readInterpolated(Math.min(mark + k * fs, newest));
      v.wsum[o] += w;
    }
  }

  /**
   * PSOLA works by spacing pitch pulses further apart to lower the pitch, but a
   * grain is only about two analysis periods wide. Below roughly an octave down
   * the synthesis spacing exceeds the grain width, so consecutive grains stop
   * touching and the output is literally silence between pulses - 44% silence at
   * two octaves down, heard as a garbled, chopped voice. The source has no
   * content to fill that gap with (a wider grain would carry the original pitch
   * back in), so this is a real limit of the algorithm, not a bug to tune away.
   * Voices below PSOLA_FLOOR crossfade to the resampler instead, which is
   * gap-free; the cost is that their formants move down with the pitch.
   */
  renderPsolaInto(v, buf, frameStart, n) {
    const T0 = this.T0;
    const T1 = Math.max(4, T0 / v.ratioOut);
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
      buf[i] = w > 1e-4 ? v.acc[idx] / w : 0;
      v.acc[idx] = 0;
      v.wsum[idx] = 0;
    }
  }

  /** Phase 1's splice-crossfade resampler: A/B control, and the deep-shift path. */
  renderResampleInto(v, buf, frameStart, n) {
    const G = this.grain;
    const step = 1 - v.ratioOut;
    const thr = Math.abs(step) * this.xfade;
    for (let i = 0; i < n; i++) {
      const base = frameStart + i - this.delay;
      const d = v.delayPos;
      if (thr > 0 && d < thr) {
        const u = (d / thr) * (Math.PI / 2);
        buf[i] = Math.sin(u) * this.readInterpolated(base - d)
               + Math.cos(u) * this.readInterpolated(base - d - G);
      } else {
        buf[i] = this.readInterpolated(base - d);
      }
      v.delayPos += step;
      if (v.delayPos >= G) v.delayPos -= G;
      else if (v.delayPos < 0) v.delayPos += G;
    }
  }

  advanceDelayPos(pos, step, n) {
    const G = this.grain;
    let p = (pos + step * n) % G;
    if (p < 0) p += G;
    return p;
  }

  /** Blend of the two engines for this voice, with hysteresis at the boundary. */
  psolaTarget(v) {
    if (this.mode !== 'psola') return 0;
    if (v.ratio < PSOLA_FLOOR) return 0;
    if (v.ratio > PSOLA_FLOOR * 1.1) return 1;
    return v.blend;                              // inside the dead band: hold
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const outR = outputs[0][1];                 // absent when the host asks for mono
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

    if (this.tmpA.length !== n) { this.tmpA = new Float32Array(n); this.tmpB = new Float32Array(n); }
    out.fill(0);
    if (outR) outR.fill(0);
    const sh = this.shape;
    const lfoOn = sh.lfoDepth > 0;
    const lfoStep = sh.lfoRate / sampleRate;
    const lfoStart = this.lfoPhase;
    this.lfoPhase = (this.lfoPhase + lfoStep * n) % 1;
    const perSample = lfoOn && (sh.lfoTarget === 'volume' || sh.lfoTarget === 'pan');
    const filterOn = sh.cutoff < FILTER_OPEN || (lfoOn && sh.lfoTarget === 'filter');

    for (const v of this.voices) {
      if (!v.active && v.gain < 1e-4) continue;
      v.note += (this.noteTarget(v) - v.note) * this.glideCoef;
      v.ratioTarget = this.targetRatio(v);
      v.ratio += (v.ratioTarget - v.ratio) * this.ratioCoef;

      // Pitch and filter move once per quantum (2.7 ms), which is smooth at LFO
      // rates; volume and pan move per sample below.
      if (lfoOn && !perSample) v.lfoVal += (this.lfoRaw(v, lfoStart) - v.lfoVal) * Math.min(1, this.lfoSmoothCoef * n);
      v.ratioOut = lfoOn && sh.lfoTarget === 'pitch'
        ? v.ratio * Math.pow(2, sh.lfoDepth * LFO_PITCH_SEMIS * v.lfoVal / 12)
        : v.ratio;

      const target = this.psolaTarget(v);
      this.renderPsolaInto(v, this.tmpA, frameStart, n);
      if (v.blend > 0.999 && target > 0.999) {
        // Fully on PSOLA: skip the resampler but keep its delay line advancing,
        // so a later crossfade into it starts from the right phase rather than
        // jumping. Its only state is that phase, so this is exact.
        v.delayPos = this.advanceDelayPos(v.delayPos, 1 - v.ratioOut, n);
      } else {
        this.renderResampleInto(v, this.tmpB, frameStart, n);
      }
      // Equal-power pan, scaled by sqrt(2) so the centre is unity in each ear:
      // spread 0 is exactly the old mono, and panning never changes the power.
      let panL, panR;
      const setPan = (pos) => {
        const theta = (Math.max(-1, Math.min(1, pos)) + 1) * Math.PI / 4;
        panL = Math.SQRT2 * Math.cos(theta);
        panR = Math.SQRT2 * Math.sin(theta);
      };
      setPan(v.pan * this.spread);

      // Resonant low-pass (Cytomic's trapezoidal SVF), one per voice so each
      // can be swept on its own LFO phase. Skipped outright when fully open.
      let a1 = 0, a2 = 0, a3 = 0;
      if (filterOn) {
        let fc = sh.cutoff;
        if (lfoOn && sh.lfoTarget === 'filter') fc *= Math.pow(2, sh.lfoDepth * LFO_FILTER_OCTAVES * v.lfoVal);
        fc = Math.max(30, Math.min(0.45 * sampleRate, fc));
        const g = Math.tan(Math.PI * fc / sampleRate);
        const k = 1 / (0.5 * Math.pow(24, sh.resonance));        // Q from 0.5 to 12
        a1 = 1 / (1 + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
      }

      const up = v.gainTarget > v.gain;
      const envCoef = up ? this.attackCoef : this.releaseCoef;
      let p = lfoStart;
      for (let i = 0; i < n; i++) {
        v.blend += (target - v.blend) * this.blendCoef;
        let s = v.blend > 0.999
          ? this.tmpA[i]
          : v.blend * this.tmpA[i] + (1 - v.blend) * this.tmpB[i];
        if (filterOn) {
          const v3 = s - v.ic2;
          const v1 = a1 * v.ic1 + a2 * v3;
          const v2 = v.ic2 + a2 * v.ic1 + a3 * v3;
          v.ic1 = 2 * v1 - v.ic1;
          v.ic2 = 2 * v2 - v.ic2;
          s = v2;
        }
        v.gain += (v.gainTarget - v.gain) * envCoef;
        let y = s * v.gain * this.duckBuf[i];
        if (perSample) {
          v.lfoVal += (this.lfoRaw(v, p) - v.lfoVal) * this.lfoSmoothCoef;
          p += lfoStep;
          if (sh.lfoTarget === 'volume') y *= 1 - sh.lfoDepth * (0.5 - 0.5 * v.lfoVal);
          else setPan(v.pan * this.spread + sh.lfoDepth * v.lfoVal);
        }
        if (outR) {
          v.gainL += (panL - v.gainL) * this.gainCoef;     // glide, so moving spread doesn't zipper
          v.gainR += (panR - v.gainR) * this.gainCoef;
          out[i] += y * v.gainL;
          outR[i] += y * v.gainR;
        } else {
          out[i] += y;
        }
      }
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
