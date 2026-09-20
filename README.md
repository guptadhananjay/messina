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
python3 -m http.server 8173
```

Then open <http://localhost:8173> **in Chrome, wearing headphones.** Localhost
counts as a secure context, so the mic works without TLS. Speakers plus an open
mic will feed back — `esc` mutes everything instantly.

Click **Start** and grant mic permission. Click **Stop** to silence the voices,
release the mic and close the audio context.

## Playing it

**Intervals, by hand.** The home rows are a piano keyboard: `a w s e d f t g y h
u j k` spans an octave from unison to +12 semitones. Hold several at once to
stack harmonies. `z` / `x` shift the whole row an octave.

**Chords, from a chart.** Paste a progression into the chord box — bar lines,
repeat marks and line breaks are all just separators, so you can copy straight
off a tab site:

```
Am  C  | G  F |
Dm7  E7  Am
```

Then **hold space** to sound the cued chord and **let go** to drop it and cue the
next one. `←` `→` move the cue without making sound, `delete` rewinds to the top,
and clicking any chord cues it. The numbers under each chord are the semitone
shifts it will use.

Recognized symbols cover what charts actually print: `Am`, `F#m7`, `Cmaj7`, `G7`,
`Dsus4`, `Bb`, `C/G`, `Em7b5`, `A7#9`, `E5`, `Cadd9`, `G7sus4`, `Bdim7`, plus
shorthand like `C-7`, `CM7`, `CΔ`. Anything unparseable is outlined in red rather
than silently dropped.

Other controls: `esc` mutes, and the sliders set dry / harmony / reverb / master.

## The catch

**There is no pitch detection yet, so the tool does not know what note you are
singing.** A chord symbol is absolute — `Am` means A, C, E — but all the shifter
can do is transpose your voice by intervals. The **"I'm singing"** dropdown is
how you close that gap: it tells the tool what pitch to voice chords against.
Chords are in tune only if you actually hold roughly that note. Pick something
comfortable, find it on a tuner or piano, set the dropdown, and drone.

The same limitation applies to the manual keys: they are intervals, so harmonies
follow your melody around instead of staying on a chord.

Live pitch tracking is the next thing to build, and it removes all of this.

## How it works

```
mic ─► inputGain ─┬─► dryGain ─────────────────────┐
                  │                                │
                  └─► [8 × shifter → voiceGain] ─► harmonyGain ─┬─► mixBus ─► master ─► out
                                                                └─► convolver ─► wetGain ─┘
```

| File | Role |
| --- | --- |
| `pitch-shifter.js` | `AudioWorkletProcessor` — one voice of real-time pitch shifting |
| `chords.js` | chord-symbol parsing and voicing |
| `app.js` | audio graph, mic, keyboard, chart control |
| `index.html` | markup and styles |
| `test-pitch-shifter.js` | offline DSP check |

Each voice is a **variable delay line with a splice crossfade**. Input is written
to a ring buffer at 1×; a read head's delay drifts at `(1 - ratio)` samples per
sample, which resamples the signal by `ratio` and therefore transposes it. The
delay can only drift so far before it has to jump, so it wraps every 40 ms, and
the wrap is hidden by a 6 ms crossfade with a second head exactly one grain
behind — at the wrap both heads read the same position, so the splice is seamless.

The first version instead overlapped two heads 50% of the time with sin²/cos²
windows. That measured rms 0.500 where a unit sine should give 0.707, and a
narrow-band DFT found more energy in a 5–12 Hz warble sideband than in the
carrier: the two incoherent heads were cancelling the note. The single-head
design fixed both.

The cost of splicing is that harmonies far from unison get rougher, because the
crossfade occupies more of each grain period — roughly 4% of the time at a third,
15% at an octave, 30% at +19 semitones. Thirds and fifths sound smooth; the
extremes sound crunchy. That is inherent to this class of shifter.

Reverb is a `ConvolverNode` fed a JS-generated impulse response (decaying noise),
so there is no audio asset to download.

## Tests

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc test-pitch-shifter.js
```

Runs the real worklet under a small shim — no browser, no mic, no dependencies —
pushing a 220 Hz sine through a range of intervals and measuring the output from
interpolated zero crossings. Clean windows land on the target pitch to 0.00 cents.
It also reports each interval's splice duty, which is the honest predictor of how
rough that interval will sound.

Note that windows straddling a splice read tens of cents off; that is expected,
which is why the assertion is on clean windows and on carrier level.

## Roadmap

- Live pitch detection (YIN / autocorrelation) so keys and chords become absolute
  notes and the "I'm singing" setting disappears
- Chord latch / freeze, so a chord holds hands-free
- Per-voice detune and stereo spread
- Delay, filter, formant control
- Real MIDI input via Web MIDI
