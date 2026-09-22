/**
 * Chord-symbol parsing, the way chord charts and tabs write them:
 *   Am   F#m7   Cmaj7   G7   Dsus4   Bb   C/G   Em7b5   A7#9   E5
 *
 * A chord becomes a set of semitone offsets from a reference pitch -- the note
 * you are singing. Phase 1 has no pitch detection, so the reference is a
 * setting rather than something measured; see chordVoices() below.
 */

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Suffix -> intervals above the root. Longest match wins, so order matters
// only for the fallback scan; exact hits are looked up directly.
const QUALITIES = {
  '':        [0, 4, 7],
  'm':       [0, 3, 7],
  '5':       [0, 7],
  'dim':     [0, 3, 6],
  'aug':     [0, 4, 8],
  'sus2':    [0, 2, 7],
  'sus4':    [0, 5, 7],
  '6':       [0, 4, 7, 9],
  'm6':      [0, 3, 7, 9],
  '69':      [0, 4, 7, 9, 14],
  '7':       [0, 4, 7, 10],
  'm7':      [0, 3, 7, 10],
  'maj7':    [0, 4, 7, 11],
  'mmaj7':   [0, 3, 7, 11],
  'dim7':    [0, 3, 6, 9],
  'm7b5':    [0, 3, 6, 10],
  '7sus4':   [0, 5, 7, 10],
  '7sus2':   [0, 2, 7, 10],
  '9':       [0, 4, 7, 10, 14],
  'm9':      [0, 3, 7, 10, 14],
  'maj9':    [0, 4, 7, 11, 14],
  'add9':    [0, 4, 7, 14],
  'madd9':   [0, 3, 7, 14],
  '11':      [0, 7, 10, 14, 17],
  'm11':     [0, 3, 7, 10, 17],
  '13':      [0, 4, 7, 10, 21],
  'm13':     [0, 3, 7, 10, 21],
  'maj13':   [0, 4, 7, 11, 21],
};

// Alterations that can trail any quality: A7#9, C7b5, Gmaj7#11 ...
const ALTERATIONS = {
  'b5':  { from: 7,  to: 6 },
  '#5':  { from: 7,  to: 8 },
  'b9':  { add: 13 },
  '#9':  { add: 15 },
  '#11': { add: 18 },
  'b13': { add: 20 },
};

/** Normalize the shorthand real charts actually use into table keys. */
function normalizeSuffix(s) {
  return s
    .replace(/[Δ∆]/g, 'maj7')
    .replace(/[°o]7/g, 'dim7')
    .replace(/[°o]/g, 'dim')
    .replace(/[øØ]/g, 'm7b5')
    .replace(/\+/g, 'aug')
    .replace(/[-−–—]/g, 'm')
    .replace(/^maj(?![0-9])/, '')       // Cmaj == C
    .replace(/^M(?![0-9])/, '')         // CM   == C
    .replace(/^M(?=[0-9])/, 'maj')      // CM7  == Cmaj7
    .replace(/^min/, 'm')
    .replace(/^MAJ/i, 'maj')
    .replace(/^dom/i, '')
    .replace(/^sus$/, 'sus4')
    .replace(/^aug7$/, '7#5');
}

/** "F#m7b5/C" -> { root, bass, intervals, symbol } or null if unparseable. */
export function parseChord(symbol) {
  const text = symbol.trim();
  if (!text) return null;

  const [main, bassPart] = text.split('/');
  const m = /^([A-Ga-g])([#b♯♭]*)(.*)$/.exec(main.trim());
  if (!m) return null;

  let root = PITCH_CLASS[m[1].toUpperCase()];
  for (const acc of m[2]) root += (acc === '#' || acc === '♯') ? 1 : -1;
  root = ((root % 12) + 12) % 12;

  let suffix = normalizeSuffix(m[3]);
  let intervals = QUALITIES[suffix];

  if (!intervals) {
    // Longest known quality that prefixes the suffix, then trailing alterations.
    let base = null;
    for (const key of Object.keys(QUALITIES)) {
      if (key && suffix.startsWith(key) && (!base || key.length > base.length)) base = key;
    }
    if (base === null && /^[b#]/.test(suffix)) base = '';   // e.g. C#5 handled as alteration
    if (base === null) return null;

    intervals = QUALITIES[base].slice();
    let rest = suffix.slice(base.length);
    while (rest) {
      const alt = Object.keys(ALTERATIONS).find((a) => rest.startsWith(a));
      if (!alt) return null;
      const rule = ALTERATIONS[alt];
      if (rule.add !== undefined) intervals.push(rule.add);
      else intervals = intervals.map((i) => (i === rule.from ? rule.to : i));
      rest = rest.slice(alt.length);
    }
  }

  let bass = null;
  if (bassPart !== undefined) {
    const b = /^([A-Ga-g])([#b♯♭]*)\s*$/.exec(bassPart.trim());
    if (!b) return null;
    bass = PITCH_CLASS[b[1].toUpperCase()];
    for (const acc of b[2]) bass += (acc === '#' || acc === '♯') ? 1 : -1;
    bass = ((bass % 12) + 12) % 12;
  }

  return { root, bass, intervals: intervals.slice(), symbol: text };
}

/**
 * Split a chart into chords. Bar lines, repeat dots, line breaks and extra
 * spaces are separators; anything unparseable comes back with chord === null
 * so the UI can point at it.
 */
export function parseProgression(text) {
  return text
    .split(/[\s|]+/)
    .map((t) => t.replace(/^[.:]+|[.:]+$/g, ''))
    .filter((t) => t && !/^[-x%]+$/i.test(t))
    .map((token) => ({ token, chord: parseChord(token) }));
}

/**
 * Chord -> semitone offsets for the shifter voices, relative to the note you
 * are singing (`reference`, a pitch class).
 *
 * The root is placed at whichever octave sits closest to your voice, so a
 * progression moves by small intervals instead of leaping; the rest of the
 * chord stacks above it, and a slash bass drops below. Offsets are clamped to
 * the shifter's +/- 24 semitone range and capped at `maxVoices`.
 */
export function chordVoices(chord, reference = 0, maxVoices = 8) {
  let rootOffset = (((chord.root - reference) % 12) + 12) % 12;
  if (rootOffset > 6) rootOffset -= 12;              // nearest octave to the voice

  const offsets = chord.intervals.map((i) => rootOffset + i);

  if (chord.bass !== null) {
    offsets.unshift((((chord.bass - reference) % 12) + 12) % 12 - 12);
  }

  return offsets
    .map((s) => Math.max(-24, Math.min(24, s)))
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .slice(0, maxVoices);
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Chord -> absolute MIDI notes, placed around the note you are actually
 * singing. Phase 1 could only return intervals because nothing knew your pitch;
 * with detection, `referenceMidi` is measured rather than guessed.
 *
 * `fold` moves every note to the octave nearest your voice, so no harmony is
 * transposed more than six semitones. That trades the written voicing for
 * quality, which is the right trade for a vocal stack: the further a voice is
 * shifted, the rougher it sounds. With `fold` off, the chord keeps its stacked
 * shape - root nearest your voice, the rest above it, slash bass below.
 */
export function chordNotes(chord, referenceMidi, options = {}) {
  const { fold = true, maxVoices = 8 } = options;
  const ref = Math.round(referenceMidi);

  const nearest = (pc, target) => {
    let d = (((pc - target) % 12) + 12) % 12;
    if (d > 6) d -= 12;
    return target + d;
  };

  const rootMidi = nearest(chord.root, ref);
  let notes = chord.intervals.map((i) => rootMidi + i);
  if (chord.bass !== null) notes.unshift(nearest(chord.bass, ref - 12));
  if (fold) notes = notes.map((n) => nearest(((n % 12) + 12) % 12, ref));

  return [...new Set(notes)]
    .map((n) => Math.max(24, Math.min(96, n)))
    .slice(0, maxVoices);
}

/** MIDI note number -> "A#3", for the readouts. */
export function noteName(midi) {
  const m = Math.round(midi);
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}
