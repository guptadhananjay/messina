# Messina

A live vocal harmonizer in the browser. Sing into your laptop mic, and the tool
re-pitches your voice into harmonies you play from the laptop keyboard — either
as individual intervals, or by stepping through a chord chart with the spacebar.

Named after the Messina, the rig Chris Messina built for Bon Iver — a vocal
running into a harmonizer driven live from a MIDI keyboard, all over
*22, A Million* and unmistakable on "715 – CRΣΣKS".

No dependencies, no build step, no framework. Five files and a static server.

## Running it

```sh
cd messina
python3 serve.py 8173
```

(`serve.py` is `http.server` with `Cache-Control: no-store` bolted on. Chrome
happily caches ES modules and AudioWorklets, which after an edit serves stale
code that looks exactly like a bug in the new code.)

Then open <http://localhost:8173> **in Chrome, wearing headphones.** Localhost
counts as a secure context, so the mic works without TLS. Speakers plus an open
mic will feed back — `esc` mutes everything instantly.

Click **Start** and grant mic permission. Click **Stop** to silence the voices,
release the mic and close the audio context.

## Input: mic or audio file

Switch **Input** to **Audio file** to run a track through the harmonizer instead
of your voice — pick a file or drop one onto the panel. `p` (or the Play button)
starts it; there is a loop toggle and a clickable progress bar to scrub. File
mode never asks for microphone permission, and pressing Play starts the engine on
its own, so you never have to hit Start first.

Formats are whatever Chrome's `decodeAudioData` accepts: **WAV, MP3, AAC `.m4a`
(including Voice Memos and Apple Music files you own), FLAC and OGG.** The one
trap is that `.m4a` covers two different codecs — AAC decodes fine, but **Apple
Lossless does not**, and Chrome gives no useful error. The tool detects that case
and prints an `afconvert` one-liner to the console to re-encode as AAC.

Everything downstream is identical, so the keys and the chord chart transform
playback exactly as they transform a live vocal. This is also the easiest way to
audition the tool without fighting input latency, and a useful way to practise a
chart before singing it.

## Playing it

**Notes, by hand.** The home rows are a piano keyboard: `a w s e d f t g y h u j
k` spans an octave. Hold several at once to stack harmonies. `z` / `x` shift the
whole row an octave, which applies on top of octave folding rather than being
swallowed by it.

**Chords, from a chart.** Paste a progression into the chord box — bar lines,
repeat marks and line breaks are all just separators, so you can copy straight
off a tab site:

```
Am  C  | G  F |
Dm7  E7  Am
```

Then **hold space** to sound the cued chord and **let go** to drop it and cue the
next one. **While space is held, `←` `→` move the sounding chord straight to the
next one**, wrapping round at the end, so a whole progression can be played
without ever letting go — the voices are retargeted rather than retriggered, so
the change is gap-free. With nothing held those arrows just move the cue.
`delete` rewinds to the top, and clicking any chord cues it. Under each chord are the notes it will
sound, or the semitone shifts it will use when **Follow my pitch** is off.

Recognized symbols cover what charts actually print: `Am`, `F#m7`, `Cmaj7`, `G7`,
`Dsus4`, `Bb`, `C/G`, `Em7b5`, `A7#9`, `E5`, `Cadd9`, `G7sus4`, `Bdim7`, plus
shorthand like `C-7`, `CM7`, `CΔ`. Anything unparseable is outlined in red rather
than silently dropped.

Other controls: `p` plays/pauses a loaded file, `esc` mutes, and the sliders set
dry / harmony / reverb / master.

## Your voice

The tool tracks the pitch you are singing (YIN, ~sub-cent on steady notes) and
shows it live. Three switches govern what it does with that:

- **Follow my pitch** — on, a chord symbol means real notes: `Am` is A, C and E
  wherever your voice happens to be. Off, the keys and chart become fixed
  intervals again and voice themselves against the fallback pitch dropdown.
- **Preserve formants** — on is PSOLA; off is the old resampler. Flip it while
  holding a chord: off is the chipmunk sound, kept deliberately for comparison.
- **Fold octaves** — on moves every harmony to the octave nearest your voice, so
  nothing shifts more than six semitones and everything stays smooth. Off keeps
  the written voicing (root nearest your voice, the rest stacked above, slash
  bass below), which is faithful to a transcription but rougher at the edges.

**Range** trades pitch tracking against delay. The analysis has to hold about two
cycles of the lowest note you want found, and PSOLA needs a pitch period either
side of each pulse, so the engine's delay follows directly from the lowest note:

| Range | Lowest note | Measured engine delay |
| --- | --- | --- |
| tightest | C3 (131 Hz) | 20.6 ms |
| default | E2 (82 Hz) | 29.7 ms |
| most delay | C2 (65 Hz) | 36.1 ms |

The dry path is delayed to match, so the dry voice and its harmonies stay
aligned rather than flamming.

## How it works

```
mic or file ─► inputGain ─┬─► dryGain ─────────────┐
                  │                                │
                  └─► [8 × shifter → voiceGain] ─► harmonyGain ─┬─► mixBus ─► master ─► out
                                                                └─► convolver ─► wetGain ─┘
```

| File | Role |
| --- | --- |
| `engine.js` | the `AudioWorkletProcessor`: pitch tracking and all eight voices |
| `chords.js` | chord-symbol parsing and voicing |
| `app.js` | audio graph, input sources, transport, keyboard, chart control |
| `index.html` | markup and styles |
| `test-engine.js` | offline DSP checks |
| `serve.py` | no-cache dev server |

**Pitch tracking** is YIN with the difference function built from an FFT
autocorrelation (the textbook O(W²) form is far too slow for a worklet), run once
per 256-sample hop and shared by all eight voices. Confidence comes from YIN's
aperiodicity: below threshold — consonants, breath, silence — the engine holds
the last pitch rather than lurching, and ducks the harmonies ~6 dB.

**Shifting** is TD-PSOLA. The engine marks each glottal pulse (predict one period
ahead, then snap to the local waveform peak), then rebuilds the signal by laying
those pulses down at a new spacing: closer together to raise the pitch, further
apart to lower it. Because each grain is copied unmodified, the spectral envelope
— the formants, the thing that makes your voice sound like *you* — comes along
untouched. That is the whole trick, and it is why this stopped sounding like
chipmunks.

Grain width matters more than it looks. A grain is sized to the *shorter* of the
analysis and synthesis periods, not simply to the analysis period. Shifting up
packs synthesis marks closer together than the analysis marks, so full-width
grains stack several copies of the same waveform offset by less than one period
— and since the waveform repeats every period, those copies partly cancel.
Measured, that cost 3.6 dB at an octave and 8.4 dB at +19 semitones, heard as
harmonies thinning out as they go higher. Sizing grains to the synthesis period
keeps neighbours at a clean 50% overlap and holds the level within ~1.2 dB
across the range; `test-engine.js` asserts it.

PSOLA has a floor. Lowering pitch means spacing pitch pulses further apart, but
a grain is only about two pitch periods wide, so below roughly an octave down
the pulses stop touching and the output is part silence - 44% silence at two
octaves down, heard as a garbled, chopped voice. A wider grain would carry the
original pitch back in, so this is a genuine limit of the algorithm rather than
a parameter to tune. Voices below that floor crossfade to the resampler instead,
which is gap-free; the trade is that their formants move down with the pitch.
`test-engine.js` asserts no dropouts down to two octaves.

The old algorithm is still in there as `resample` mode behind the formant
toggle. It is a variable delay line: input written at 1×, read by a head drifting
at `(1 - ratio)`, wrapping every 40 ms with a 6 ms splice crossfade against a head
one grain behind. That resamples, which is a tape speed-up, which scales pitch
and formants together.

`test-engine.js` measures the difference rather than asserting it: it builds a
synthetic voice (glottal impulse train through three formant resonators), shifts
it up an octave both ways, and finds the frequency scale factor that best aligns
each output's spectral envelope with the source's. PSOLA comes out at **×1.01**;
resampling at **×2.05**. The resample case is asserted to fail the formant test —
if it ever passes, the test has stopped measuring what it claims to.

Eight voices cost about **10% of the audio render budget** (measured, 10× faster
than real time), so the DSP is not where latency comes from.

Reverb is a `ConvolverNode` fed a JS-generated impulse response (decaying noise),
so there is no audio asset to download.

## Tests

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc test-engine.js
```

Runs the real worklet under a small shim — no browser, no mic, no dependencies:
YIN accuracy on sines and on synthetic voices (sub-cent), PSOLA pitch accuracy
across intervals, the differential formant test above, and continuity checks for
NaNs, sample-level discontinuities and level.

## Latency

Worth knowing where it actually comes from, because it is mostly not this code:

- **Bluetooth output is the dominant term.** Measured on AirPods:
  `outputLatency` 171 ms against `baseLatency` 5.3 ms. Wired headphones cut that
  by roughly tenfold. No amount of DSP work touches it.
- **The engine adds 20–36 ms**, set by the range selector, and that cost is
  algorithmic — two pitch periods of lookahead. It would be identical in C++.
- **The DSP itself is free**: 4.8% of the render budget for eight voices.

For a loaded audio file none of this matters much — there is no live voice to
flam against, so a constant delay is imperceptible.

## Roadmap

- Offline pitch analysis for loaded files (bigger window, smoothing that can see
  forwards in time, no added delay — a file can be analysed ahead of playback)
- Chord latch / freeze, so a chord holds hands-free
- Per-voice detune and stereo spread
- MIDI / MusicXML import to fill the chord chart
- Real MIDI input via Web MIDI
