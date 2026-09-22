/**
 * Offline checks for engine.js -- no browser, no mic, no dependencies.
 *
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc test-engine.js
 *
 * Absorbs the old test-pitch-shifter.js assertions (now the engine's `resample`
 * mode) and adds the two that matter for Phase 2: does YIN find the pitch, and
 * does PSOLA leave the formants alone.
 *
 * The formant test is differential on purpose. If `resample` mode does NOT fail
 * it, the test is not measuring what it claims to, so it asserts both that
 * PSOLA holds formants still and that resampling drags them with the pitch.
 */

var SR = 48000;
var Processor = null;

globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { postMessage: function () {}, onmessage: null }; }
};
globalThis.registerProcessor = function (name, cls) { Processor = cls; };
(new Function(readFile('./engine.js')))();

/* ---------- signal generation ---------- */

/** Two-pole resonator, used to paint formants onto an excitation. */
function resonator(x, freq, bw) {
  var r = Math.exp(-Math.PI * bw / SR);
  var theta = 2 * Math.PI * freq / SR;
  var a1 = 2 * r * Math.cos(theta), a2 = -r * r;
  var y = new Float32Array(x.length), y1 = 0, y2 = 0;
  for (var i = 0; i < x.length; i++) {
    var v = (1 - r) * x[i] + a1 * y1 + a2 * y2;
    y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** A crude but honest voice: glottal impulse train through three formants. */
function syntheticVoice(f0, seconds, formants) {
  formants = formants || [700, 1220, 2600];
  var n = Math.floor(SR * seconds);
  var x = new Float32Array(n);
  var period = SR / f0, next = 0;
  for (var i = 0; i < n; i++) {
    if (i >= next) { x[i] = 1; next += period; }
  }
  var out = new Float32Array(n);
  for (var f = 0; f < formants.length; f++) {
    var band = resonator(x, formants[f], 90 + f * 40);
    var weight = 1 / (1 + f);
    for (var i2 = 0; i2 < n; i2++) out[i2] += band[i2] * weight;
  }
  var peak = 0;
  for (var i3 = 0; i3 < n; i3++) peak = Math.max(peak, Math.abs(out[i3]));
  for (var i4 = 0; i4 < n; i4++) out[i4] /= (peak || 1);
  return out;
}

function sine(f0, seconds) {
  var n = Math.floor(SR * seconds), x = new Float32Array(n);
  for (var i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * f0 * i / SR);
  return x;
}

/* ---------- running the engine ---------- */

function runEngine(signal, opts) {
  var p = new Processor();
  p.onMessage({ type: 'config', mode: opts.mode || 'psola',
                absolute: opts.absolute === true,
                window: opts.window || 2048, fmin: opts.fmin || 82 });
  if (opts.midi !== undefined) p.onMessage({ type: 'noteOn', id: 'v0', midi: opts.midi });
  else if (opts.semis !== undefined) p.onMessage({ type: 'noteOn', id: 'v0', semis: opts.semis });

  var out = new Float32Array(signal.length), block = 128;
  for (var i = 0; i + block <= signal.length; i += block) {
    var inBuf = new Float32Array(block), outBuf = new Float32Array(block);
    inBuf.set(signal.subarray(i, i + block));
    p.process([[inBuf]], [[outBuf]], {});
    out.set(outBuf, i);
  }
  return { out: out, engine: p };
}

/* ---------- measurement (independent of the implementation) ---------- */

/** Normalized autocorrelation, first peak past the first zero crossing. */
function estimateF0(sig, from) {
  var seg = sig.subarray(from, from + Math.min(SR, sig.length - from));
  var minLag = Math.floor(SR / 800), maxLag = Math.floor(SR / 60);
  var r = new Float64Array(maxLag + 2);
  for (var lag = 0; lag <= maxLag; lag++) {
    var s = 0, ea = 0, eb = 0;
    for (var i = 0; i + lag < seg.length; i++) {
      s += seg[i] * seg[i + lag]; ea += seg[i] * seg[i]; eb += seg[i + lag] * seg[i + lag];
    }
    r[lag] = s / (Math.sqrt(ea * eb) + 1e-12);
  }
  var lag2 = minLag;
  while (lag2 < maxLag && r[lag2] > 0) lag2++;
  var best = -1, bestLag = minLag;
  for (; lag2 < maxLag; lag2++) if (r[lag2] > best) { best = r[lag2]; bestLag = lag2; }
  // The tallest ACF peak is often at 2T rather than T; prefer the earliest lag
  // that correlates nearly as well, or this reports everything an octave low.
  for (var div = 4; div >= 2; div--) {
    var cand = Math.round(bestLag / div);
    if (cand >= minLag && r[cand] > best * 0.85) { bestLag = cand; break; }
  }
  var a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1];
  var d = (a - c) / (2 * (a - 2 * b + c) + 1e-12);
  return SR / (bestLag + d);
}

/** Magnitude spectrum by direct DFT at fixed frequencies - slow, but neutral. */
function spectrum(sig, from, len, fMax, step) {
  var mags = [], freqs = [];
  for (var f = step; f <= fMax; f += step) {
    var re = 0, im = 0;
    for (var i = 0; i < len; i++) {
      var w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / len);    // Hann
      var ph = 2 * Math.PI * f * i / SR;
      re += sig[from + i] * w * Math.cos(ph);
      im += sig[from + i] * w * Math.sin(ph);
    }
    freqs.push(f);
    mags.push(Math.sqrt(re * re + im * im) / len);
  }
  return { freqs: freqs, mags: mags };
}

/**
 * Spectral envelope peaks: smooth the spectrum over roughly one f0 so the
 * harmonic comb disappears and only the formant humps remain.
 */
function spectralEnvelope(sig, from, f0) {
  var step = 20, fMax = 4000, len = 4096;
  var sp = spectrum(sig, from, len, fMax, step);
  // Averaging a harmonic comb in the linear domain leaves ripple at the comb
  // period, so local maxima land on harmonics rather than formants. Ride the
  // harmonic peaks with a max filter one f0 wide first, then round it off.
  var width = Math.max(2, Math.round(f0 / step));
  var env = [];
  for (var i = 0; i < sp.mags.length; i++) {
    var m = 0;
    for (var k = -width; k <= width; k++) {
      var j = i + k;
      if (j >= 0 && j < sp.mags.length) m = Math.max(m, sp.mags[j]);
    }
    env.push(m);
  }
  var smooth = [];
  for (var i1 = 0; i1 < env.length; i1++) {
    var s = 0, n = 0;
    for (var k1 = -width; k1 <= width; k1++) {
      var j1 = i1 + k1;
      if (j1 >= 0 && j1 < env.length) { s += env[j1]; n++; }
    }
    smooth.push(s / n);
  }
  var db = smooth.map(function (m) { return 20 * Math.log(m + 1e-12) / Math.LN10; });
  return { freqs: sp.freqs, db: db };
}

function formantPeaks(env, count) {
  var peaks = [];
  for (var i = 1; i < env.db.length - 1; i++) {
    if (env.db[i] > env.db[i - 1] && env.db[i] >= env.db[i + 1]) {
      peaks.push({ f: env.freqs[i], m: env.db[i] });
    }
  }
  peaks.sort(function (a, b) { return b.m - a.m; });
  return peaks.slice(0, count || 3).map(function (p) { return p.f; })
              .sort(function (a, b) { return a - b; });
}

function envAt(env, f) {
  var step = env.freqs[1] - env.freqs[0];
  var x = (f - env.freqs[0]) / step;
  if (x <= 0) return env.db[0];
  if (x >= env.db.length - 1) return env.db[env.db.length - 1];
  var i = Math.floor(x), frac = x - i;
  return env.db[i] + (env.db[i + 1] - env.db[i]) * frac;
}

/**
 * How far did the formant structure move? Warp the source envelope by a range
 * of frequency scale factors and report the one that best matches the output.
 * ~1.0 means the formants stayed put; ~2.0 means they followed an octave shift.
 * This measures the actual claim, rather than pairing up peak lists and hoping
 * the same number of peaks resolved in both.
 */
function bestScale(srcEnv, outEnv) {
  var lo = 200, hi = 3800, best = 0, bestS = 1;
  for (var s = 0.5; s <= 2.6; s += 0.01) {
    var xs = [], ys = [];
    for (var f = lo; f <= hi; f += 20) {
      xs.push(envAt(srcEnv, f / s));
      ys.push(envAt(outEnv, f));
    }
    var n = xs.length, mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var num = 0, dx = 0, dy = 0;
    for (var j = 0; j < n; j++) {
      var a = xs[j] - mx, b = ys[j] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    var corr = num / (Math.sqrt(dx * dy) + 1e-12);
    if (corr > best) { best = corr; bestS = s; }
  }
  return { scale: bestS, corr: best };
}

function cents(got, want) { return 1200 * Math.log(got / want) / Math.LN2; }
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

var failures = 0;
function check(ok, name, detail) {
  if (!ok) failures++;
  print((ok ? 'PASS  ' : 'FAIL  ') + pad(name, 34) + detail);
}

/* ---------- 1. YIN on plain sines ---------- */

print('-- pitch detection --');
[82, 110, 147, 196, 220, 330, 440, 587].forEach(function (f0) {
  var r = runEngine(sine(f0, 0.5), { mode: 'resample', semis: 0 });
  var c = cents(r.engine.f0, f0);
  check(Math.abs(c) < 5 && r.engine.confidence > 0.8,
        'sine ' + f0 + ' Hz',
        'detected ' + r.engine.f0.toFixed(2) + ' Hz (' + c.toFixed(2) +
        ' cents), confidence ' + r.engine.confidence.toFixed(2));
});

/* ---------- 2. YIN on a synthetic voice ---------- */

[98, 147, 196, 294].forEach(function (f0) {
  var r = runEngine(syntheticVoice(f0, 0.5), { mode: 'resample', semis: 0 });
  var c = cents(r.engine.f0, f0);
  check(Math.abs(c) < 10 && r.engine.voiced,
        'voice ' + f0 + ' Hz',
        'detected ' + r.engine.f0.toFixed(2) + ' Hz (' + c.toFixed(2) +
        ' cents), confidence ' + r.engine.confidence.toFixed(2));
});

/* ---------- 3. PSOLA pitch accuracy ---------- */

print('-- psola pitch --');
[[0, 'unison'], [4, 'major third'], [7, 'fifth up'], [12, 'octave up'], [-5, 'fourth down']]
  .forEach(function (c) {
    var semis = c[0];
    var sig = syntheticVoice(150, 1.2);
    var r = runEngine(sig, { mode: 'psola', semis: semis });
    var want = 150 * Math.pow(2, semis / 12);
    var got = estimateF0(r.out, Math.floor(SR * 0.5));
    check(Math.abs(cents(got, want)) < 25,
          'psola ' + c[1],
          'want ' + want.toFixed(1) + ' Hz, got ' + got.toFixed(1) +
          ' Hz (' + cents(got, want).toFixed(1) + ' cents)');
  });

/* ---------- 3b. level flatness across the range ---------- */

print('-- output level --');
(function () {
  var sig = syntheticVoice(150, 1.2);
  var from = Math.floor(SR * 0.6);
  var ref = 0, n = 0;
  for (var i = from; i < sig.length; i++, n++) ref += sig[i] * sig[i];
  ref = Math.sqrt(ref / n);

  var worst = 0, detail = '';
  [-12, -7, -5, 0, 3, 5, 7, 10, 12, 15, 19].forEach(function (semis) {
    var r = runEngine(sig, { mode: 'psola', semis: semis });
    var s = 0, m = 0;
    for (var i = from; i < r.out.length; i++, m++) s += r.out[i] * r.out[i];
    var db = 20 * Math.log(Math.sqrt(s / m) / ref) / Math.LN10;
    worst = Math.max(worst, Math.abs(db));
    detail += (semis >= 0 ? '+' : '') + semis + ':' + db.toFixed(1) + ' ';
  });
  // Grains sized to the analysis period instead of the synthesis period cost
  // 8.4 dB at +19; anything over 3 dB means that regression is back.
  check(worst < 3, 'level holds across the range',
        'worst ' + worst.toFixed(1) + ' dB  [' + detail.trim() + ']');
})();

/* ---------- 4. formants: the differential test ---------- */

print('-- formant preservation (the point of phase 2) --');
var src = syntheticVoice(150, 1.5);
var srcEnv = spectralEnvelope(src, Math.floor(SR * 0.5), 150);

var psola = runEngine(src, { mode: 'psola', semis: 12 });
var resamp = runEngine(src, { mode: 'resample', semis: 12 });
var psolaEnv = spectralEnvelope(psola.out, Math.floor(SR * 0.7), 300);
var resampEnv = spectralEnvelope(resamp.out, Math.floor(SR * 0.7), 300);

var psolaScale = bestScale(srcEnv, psolaEnv);
var resampScale = bestScale(srcEnv, resampEnv);

print('      source formants   ' + formantPeaks(srcEnv, 3).join(', ') + ' Hz  (built at 700, 1220, 2600)');
print('      psola    +12      ' + formantPeaks(psolaEnv, 3).join(', ') + ' Hz');
print('      resample +12      ' + formantPeaks(resampEnv, 3).join(', ') + ' Hz');

check(Math.abs(psolaScale.scale - 1) < 0.12, 'psola holds formants',
      'envelope moved x' + psolaScale.scale.toFixed(2) +
      ' (want ~x1.00, match ' + psolaScale.corr.toFixed(2) + ')');
check(resampScale.scale > 1.7, 'resample drags formants (control)',
      'envelope moved x' + resampScale.scale.toFixed(2) +
      ' (want ~x2.00, match ' + resampScale.corr.toFixed(2) + ')');

/* ---------- 4b. changing chord mid-hold ---------- */

print('-- chord change while held --');
(function () {
  // Arrow keys retarget a sounding voice instead of releasing and retriggering
  // it. Verify that switching note mid-stream leaves no gap and no click.
  var sig = syntheticVoice(150, 1.4);
  var p = new Processor();
  p.onMessage({ type: 'config', mode: 'psola', absolute: false, window: 2048, fmin: 82 });
  p.onMessage({ type: 'noteOn', id: 'chord:0', semis: 0 });

  var out = new Float32Array(sig.length), block = 128;
  var switchAt = Math.floor(SR * 0.7);
  for (var i = 0; i + block <= sig.length; i += block) {
    if (i <= switchAt && i + block > switchAt) {
      p.onMessage({ type: 'noteOn', id: 'chord:0', semis: 5 });   // same id: retarget
    }
    var a = new Float32Array(block), o = new Float32Array(block);
    a.set(sig.subarray(i, i + block));
    p.process([[a]], [[o]], {});
    out.set(o, i);
  }

  function windowRms(from, len) {
    var s = 0;
    for (var i = from; i < from + len; i++) s += out[i] * out[i];
    return Math.sqrt(s / len);
  }
  var before = windowRms(switchAt - Math.floor(SR * 0.05), Math.floor(SR * 0.04));
  var during = windowRms(switchAt, Math.floor(SR * 0.03));
  var after = windowRms(switchAt + Math.floor(SR * 0.08), Math.floor(SR * 0.04));

  var maxStep = 0, peak = 0;
  for (var j = switchAt - 2000; j < switchAt + 4000; j++) {
    peak = Math.max(peak, Math.abs(out[j]));
    maxStep = Math.max(maxStep, Math.abs(out[j] - out[j - 1]));
  }

  check(during > before * 0.5, 'no gap when the chord changes',
        'rms before ' + before.toFixed(3) + ', across the change ' + during.toFixed(3) +
        ', after ' + after.toFixed(3));
  check(maxStep < peak * 0.5, 'no click when the chord changes',
        'largest step ' + maxStep.toFixed(3) + ' vs peak ' + peak.toFixed(3));

  var got = estimateF0(out, switchAt + Math.floor(SR * 0.2));
  var want = 150 * Math.pow(2, 5 / 12);
  check(Math.abs(cents(got, want)) < 25, 'lands on the new note',
        'want ' + want.toFixed(1) + ' Hz, got ' + got.toFixed(1) + ' Hz');
})();

/* ---------- 5. continuity ---------- */

print('-- continuity --');
(function () {
  var sig = syntheticVoice(150, 1.0);
  var r = runEngine(sig, { mode: 'psola', semis: 7 });
  var from = Math.floor(SR * 0.4);
  var nan = false, maxStep = 0, peak = 0;
  for (var i = from; i < r.out.length; i++) {
    if (!isFinite(r.out[i])) nan = true;
    peak = Math.max(peak, Math.abs(r.out[i]));
    if (i > from) maxStep = Math.max(maxStep, Math.abs(r.out[i] - r.out[i - 1]));
  }
  check(!nan, 'no NaN or Inf in output', 'peak ' + peak.toFixed(3));
  check(maxStep < peak * 0.5, 'no sample-level discontinuities',
        'largest step ' + maxStep.toFixed(3) + ' vs peak ' + peak.toFixed(3));
  check(peak > 0.1 && peak < 1.5, 'output level sane', 'peak ' + peak.toFixed(3));
})();

print('');
print(failures ? failures + ' FAILED' : 'all passed');
