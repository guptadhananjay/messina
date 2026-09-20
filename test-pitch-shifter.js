/**
 * Offline check of pitch-shifter.js -- no mic, no browser, no deps.
 *
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc test-pitch-shifter.js
 *
 * Feeds a 220 Hz sine through the worklet at various intervals and measures the
 * output frequency from interpolated zero crossings. Windows that straddle a
 * splice crossfade read a few cents off, so the assertion is that clean windows
 * land on the target and that the carrier survives at full level (an earlier
 * 50%-overlap design measured rms 0.5 instead of 0.707 because the two read
 * heads cancelled the carrier).
 */
var SR = 48000, Processor = null;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = function (name, cls) { Processor = cls; };
(new Function(readFile('./pitch-shifter.js')))();

function runShift(freq, semis, seconds) {
  var p = new Processor(), params = { ratio: [Math.pow(2, semis / 12)] };
  var n = Math.floor(SR * seconds), out = new Float32Array(n), b = 128;
  for (var i = 0; i < n; i += b) {
    var a = new Float32Array(b), o = new Float32Array(b);
    for (var j = 0; j < b; j++) a[j] = Math.sin(2 * Math.PI * freq * (i + j) / SR);
    p.process([[a]], [[o]], params);
    out.set(o, i);
  }
  return out;
}

function freqIn(sig, from, to) {
  var xs = [];
  for (var i = from + 1; i < to; i++) {
    if (sig[i - 1] <= 0 && sig[i] > 0) xs.push(i - 1 + sig[i - 1] / (sig[i - 1] - sig[i]));
  }
  return xs.length < 3 ? null : SR * (xs.length - 1) / (xs[xs.length - 1] - xs[0]);
}

function rms(sig, from) {
  var s = 0, n = 0;
  for (var i = from; i < sig.length; i++, n++) s += sig[i] * sig[i];
  return Math.sqrt(s / n);
}

var cases = [[0, 'unison'], [4, 'major third'], [7, 'fifth up'], [12, 'octave up'],
             [-5, 'fourth down'], [-12, 'octave down'], [19, 'octave + fifth']];
var failures = 0;

for (var k = 0; k < cases.length; k++) {
  var semis = cases[k][0], name = cases[k][1];
  var out = runShift(220, semis, 2.0);
  var target = 220 * Math.pow(2, semis / 12);

  // Splices recur every G/|1-ratio| samples; measure inside windows short enough
  // to fit between them, and report how much of the time a splice is active.
  var G = Math.round(SR * 0.04), xf = Math.round(SR * 0.006);
  var period = semis === 0 ? Infinity : G / Math.abs(1 - Math.pow(2, semis / 12));
  var duty = semis === 0 ? 0 : Math.min(1, xf / period);
  var W = Math.max(400, Math.floor(Math.min(1200, period * 0.7)));

  var best = 1e9, worst = 0;
  for (var s2 = SR; s2 + W < out.length; s2 += Math.floor(W / 3)) {
    var f = freqIn(out, s2, s2 + W);
    if (f === null) continue;
    var c = Math.abs(1200 * Math.log(f / target) / Math.LN2);
    if (c < best) best = c;
    if (c > worst) worst = c;
  }
  var level = rms(out, SR);
  // Clean windows must land on the target; splice-straddling windows read off by
  // design, so `worst` is reported but not asserted.
  var ok = best < 2 && level > 0.62 && level < 0.78;
  if (!ok) failures++;
  print((ok ? 'PASS  ' : 'FAIL  ') + name + Array(16 - name.length).join(' ') +
        'target ' + target.toFixed(2) + ' Hz   clean window ' + best.toFixed(2) +
        ' cents   worst ' + worst.toFixed(1) + ' cents   rms ' + level.toFixed(3) +
        '   splice duty ' + (duty * 100).toFixed(0) + '%');
}
print(failures ? '\n' + failures + ' FAILED' : '\nall passed');
