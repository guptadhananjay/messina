/**
 * Messina - phase 1.
 *
 * mic -> inputGain -+-> dryGain ----------------------+-> mixBus -+-> masterGain -> out
 *                   |                                 |           |
 *                   +-> [8 x shifter -> voiceGain] -> harmonyGain +-> convolver -> wetGain -^
 *
 * Two ways to drive it: hold keys for individual intervals, or load a chord
 * chart and tap space to step through it.
 */
import { parseProgression, chordVoices, NOTE_NAMES } from './chords.js';

const VOICE_COUNT = 8;
const RAMP = 0.015;          // key attack/release, seconds
const SEMITONE_MIN = -24;
const SEMITONE_MAX = 24;

// Piano layout on the home rows: a=C ... k=C an octave up.
const KEY_MAP = [
  ['a', 0], ['w', 1], ['s', 2], ['e', 3], ['d', 4], ['f', 5], ['t', 6],
  ['g', 7], ['y', 8], ['h', 9], ['u', 10], ['j', 11], ['k', 12],
];
const DEFAULT_CHART = 'Am | F | C | G';

const $ = (id) => document.getElementById(id);
const semitonesFor = new Map(KEY_MAP);
const held = new Map();      // voice id -> voice
const keyEls = new Map();    // keyboard key -> element
let voices = [];
let ctx = null;
let nodes = null;
let stream = null;           // mic tracks, so stop() can switch the input off
let meterRaf = null;
let octave = 0;
let muted = false;

let chart = [];              // [{ token, chord }]
let nextIndex = 0;           // chord queued for the next press
let playingIndex = null;     // chord currently sounding, if any
let reference = 0;           // pitch class you are singing

/* ---------- UI scaffolding ---------- */

for (const [key, semis] of KEY_MAP) {
  const el = document.createElement('div');
  el.className = 'key' + (NOTE_NAMES[semis % 12].includes('#') ? ' black' : '');
  el.innerHTML = `<b>${key}</b><span>${NOTE_NAMES[semis % 12]}</span>`;
  $('keys').appendChild(el);
  keyEls.set(key, el);
}

for (let pc = 0; pc < 12; pc++) {
  const opt = document.createElement('option');
  opt.value = String(pc);
  opt.textContent = NOTE_NAMES[pc];
  $('reference').appendChild(opt);
}
$('reference').value = '0';
$('reference').addEventListener('change', () => {
  reference = Number($('reference').value);
  renderChart();
  if (playingIndex !== null) soundChord(playingIndex);
});

const sliders = {
  dry: (v) => nodes.dry.gain.setTargetAtTime(v, ctx.currentTime, 0.01),
  harmony: (v) => nodes.harmony.gain.setTargetAtTime(v, ctx.currentTime, 0.01),
  reverb: (v) => nodes.wet.gain.setTargetAtTime(v, ctx.currentTime, 0.01),
  master: (v) => nodes.master.gain.setTargetAtTime(muted ? 0 : v, ctx.currentTime, 0.01),
};

for (const name of Object.keys(sliders)) {
  const input = $(name);
  input.addEventListener('input', () => {
    $(name + 'V').textContent = Number(input.value).toFixed(2);
    if (ctx) sliders[name](Number(input.value));
  });
}

/* ---------- audio graph ---------- */

function impulseResponse(context, seconds = 2.2, decay = 2.6) {
  const len = Math.floor(context.sampleRate * seconds);
  const ir = context.createBuffer(2, len, context.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}

async function start() {
  $('start').disabled = true;
  $('status').textContent = 'Requesting microphone...';

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('pitch-shifter.js');
    await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const harmony = ctx.createGain();
    const mix = ctx.createGain();
    const convolver = ctx.createConvolver();
    const wet = ctx.createGain();
    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;

    convolver.buffer = impulseResponse(ctx);

    source.connect(input);
    input.connect(analyser);
    input.connect(dry).connect(mix);
    harmony.connect(mix);
    mix.connect(master);
    mix.connect(convolver).connect(wet).connect(master);
    master.connect(ctx.destination);

    voices = Array.from({ length: VOICE_COUNT }, () => {
      const shifter = new AudioWorkletNode(ctx, 'pitch-shifter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [1],
      });
      const gain = ctx.createGain();
      gain.gain.value = 0;
      input.connect(shifter).connect(gain).connect(harmony);
      return { shifter, gain, id: null };
    });

    nodes = { input, dry, harmony, mix, wet, master, analyser };
    for (const name of Object.keys(sliders)) sliders[name](Number($(name).value));

    $('start').textContent = 'Stop';
    $('start').classList.add('running');
    $('start').disabled = false;
    $('status').textContent = 'Running - sing and hold keys';
    $('sr').textContent = ctx.sampleRate + ' Hz';
    const rt = (ctx.baseLatency + (ctx.outputLatency || 0)) * 1000;
    $('latency').textContent = rt ? rt.toFixed(1) + ' ms' : 'unknown';

    meterLoop(analyser);
  } catch (err) {
    console.error(err);
    $('status').textContent = 'Failed: ' + err.message;
    $('start').disabled = false;
    stream = null;
  }
}

/** Tear the rig down: silence every voice, release the mic, close the context. */
async function stop() {
  $('start').disabled = true;

  cancelAnimationFrame(meterRaf);
  meterRaf = null;

  for (const id of [...held.keys()]) voiceOff(id);
  for (const el of keyEls.values()) el.classList.remove('on');
  playingIndex = null;
  renderChart();

  const dying = ctx;
  ctx = null;
  nodes = null;
  voices = [];
  held.clear();
  muted = false;

  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  await dying?.close();

  $('meter').style.width = '0%';
  $('sr').textContent = '\u2014';
  $('latency').textContent = '\u2014';
  updateVoiceCount();
  $('status').textContent = 'Stopped';
  $('start').textContent = 'Start';
  $('start').classList.remove('running');
  $('start').disabled = false;
}

function meterLoop(analyser) {
  const data = new Float32Array(analyser.fftSize);
  const tick = () => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const s of data) sum += s * s;
    $('meter').style.width = Math.min(100, Math.sqrt(sum / data.length) * 320).toFixed(1) + '%';
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

/* ---------- voices ---------- */

function voiceOn(id, semitones) {
  if (!ctx || held.has(id)) return;
  const voice = voices.find((v) => v.id === null) || voices[0];
  if (voice.id !== null) voiceOff(voice.id);

  voice.id = id;
  voice.shifter.parameters.get('ratio').value = Math.pow(2, semitones / 12);
  voice.gain.gain.cancelScheduledValues(ctx.currentTime);
  voice.gain.gain.setTargetAtTime(1, ctx.currentTime, RAMP);

  held.set(id, voice);
  updateVoiceCount();
}

function voiceOff(id) {
  const voice = held.get(id);
  if (!voice) return;
  if (!ctx) { voice.id = null; held.delete(id); updateVoiceCount(); return; }
  voice.gain.gain.cancelScheduledValues(ctx.currentTime);
  voice.gain.gain.setTargetAtTime(0, ctx.currentTime, RAMP);
  voice.id = null;
  held.delete(id);
  updateVoiceCount();
}

function releaseChordVoices() {
  for (const id of [...held.keys()]) if (id.startsWith('chord:')) voiceOff(id);
}

function updateVoiceCount() {
  $('voices').textContent = `${held.size} / ${VOICE_COUNT}`;
}

/* ---------- chord chart ---------- */

function loadChart() {
  chart = parseProgression($('chart').value);
  nextIndex = 0;
  releaseChord();
  renderChart();
}

function renderChart() {
  const strip = $('progression');
  strip.innerHTML = '';
  if (!chart.length) {
    strip.innerHTML = '<span class="hint">Nothing loaded - type a chord chart above.</span>';
    return;
  }
  chart.forEach((entry, i) => {
    const el = document.createElement('div');
    el.className = 'chord'
      + (entry.chord ? '' : ' bad')
      + (i === playingIndex ? ' on' : '')
      + (i === nextIndex && playingIndex === null ? ' next' : '');
    const detail = entry.chord
      ? chordVoices(entry.chord, reference, VOICE_COUNT)
          .map((s) => (s >= 0 ? '+' : '') + s).join(' ')
      : 'unknown';
    el.innerHTML = `<b>${entry.token}</b><span>${detail}</span>`;
    el.addEventListener('click', () => { queueChord(i); });   // click to cue, don't sound
    strip.appendChild(el);
  });
}

function queueChord(index) {
  if (!chart.length) return;
  nextIndex = ((index % chart.length) + chart.length) % chart.length;
  renderChart();
  $('progression').children[nextIndex]?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

/** Space pressed: sound the queued chord and hold it. */
function soundChord(index = nextIndex) {
  if (!chart.length) return;
  playingIndex = ((index % chart.length) + chart.length) % chart.length;
  const entry = chart[playingIndex];
  renderChart();
  $('progression').children[playingIndex]?.scrollIntoView({ block: 'nearest', inline: 'center' });

  releaseChordVoices();
  if (!entry.chord) {
    $('status').textContent = `Can't read "${entry.token}" - skipped`;
    return;
  }
  chordVoices(entry.chord, reference, VOICE_COUNT)
    .forEach((semis, i) => voiceOn(`chord:${i}`, semis));
  $('status').textContent = `${entry.token}  (${playingIndex + 1}/${chart.length})`;
}

/** Space released: drop the chord and cue up the next one. */
function releaseChord() {
  releaseChordVoices();
  if (playingIndex !== null && chart.length) {
    nextIndex = (playingIndex + 1) % chart.length;
  }
  playingIndex = null;
  renderChart();
}

$('chart').value = DEFAULT_CHART;
$('chart').addEventListener('input', loadChart);
loadChart();

/* ---------- keyboard ---------- */

function typing(target) {
  return target && (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();

  if (key === 'escape') {
    if (typing(e.target)) { e.target.blur(); return; }
    if (!ctx) return;
    muted = !muted;
    sliders.master(Number($('master').value));
    $('status').textContent = muted ? 'Muted' : 'Running - sing and hold keys';
    return;
  }
  if (typing(e.target)) return;                  // let the chart box take its own keys

  if (key === ' ') {                             // hold to sound the queued chord
    e.preventDefault();
    if (!e.repeat && playingIndex === null) soundChord();
    return;
  }
  if (key === 'arrowleft' || key === 'arrowright') {
    e.preventDefault();                          // move the cue without sounding
    if (!e.repeat) queueChord(nextIndex + (key === 'arrowleft' ? -1 : 1));
    return;
  }
  if (key === 'backspace') {                     // back to the top of the chart
    e.preventDefault();
    releaseChordVoices();
    playingIndex = null;
    nextIndex = 0;
    renderChart();
    $('status').textContent = ctx ? 'Chart rewound' : 'Not running';
    return;
  }
  if (e.repeat) return;

  if (key === 'z' || key === 'x') {
    octave = Math.max(-2, Math.min(2, octave + (key === 'z' ? -1 : 1)));
    $('octave').textContent = octave > 0 ? '+' + octave : String(octave);
    e.preventDefault();
    return;
  }
  if (!semitonesFor.has(key)) return;
  e.preventDefault();
  if (e.target.tagName === 'INPUT') e.target.blur();

  const semis = Math.max(SEMITONE_MIN, Math.min(SEMITONE_MAX, semitonesFor.get(key) + octave * 12));
  voiceOn('key:' + key, semis);
  keyEls.get(key)?.classList.add('on');
});

window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (key === ' ') {                             // release: drop it, cue the next
    if (playingIndex !== null) releaseChord();
    return;
  }
  if (semitonesFor.has(key)) {
    voiceOff('key:' + key);
    keyEls.get(key)?.classList.remove('on');
  }
});

window.addEventListener('blur', () => {
  if (playingIndex !== null) releaseChord();
  for (const id of [...held.keys()]) {
    if (id.startsWith('key:')) {
      voiceOff(id);
      keyEls.get(id.slice(4))?.classList.remove('on');
    }
  }
});

$('start').addEventListener('click', () => (ctx ? stop() : start()));
