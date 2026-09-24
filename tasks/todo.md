# Messina - browser vocal harmonizer

## Phase 1 - minimal proof of concept
- [x] Granular pitch-shift AudioWorklet (`pitch-shifter.js`)
- [x] Audio graph: mic -> 8 shifter voices -> harmony bus -> reverb -> master (`app.js`)
- [x] Laptop keyboard as controller (piano layout, octave shift, esc panic)
- [x] UI: level meter, lit key map, dry/harmony/reverb/master (`index.html`)
- [x] Verify worklet + graph load with no console errors
- [x] Offline DSP check: `test-pitch-shifter.js` (runs under jsc, no deps)
- [ ] Listening test with a real voice (needs mic permission + headphones)

## Chord charts (added)
- [x] Parse standard chord symbols: `Am`, `F#m7`, `Cmaj7`, `G7`, `Dsus4`, `Bb`, `C/G`, `Em7b5`,
      `A7#9`, `E5`, `C-7`, `CM7`, `CΔ` (`chords.js`)
- [x] Paste a chart straight from a tab - bar lines, repeat marks and line breaks are separators
- [x] Spacebar is a gate: hold to sound the cued chord, release to drop it and cue the next
- [x] Arrows move the cue silently, delete rewinds, clicking a chord cues it
- [x] "I'm singing" reference note - chords voice themselves relative to that pitch
- [x] Start/Stop toggle: stopping silences all voices, releases the mic tracks and closes the
      AudioContext, so the browser tab's recording indicator actually goes away
- [ ] Listening test

## Audio file input (added)
- [x] Load a file (picker or drag-and-drop), decode, play it through the same chain
- [x] Transport: play/pause (`p`), stop, loop, clickable progress bar, time readout
- [x] Mic / file input switch; file mode never requests microphone permission
- [x] Play auto-starts the engine, so Start is not a prerequisite
- [x] Format check: AAC `.m4a` decodes; Apple Lossless `.m4a` does not (Chrome limitation),
      with a targeted error message instead of a generic format list
- [ ] Listening test

## Phase 2 - pitch tracking + formant-preserving shifting (done)
- [x] `engine.js`: one worklet, one analysis, eight voices, port-driven
- [x] YIN pitch detection via FFT autocorrelation (sub-cent on sines and synthetic voices)
- [x] TD-PSOLA synthesis with epoch marking and window-sum normalised overlap-add
- [x] `resample` mode kept behind a formant toggle for A/B and as a test control
- [x] Absolute notes for keys and chart; octave folding decided at note-on; fallback pitch
- [x] Configurable voice range (C3 / E2 / C2) trading tracking depth against delay
- [x] Dry path delayed to match the engine so harmonies don't flam
- [x] Confidence gating: hold pitch and duck harmonies on unvoiced sounds
- [x] `serve.py` with no-store, after stale cached modules wasted debugging time
- [x] Fix harmonies thinning out at higher intervals (grain width, see below)
- [x] Arrow keys change the sounding chord while space is held, wrapping at the ends
- [x] Fix garbled voice at deep downward shifts (PSOLA floor, see below)
- [x] Fix z/x octave keys being swallowed by octave folding
- [x] Fix keys swallowed by a focused dropdown/checkbox/button; say "press Start first"; stale help text
- [ ] Listening test with a real voice

## Phase 3 - candidates
- [ ] Offline pitch analysis for loaded files (no added delay, better tracking)
- [ ] Chord latch / freeze (hold a chord hands-free)
- [x] Per-voice detune + stereo spread
- [x] Pitch tracking holds through octave glitches (vocal fry) but follows real leaps
- [x] Record the output to a 24-bit stereo WAV (`r`)
- [ ] MIDI / MusicXML import to fill the chord chart
- [ ] Real MIDI input via Web MIDI

## Phase 2 review

**The measurement that matters.** `test-engine.js` builds a synthetic voice (glottal impulse
train through three formant resonators at 700/1220/2600 Hz), shifts it up an octave through both
engines, and finds the frequency scale factor that best aligns each output's spectral envelope
with the source's. PSOLA: **x1.01** (correlation 0.98). Resample: **x2.05** (0.99). That is the
chipmunk effect quantified and removed. The resample case is asserted to *fail* the formant test,
so the test cannot silently stop measuring the thing it claims to.

**Two measurement bugs before that worked.** The pitch estimator picked the tallest ACF peak,
which sits at 2T as often as T, so it reported an octave low; fixed by preferring the earliest lag
that correlates nearly as well. And the envelope extractor averaged a harmonic comb in the linear
domain, which leaves ripple at the comb period, so its "formant peaks" were just harmonics; fixed
with a max filter one f0 wide before smoothing. Both looked like engine bugs and were not.

**Measured, not assumed.** Engine delay 20.6 / 29.7 / 36.1 ms for the three ranges (the plan
predicted 11 / 21 / 43). Eight PSOLA voices cost 4.8% of the render budget - 20x faster than real
time - which settles the question of whether this needs C++: it does not. The dominant latency
term is Bluetooth output (171 ms measured on AirPods vs 5.3 ms base).

**Level drop at higher intervals (user-reported).** Harmonies got quieter the further up they
were shifted: measured -3.6 dB at an octave, -4.5 dB at a fifth, -8.4 dB at +19, while `resample`
mode stayed flat within 0.7 dB. Cause: grains were two analysis periods wide, but shifting up
packs synthesis marks closer than analysis marks, so several copies of the same waveform landed on
top of each other offset by less than a period and partly cancelled - while the window-sum
normalisation still divided by the full overlap, as if they had added coherently. Fixed by sizing
each grain to min(analysis period, synthesis period), so neighbours overlap 50% instead of piling
up. Level now holds within 1.2 dB from -12 to +19 (verified offline and in Chrome), formant
preservation unchanged at x1.01, and `test-engine.js` gained a level-flatness assertion that fails
above 3 dB.

Two alternatives were measured and rejected: energy-style normalisation (divide by the root of the
summed squares) was worse at 6.7 dB, and leaving it alone was 8.4 dB.

**Seamless chord changes.** Arrows now retarget the sounding voices (same voice ids, new notes)
rather than releasing and retriggering them, so the engine keeps each voice's grain stream running
and glides the ratio over ~11 ms. Retriggering also exposed a latent click: the engine rebuilt a
voice's grain state whenever it was inactive, which cut the tail off a voice still ramping down.
It now only rebuilds a genuinely idle voice. `test-engine.js` asserts the change is gap-free
(rms 0.327 before, 0.320 across the change), click-free, and lands on the new note.

**Garbled voice at low notes (user-reported).** Two separate causes, found by measuring rather
than guessing. First, PSOLA lowers pitch by spacing pulses further apart, but grains are only ~2
pitch periods wide, so below about an octave down consecutive grains stop touching: measured 16.7%
silence at -17 semitones, 25.6% at -19, 44.1% at -24, against 0% for the resampler. A wider grain
would reintroduce the original pitch, so it is a real limit of the algorithm. Voices below the
floor now crossfade (30 ms) to the resampler, which is gap-free, at the cost of formants moving
with the pitch. Second, `z`/`x` were a no-op whenever octave folding was on, because folding
reduced the note to a pitch class and discarded the octave - so pressing them appeared to do
nothing, or with folding off produced exactly the deep shifts that garbled. Both fixed; a dropout
test covers -7 to -24.

Also measured: pitch tracking on polyphonic material is stable but wrong - a three-note chord
tracked steadily to a subharmonic (90 Hz under 180/220/270), and a tritone pair to neither note.
So a full mix will sound in tune with itself but in the wrong key; that is what the tracking switch
is for. Worth surfacing in the UI later.

CPU is now ~10% of the render budget for eight voices, up from ~4.8%, since the crossfade needs the
resampler's delay line kept current. Voices sitting fully on PSOLA skip the second render and just
advance that phase, verified by counting renders: 0/375 for an upward shift, 375/375 below the
floor.

**Focus bugs (review).** Only the chord textarea now counts as typing. Before this, a dropdown
still focused after a change swallowed space, the arrows and the note keys, and pressing a/d/e/f/g
used type-ahead to silently change the fallback note. When the app handles a key it now blurs the
focused control first, so space can't press a focused Stop button or tick a checkbox. Verified in
Chrome with real key presses: the dropdown keeps its value, the checkbox stays ticked, Start stays
Start, and the chord sounds each time. Chrome on macOS doesn't give focus to a mouse-clicked button,
so the Stop case only happened via Tab. Keys pressed before Start now say so, instead of lighting a
silent key.

**Stereo spread, detune, octave glitches.** The engine now outputs stereo. Each voice slot has a fixed
pan position and detune direction, scaled by the Spread and Detune sliders. Pan is equal-power scaled
by sqrt(2), so spread 0 reproduces the old mono output exactly (asserted), and full spread keeps total
power within 0.00 dB. Detune lands at +10.0 cents when asked for +10. Verified in Chrome with the real
worklet in an OfflineAudioContext: spread 0 gives L/R correlation 1.000, spread 1 gives -0.002 with
two voices, and the defaults (0.6, 6 cents) give 0.596, all at the same level. Offline-render gotcha:
port messages are not synchronised with an OfflineAudioContext, so a noteOn posted before
startRendering can land after the render has finished, which gives silent output. Suspend, post, then
resume.

Octave glitches: the test first reproduced the bug, with a 30 ms burst of alternating pulse amplitudes
throwing the tracked pitch a full 12 semitones. A leap-confirmation window alone did not fix it,
because the 43 ms analysis window stretches a 30 ms glitch to ~50 ms of octave-low readings. Measuring
YIN's dip at the old period separated the cases cleanly (glitch <= 0.26, real low note >= 1.27), so
octave-low readings snap back when the old period still fits (threshold 0.5). Now 0.0 semitones of
excursion. Real octave leaps are followed in 52 ms (up; 36 ms before this change) and 36 ms (down).

**Recording.** `recorder.js` is loaded both ways: as a worklet through addModule, where it registers
the capture processor, and as an ES module by app.js for encodeWav. A `typeof registerProcessor` guard
lets one file do both. The worklet has zero outputs, so Chrome pulls it without it being wired to the
destination. It taps a new `bus` before the master fader. Verified in Chrome end to end. A 3 s take
recorded while a file played and a chord was held came out as a valid RIFF/WAVE: 24-bit, 2 channels,
48 kHz, 3.00 s. Chrome's own decodeAudioData read it back. L/R correlation was 0.994 before the chord
(reverb only) and 0.781 during it (spread), at the pre-master level. Stop mid-take also saves.
Downloads were intercepted in-page, so nothing was actually written to disk. One bug was caught in
review before it ran: a Promise executor assigning `.resolve` onto the variable being assigned, which
is still the old value inside the executor.

**Stale module cache.** Chrome kept serving the old `app.js` after the rewrite, which presented as
"the engine works standalone but the UI never updates". Replaced `http.server` with `serve.py`
sending `no-store`.

## Review

**Built:** `pitch-shifter.js` (AudioWorklet), `app.js` (graph + keyboard), `index.html` (UI),
`test-pitch-shifter.js` (offline DSP check). No dependencies, no build step.

**One real bug caught by the test.** The first shifter used two read heads overlapping 50% of the
time with sin^2/cos^2 windows. Measured output rms was 0.500 where a unit sine should give 0.707,
and a narrow-band DFT found more energy in a warble sideband (+/- the grain rate, 5-12 Hz) than in
the carrier: the two incoherent heads were cancelling the note. Replaced with a single read head
plus a short splice crossfade (6 ms out of each 40 ms of drift) against a head exactly one grain
behind, so the two heads only meet at the wrap, where they read the same position. rms is now
0.707-0.727 and clean windows measure the target pitch to 0.00 cents.

**Measurement lesson:** the first two "failures" were the test's own autocorrelation octave-erroring,
and the next two were measurement windows straddling a splice. Windows are now sized from the grain
period, and the per-interval "splice duty" is reported (4% at a third, 15% at an octave, 30% at +19)
- that number is the honest predictor of how rough an interval will sound.

**Chord charts:** `chords.js` turns a symbol into semitone offsets from the note you are singing.
Without pitch detection there is no way to know that note, so it is a dropdown ("I'm singing C")
rather than a measurement - the chart is only in tune if you actually hold near that pitch. Roots
are placed in whichever octave sits closest to your voice so the progression moves by small
intervals rather than leaping, and a slash bass drops below. 21 chord symbols verified against
expected note spellings in the browser; spacebar gate transitions (hold / autorepeat / release /
wrap / arrows / delete) verified by dispatching key events.

**Start/stop verified without a mic prompt** by swapping `getUserMedia` for a synthetic 220 Hz
MediaStream in the page: start -> button reads Stop, sample rate populates, space allocates 3 voices
for Am, a manual key makes 4; stop -> voices 0, meter 0, mic track `.stop()` called, context closed,
button back to Start; restart and a second stop both clean. No console errors.

**Audio file source:** verified with a generated 10 s WAV fed to the file input, and playback
started with a real mouse click (a scripted `.click()` is not a user gesture, so the AudioContext
stays suspended and the transport looks frozen - worth remembering when testing audio in the
browser). Playhead and meter advance, the chord gate allocates 3 voices over playback and releases
them without interrupting it, `p` pauses and resumes from the pause point, seeking keeps playing,
stop rewinds, and `getUserMedia` was called zero times in file mode.

**Bug found by that test:** pause and seek both called `stop()` on the buffer source while an
`endingDeliberately` flag guarded the `onended` handler - but `onended` fires asynchronously, so the
flag was already back to `false` when the event arrived and every deliberate stop looked like the
file had ended, resetting playback to zero. Fixed by clearing `onended` before stopping the node
rather than guarding it with a flag.

**Verified in Chrome:** worklet loads and renders in a real (Offline)AudioContext, +7 semitones out
at exactly 329.63 Hz, UI renders, zero console errors. Live-mic listening test still pending - it
needs a human to grant mic permission and wear headphones.
