/**
 * Messina - phase 1.
 *
 * source -+-> inputGain -+-> dryDelay -> dryGain ---------+-> mixBus -+-> bus -+-> masterGain -> out
 *         |              |                                |           |   ^    |
 *  mic or file           +-> engine (8 voices, stereo) -> harmonyGain +-> convolver -> wetGain
 *                                                                              +-> recorder
 *
 * The recorder taps the bus before the master fader, so headphone level and
 * the esc mute change what you hear but not what gets recorded.
 *
 * The source is either the live mic or a loaded audio file; everything
 * downstream is identical, so the keys and the chord chart work on both.
 *
 * The engine delays its harmonies by a fixed amount (PSOLA needs a grain either
 * side of each pitch mark), so the dry path is delayed to match - otherwise the
 * harmonies flam against the dry signal.
 */
import { parseProgression, chordVoices, chordNotes, noteName, NOTE_NAMES } from './chords.js';
import { encodeWav } from './recorder.js';

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

let engine = null;
let ctx = null;
let nodes = null;
let running = false;
let meterRaf = null;
let octave = 0;
let muted = false;

let recorder = null;         // capture worklet node
let takeChunks = null;       // [{ left, right }] while recording, else null
let takeStartedAt = 0;       // ctx.currentTime when recording began
let takeFlushed = null;      // resolver: the worklet has sent its last chunk
let takeSaving = false;      // stop requested, waiting on that last chunk

let sourceMode = 'mic';
let micStream = null;
let micNode = null;

let fileBuffer = null;       // decoded PCM, survives a stop/start
let fileNode = null;
let filePlaying = false;
let fileOffset = 0;          // where playback resumes from, seconds
let fileStartedAt = 0;       // ctx.currentTime when the current node started

let tracking = true;         // follow the detected pitch, vs the fixed dropdown
let fold = true;             // move harmonies to the octave nearest the voice
let formants = true;         // psola vs the phase 1 resampler
let range = 'standard';
let detected = { f0: 0, confidence: 0, voiced: false };

const RANGES = {
  low:      { window: 1024, fmin: 131, label: 'C3' },
  standard: { window: 2048, fmin: 82,  label: 'E2' },
  full:     { window: 4096, fmin: 65,  label: 'C2' },
};

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

/**
 * Level sliders are in decibels, as on a mixing desk: 0 dB leaves a signal
 * unchanged, and the bottom of the travel is off. Hearing works on ratios, so
 * equal steps in dB sound like equal steps, where a plain gain multiplier
 * crammed most of the audible range into the bottom third of the slider.
 */
const LEVEL_OFF = -48;
const dbToGain = (db) => (db <= LEVEL_OFF ? 0 : Math.pow(10, db / 20));
const setLevel = (param, db) => param.setTargetAtTime(dbToGain(db), ctx.currentTime, 0.01);

const sliders = {
  dry: (v) => setLevel(nodes.dry.gain, v),
  harmony: (v) => setLevel(nodes.harmony.gain, v),
  reverb: (v) => setLevel(nodes.wet.gain, v),
  master: (v) => setLevel(nodes.master.gain, muted ? LEVEL_OFF : v),
  spread: () => sendConfig(),
  detune: () => sendConfig(),
};

const formatDb = (db) => (db <= LEVEL_OFF ? 'off'
  : (db > 0 ? '+' : db < 0 ? '\u2212' : '') + Math.abs(db).toFixed(1) + ' dB');
const sliderText = {
  spread: (v) => v.toFixed(0) + '%',
  detune: (v) => v.toFixed(0) + '\u00a2',
};
const renderSlider = (name) => {
  $(name + 'V').textContent = (sliderText[name] ?? formatDb)(Number($(name).value));
};

for (const name of Object.keys(sliders)) {
  const input = $(name);
  renderSlider(name);
  input.addEventListener('input', () => {
    renderSlider(name);
    if (ctx) sliders[name](Number(input.value));
  });
  // Double-click puts a slider back where the page started it.
  input.addEventListener('dblclick', () => {
    input.value = input.defaultValue;
    input.dispatchEvent(new Event('input'));
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

async function buildGraph() {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('engine.js');
  await ctx.audioWorklet.addModule('recorder.js');
  await ctx.resume();

  const input = ctx.createGain();
  const dryDelay = ctx.createDelay(0.5);
  const dry = ctx.createGain();
  const harmony = ctx.createGain();
  const mix = ctx.createGain();
  const convolver = ctx.createConvolver();
  const wet = ctx.createGain();
  const bus = ctx.createGain();
  const master = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  convolver.buffer = impulseResponse(ctx);

  input.connect(analyser);
  input.connect(dryDelay).connect(dry).connect(mix);
  harmony.connect(mix);
  mix.connect(bus);
  mix.connect(convolver).connect(wet).connect(bus);
  bus.connect(master).connect(ctx.destination);

  recorder = new AudioWorkletNode(ctx, 'messina-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  recorder.port.onmessage = (e) => onRecorderMessage(e.data);
  bus.connect(recorder);

  engine = new AudioWorkletNode(ctx, 'messina-engine', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    outputChannelCount: [2],                  // harmonies are panned across the stereo field
  });
  engine.port.onmessage = (e) => onEngineStatus(e.data);
  input.connect(engine).connect(harmony);

  nodes = { input, dryDelay, dry, harmony, mix, wet, bus, master, analyser };
  sendConfig();
  for (const name of Object.keys(sliders)) sliders[name](Number($(name).value));

  $('sr').textContent = ctx.sampleRate + ' Hz';
  const rt = (ctx.baseLatency + (ctx.outputLatency || 0)) * 1000;
  $('latency').textContent = rt ? rt.toFixed(1) + ' ms' : 'unknown';
  meterLoop(analyser);
}

async function connectMic() {
  if (micNode) return;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  micNode = ctx.createMediaStreamSource(micStream);
  micNode.connect(nodes.input);
}

function disconnectMic() {
  micNode?.disconnect();
  micNode = null;
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
}

async function start() {
  $('start').disabled = true;
  try {
    if (!ctx) {
      $('status').textContent = sourceMode === 'mic' ? 'Requesting microphone...' : 'Starting...';
      await buildGraph();
    }
    if (sourceMode === 'mic') await connectMic();

    running = true;
    $('record').disabled = false;
    $('start').textContent = 'Stop';
    $('start').classList.add('running');
    $('status').textContent = sourceMode === 'mic'
      ? 'Running - sing and hold keys'
      : 'Running - press play';
    updateTransport();
  } catch (err) {
    console.error(err);
    $('status').textContent = 'Failed: ' + err.message;
    disconnectMic();
  }
  $('start').disabled = false;
}

/** Tear the rig down: silence every voice, release the mic, close the context. */
async function stop() {
  $('start').disabled = true;

  const savedTake = await stopRecording();      // save the take before the context goes
  $('record').disabled = true;
  recorder = null;
  stopFile();
  cancelAnimationFrame(meterRaf);
  meterRaf = null;

  for (const id of [...held.keys()]) voiceOff(id);
  for (const el of keyEls.values()) el.classList.remove('on');
  midiDown.clear();
  midiSustained.clear();
  renderMidi();
  playingIndex = null;
  renderChart();

  const dying = ctx;
  ctx = null;
  nodes = null;
  engine = null;
  held.clear();
  muted = false;
  running = false;

  disconnectMic();
  await dying?.close();

  $('meter').style.width = '0%';
  $('sr').textContent = '—';
  $('latency').textContent = '—';
  updateVoiceCount();
  updateTransport();
  $('status').textContent = savedTake ? `Stopped - saved ${savedTake}` : 'Stopped';
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
    if (filePlaying) renderPlayhead();
    if (takeChunks) $('recTime').textContent = formatTime(ctx.currentTime - takeStartedAt);
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

/* ---------- audio file source ---------- */

/** Decode without disturbing the live graph - works even before Start. */
async function decodeFile(arrayBuffer) {
  const decoder = ctx ?? new AudioContext();
  try {
    return await decoder.decodeAudioData(arrayBuffer);
  } finally {
    if (decoder !== ctx) decoder.close();
  }
}

/**
 * Chrome decodes AAC .m4a but not Apple Lossless, and the two share an
 * extension, so "try an m4a" is useless advice after an m4a has just failed.
 */
function decodeHint(name) {
  if (/\.m4a$/i.test(name)) {
    console.info('Convert Apple Lossless to AAC:  afconvert -f m4af -d aac in.m4a out.m4a');
    return 'if it is Apple Lossless, Chrome cannot read it - re-encode it as AAC '
         + '(see the console for a one-line afconvert command)';
  }
  return 'Chrome cannot read this format - WAV, MP3, AAC/M4A, FLAC and OGG all work';
}

async function loadFile(file) {
  if (!file) return;
  $('fileName').textContent = 'Decoding ' + file.name + '...';
  try {
    fileBuffer = await decodeFile(await file.arrayBuffer());
    stopFile();
    $('fileName').textContent = `${file.name} · ${formatTime(fileBuffer.duration)}`;
    selectSource('file');
  } catch (err) {
    console.error(err);
    fileBuffer = null;
    $('fileName').textContent = `Could not decode ${file.name} - ${decodeHint(file.name)}`;
  }
  updateTransport();
}

function fileTime() {
  if (!fileBuffer) return 0;
  if (!filePlaying) return fileOffset;
  const elapsed = ctx.currentTime - fileStartedAt;
  return $('loop').checked
    ? elapsed % fileBuffer.duration
    : Math.min(elapsed, fileBuffer.duration);
}

async function playFile(from = fileOffset) {
  if (!fileBuffer) return;
  if (!running) await start();
  if (!ctx) return;

  stopFileNode();
  fileNode = ctx.createBufferSource();
  fileNode.buffer = fileBuffer;
  fileNode.loop = $('loop').checked;
  fileNode.connect(nodes.input);
  fileNode.onended = () => {                     // only fires when the file runs out
    filePlaying = false;
    fileOffset = 0;
    updateTransport();
    renderPlayhead();
  };
  fileNode.start(0, Math.min(from, fileBuffer.duration - 0.01));
  fileStartedAt = ctx.currentTime - from;
  filePlaying = true;
  updateTransport();
}

function stopFileNode() {
  if (!fileNode) return;
  // Drop the handler first: onended fires asynchronously, so a flag cleared here
  // would already be false by the time a deliberate stop delivered its event,
  // and pausing or seeking would look like the file had ended.
  fileNode.onended = null;
  try { fileNode.stop(); } catch { /* already stopped */ }
  fileNode.disconnect();
  fileNode = null;
}

function pauseFile() {
  if (!filePlaying) return;
  fileOffset = fileTime();
  stopFileNode();
  filePlaying = false;
  updateTransport();
}

function stopFile() {
  stopFileNode();
  filePlaying = false;
  fileOffset = 0;
  updateTransport();
  renderPlayhead();
}

function seekFile(seconds) {
  if (!fileBuffer) return;
  const t = Math.max(0, Math.min(seconds, fileBuffer.duration));
  if (filePlaying) playFile(t);
  else { fileOffset = t; renderPlayhead(); }
}

function togglePlay() {
  if (!fileBuffer) return;
  if (filePlaying) pauseFile();
  else playFile();
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderPlayhead() {
  const duration = fileBuffer?.duration ?? 0;
  const t = fileTime();
  $('playhead').style.width = duration ? (t / duration * 100).toFixed(2) + '%' : '0%';
  $('time').textContent = `${formatTime(t)} / ${formatTime(duration)}`;
}

function updateTransport() {
  $('playPause').disabled = !fileBuffer;
  $('rewind').disabled = !fileBuffer;
  $('playPause').textContent = filePlaying ? 'Pause' : 'Play';
}

function selectSource(mode) {
  sourceMode = mode;
  document.querySelector(`input[name=source][value=${mode}]`).checked = true;
  $('fileControls').hidden = mode !== 'file';

  if (mode === 'mic') {
    pauseFile();
    if (running) connectMic().catch((err) => {
      console.error(err);
      $('status').textContent = 'Failed: ' + err.message;
    });
  } else {
    disconnectMic();
  }
}

$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
$('playPause').addEventListener('click', togglePlay);
$('rewind').addEventListener('click', stopFile);
$('loop').addEventListener('change', () => { if (fileNode) fileNode.loop = $('loop').checked; });
$('progress').addEventListener('click', (e) => {
  const box = e.currentTarget.getBoundingClientRect();
  seekFile((e.clientX - box.left) / box.width * (fileBuffer?.duration ?? 0));
});
for (const radio of document.querySelectorAll('input[name=source]')) {
  radio.addEventListener('change', () => selectSource(radio.value));
}

const panel = $('sourcePanel');
panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('dragging'); });
panel.addEventListener('dragleave', () => panel.classList.remove('dragging'));
panel.addEventListener('drop', (e) => {
  e.preventDefault();
  panel.classList.remove('dragging');
  loadFile(e.dataTransfer.files[0]);
});

/* ---------- recording ---------- */

function startRecording() {
  if (!recorder || takeChunks) return;
  takeChunks = [];
  takeStartedAt = ctx.currentTime;
  recorder.port.postMessage('start');
  $('record').textContent = 'Stop recording';
  $('record').classList.add('recording');
  $('recTime').textContent = '0:00';
}

/** Ask the worklet for its last partial chunk, then write the take out. */
async function stopRecording() {
  if (!takeChunks || takeSaving) return;       // a second press mid-save would save it twice
  takeSaving = true;
  const done = new Promise((resolve) => { takeFlushed = resolve; });
  recorder.port.postMessage('stop');
  await Promise.race([done, new Promise((r) => setTimeout(r, 500))]);   // never hang Stop
  const name = saveTake(takeChunks, ctx.sampleRate);
  takeChunks = null;
  takeSaving = false;
  $('record').textContent = 'Record';
  $('record').classList.remove('recording');
  $('recTime').textContent = '';
  return name;
}

function onRecorderMessage(msg) {
  if (msg.done) { takeFlushed?.(); takeFlushed = null; return; }
  takeChunks?.push(msg);
}

function saveTake(chunks, sampleRate) {
  const frames = chunks.reduce((n, c) => n + c.left.length, 0);
  if (!frames) return null;
  const left = new Float32Array(frames), right = new Float32Array(frames);
  let at = 0;
  for (const c of chunks) { left.set(c.left, at); right.set(c.right, at); at += c.left.length; }

  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `messina-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.wav`;
  const url = URL.createObjectURL(new Blob([encodeWav([left, right], sampleRate)], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  $('status').textContent = `Saved ${name} (${formatTime(frames / sampleRate)})`;
  return name;
}

function toggleRecording() {
  if (!running) { requireRunning(); return; }
  if (takeChunks) stopRecording();
  else startRecording();
}

$('record').addEventListener('click', toggleRecording);

/* ---------- voices ---------- */

/**
 * `note` is an absolute MIDI number when the engine is tracking your pitch, and
 * a semitone offset when it is not. The engine owns voice allocation now; the
 * app only tracks which ids are sounding so the UI can count them.
 */
function voiceOn(id, note, gain = 1) {
  if (!ctx || held.has(id)) return;
  engine.port.postMessage(tracking
    ? { type: 'noteOn', id, midi: note, gain }
    : { type: 'noteOn', id, semis: note, gain });
  held.set(id, note);
  updateVoiceCount();
}

/**
 * Point an already-sounding voice at a new note. The engine keeps that voice's
 * grain stream running and glides the ratio, so changing chord mid-hold doesn't
 * restart the voice - which is what makes arrow-key changes seamless.
 */
function voiceSet(id, note) {
  if (!ctx) return;
  if (!held.has(id)) { voiceOn(id, note); return; }
  engine.port.postMessage(tracking
    ? { type: 'noteOn', id, midi: note }
    : { type: 'noteOn', id, semis: note });
  held.set(id, note);
}

function voiceOff(id) {
  if (!held.has(id)) return;
  held.delete(id);
  engine?.port.postMessage({ type: 'noteOff', id });
  updateVoiceCount();
}

function releaseChordVoices() {
  for (const id of [...held.keys()]) if (id.startsWith('chord:')) voiceOff(id);
}

function updateVoiceCount() {
  $('voices').textContent = `${held.size} / ${VOICE_COUNT}`;
}

/* ---------- engine control ---------- */

function sendConfig() {
  if (!engine) return;
  const r = RANGES[range];
  engine.port.postMessage({
    type: 'config',
    mode: formants ? 'psola' : 'resample',
    absolute: tracking,
    window: r.window,
    fmin: r.fmin,
    spread: Number($('spread').value) / 100,
    detune: Number($('detune').value),
  });
}

let lastPreviewRef = null;

function onEngineStatus(msg) {
  if (msg.type !== 'status' || !running) return;   // a final message can land mid-teardown
  detected = { f0: msg.f0, confidence: msg.confidence, voiced: msg.voiced };
  if (nodes) nodes.dryDelay.delayTime.value = msg.delayMs / 1000;
  $('engineDelay').textContent = msg.delayMs.toFixed(1) + ' ms';
  renderPitch();

  // The chart previews the notes each chord would sound, which depends on the
  // pitch you are singing - refresh it when that changes, but only then, since
  // status arrives ~23 times a second.
  const ref = referenceMidi();
  if (ref !== lastPreviewRef && playingIndex === null) {
    lastPreviewRef = ref;
    renderChart();
  }
}

/** The note you are singing right now, as a MIDI number, or null. */
function detectedMidi() {
  if (!detected.voiced || detected.f0 <= 0) return null;
  return 69 + 12 * Math.log2(detected.f0 / 440);
}

/** What chords voice themselves against: your actual pitch, or the fallback. */
function referenceMidi() {
  const live = detectedMidi();
  if (tracking && live !== null) return Math.round(live);
  return 48 + reference;                      // C3 + the fallback pitch class
}

/** The fallback note only applies when nothing is being tracked. */
function renderReferenceState() {
  $('referenceLabel').style.opacity = tracking ? '0.45' : '1';
  $('reference').disabled = tracking && detected.voiced;
}

function renderPitch() {
  const live = detectedMidi();
  if (live === null) {
    $('pitch').textContent = '\u2014';
    $('cents').textContent = tracking ? 'no pitch detected' : 'tracking off';
  } else {
    const near = Math.round(live);
    const off = Math.round((live - near) * 100);
    $('pitch').textContent = noteName(near);
    $('cents').textContent = (off >= 0 ? '+' : '') + off + ' cents \u00b7 '
      + detected.f0.toFixed(1) + ' Hz';
  }
  $('confidence').style.width = Math.round(detected.confidence * 100) + '%';
  renderReferenceState();
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
    const detail = entry.chord ? describeChord(entry.chord) : 'unknown';
    el.innerHTML = `<b>${entry.token}</b><span>${detail}</span>`;
    el.addEventListener('click', () => { queueChord(i); });   // click to cue, don't sound
    strip.appendChild(el);
  });
}

/** Note names when we know your pitch, semitone offsets when we don't. */
function describeChord(chord) {
  if (tracking) {
    return chordNotes(chord, referenceMidi(), { fold, maxVoices: VOICE_COUNT })
      .map(noteName).join(' ');
  }
  return chordVoices(chord, reference, VOICE_COUNT)
    .map((s) => (s >= 0 ? '+' : '') + s).join(' ');
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

  if (!entry.chord) {
    releaseChordVoices();
    $('status').textContent = `Can't read "${entry.token}" - skipped`;
    return;
  }
  // The octave is decided here, once, from the pitch at the moment you trigger
  // the chord - folding continuously would make voices jump mid-phrase.
  const notes = tracking
    ? chordNotes(entry.chord, referenceMidi(), { fold, maxVoices: VOICE_COUNT })
    : chordVoices(entry.chord, reference, VOICE_COUNT);
  notes.forEach((n, i) => voiceSet(`chord:${i}`, n));
  for (const id of [...held.keys()]) {          // drop voices this chord doesn't use
    if (id.startsWith('chord:') && Number(id.slice(6)) >= notes.length) voiceOff(id);
  }
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
updateTransport();
renderPlayhead();

/* ---------- MIDI keyboard ---------- */

/**
 * A MIDI keyboard is a third controller alongside the laptop keys and the
 * chart, not a mode: held notes become voices exactly as laptop keys do, and
 * all three can sound at once. Every device and channel is listened to.
 *
 * Octaves follow the Fold switch, as the laptop keys do. Fold off plays exactly
 * the notes pressed, which is what the real Messina does and usually what a
 * pianist wants. Fold on moves each to the octave nearest the voice. With
 * Follow my pitch off, middle C is your own pitch and the rest are intervals.
 */
const MIDI_UNISON = 60;
let midiAccess = null;
const midiDown = new Map();      // note number -> velocity, keys physically held
const midiSustained = new Set(); // released while the pedal was down
let midiPedal = false;

function midiTarget(note) {
  if (!tracking) return Math.max(SEMITONE_MIN, Math.min(SEMITONE_MAX, note - MIDI_UNISON));
  return clampNote(fold ? nearestToVoice(note) : note);
}

/** Velocity -> voice gain. Soft notes stay audible rather than vanishing. */
function velocityGain(velocity) {
  return 0.3 + 0.7 * (velocity / 127);
}

function onMidiMessage(e) {
  const [status, a, b] = e.data;
  const kind = status & 0xf0;
  if (kind === 0x90 && b > 0) midiNoteOn(a, b);
  else if (kind === 0x80 || kind === 0x90) midiNoteOff(a);  // note-on at velocity 0 is note-off
  else if (kind === 0xb0 && a === 64) midiSustain(b >= 64);
  else if (kind === 0xb0 && (a === 120 || a === 123)) midiAllOff();
  else return;
  renderMidi();
}

function midiNoteOn(note, velocity) {
  midiDown.set(note, velocity);
  midiSustained.delete(note);
  if (!running) { requireRunning(); return; }
  const id = 'midi:' + note;
  if (held.has(id)) voiceOff(id);                // restruck under the pedal: sound it afresh
  voiceOn(id, midiTarget(note), velocityGain(velocity));
}

function midiNoteOff(note) {
  midiDown.delete(note);
  if (midiPedal) { midiSustained.add(note); return; }
  voiceOff('midi:' + note);
}

function midiSustain(down) {
  midiPedal = down;
  if (down) return;
  for (const note of midiSustained) if (!midiDown.has(note)) voiceOff('midi:' + note);
  midiSustained.clear();
}

function midiAllOff() {
  midiDown.clear();
  midiSustained.clear();
  midiPedal = false;
  for (const id of [...held.keys()]) if (id.startsWith('midi:')) voiceOff(id);
}

function renderMidi() {
  if (!midiAccess) return;
  const names = [...midiAccess.inputs.values()].map((input) => input.name);
  if (!names.length) {
    $('midiStatus').textContent = 'MIDI connected - plug in a keyboard';
    return;
  }
  const notes = [...new Set([...midiDown.keys(), ...midiSustained])].sort((x, y) => x - y);
  $('midiStatus').textContent = names.join(', ')
    + (notes.length ? ' \u00b7 ' + notes.map(noteName).join(' ') : '')
    + (midiPedal ? ' \u00b7 pedal' : '');
}

function listenToInputs() {
  for (const input of midiAccess.inputs.values()) input.onmidimessage = onMidiMessage;
  renderMidi();
}

async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    $('midiStatus').textContent = 'This browser has no Web MIDI - use Chrome';
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess();
  } catch (err) {
    console.error(err);
    $('midiStatus').textContent = 'MIDI permission was refused';
    return;
  }
  $('midiConnect').hidden = true;
  midiAccess.onstatechange = listenToInputs;     // keyboards plugged in or out while running
  listenToInputs();
}

$('midiConnect').addEventListener('click', connectMidi);
// Once Chrome has granted MIDI, reconnect on load without asking again.
navigator.permissions?.query({ name: 'midi' })
  .then((p) => { if (p.state === 'granted') connectMidi(); })
  .catch(() => {});

/* ---------- keyboard ---------- */

/** A key press is an absolute note while tracking, an interval otherwise. */
function keyNote(offset) {
  if (!tracking) return Math.max(SEMITONE_MIN, Math.min(SEMITONE_MAX, offset));
  // Folded, then z/x on top - otherwise folding throws the octave away and
  // those keys silently do nothing.
  if (fold) return clampNote(nearestToVoice(offset) + octave * 12);
  return clampNote(48 + offset);
}

/** The note with this pitch class in the octave nearest your voice. */
function nearestToVoice(note) {
  const ref = referenceMidi();
  let d = ((((note % 12) - ref) % 12) + 12) % 12;
  if (d > 6) d -= 12;
  return ref + d;
}

function clampNote(n) {
  return Math.max(24, Math.min(96, n));
}

/** Only the chart box takes typing; every other control yields the keys. */
function typing(target) {
  return target && target.tagName === 'TEXTAREA';
}

const OWNED_KEYS = new Set([' ', 'p', 'r', 'arrowleft', 'arrowright', 'backspace', 'z', 'x']);

/** Nothing sounds before Start - say so, rather than lighting a silent key. */
function requireRunning() {
  if (running) return true;
  $('status').textContent = 'Not running - press Start first';
  return false;
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
  if (!OWNED_KEYS.has(key) && !semitonesFor.has(key)) return;

  // A clicked button, checkbox or dropdown keeps focus. Left there, space would
  // press Stop or tick a box on key-up, and a dropdown would eat letters as
  // type-ahead - silently changing the fallback note. Take the key back.
  e.preventDefault();
  if (e.target instanceof HTMLElement && e.target !== document.body) e.target.blur();

  if (key === ' ') {                             // hold to sound the queued chord
    if (!e.repeat && playingIndex === null && requireRunning()) soundChord();
    return;
  }
  if (key === 'r') {                             // record the mix
    if (!e.repeat) toggleRecording();
    return;
  }
  if (key === 'p') {                             // transport
    if (!e.repeat) togglePlay();
    return;
  }
  if (key === 'arrowleft' || key === 'arrowright') {
    if (e.repeat) return;
    const step = key === 'arrowleft' ? -1 : 1;
    // While space is held the arrows change the sounding chord, so you can move
    // through a progression without ever letting go. Both wrap at the ends.
    if (playingIndex !== null) soundChord(playingIndex + step);
    else queueChord(nextIndex + step);
    return;
  }
  if (key === 'backspace') {                     // back to the top of the chart
    releaseChordVoices();
    playingIndex = null;
    nextIndex = 0;
    renderChart();
    $('status').textContent = running ? 'Chart rewound' : 'Not running';
    return;
  }
  if (e.repeat) return;

  if (key === 'z' || key === 'x') {
    octave = Math.max(-2, Math.min(2, octave + (key === 'z' ? -1 : 1)));
    $('octave').textContent = octave > 0 ? '+' + octave : String(octave);
    return;
  }
  if (!requireRunning()) return;

  voiceOn('key:' + key, keyNote(semitonesFor.get(key) + octave * 12));
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

for (const [id, set] of [
  ['tracking', (v) => { tracking = v; }],
  ['formants', (v) => { formants = v; }],
  ['fold', (v) => { fold = v; }],
]) {
  $(id).addEventListener('change', () => {
    set($(id).checked);
    sendConfig();
    renderPitch();
    renderChart();
  });
}

$('range').addEventListener('change', () => {
  range = $('range').value;
  sendConfig();
});

$('start').addEventListener('click', () => (running ? stop() : start()));
