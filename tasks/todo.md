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

## Phase 2 - the actual Messina trick
- [ ] Live pitch detection (YIN / autocorrelation) so keys become absolute notes, not intervals,
      and the chord chart stops depending on the "I'm singing" setting being true
- [ ] Chord latch / freeze (hold a chord hands-free)
- [ ] Per-voice detune + stereo spread
- [ ] Delay, filter, formant control
- [ ] Real MIDI input via Web MIDI

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
