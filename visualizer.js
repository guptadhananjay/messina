/**
 * The visualizer card: two views on one canvas.
 *
 *  - Pitch: a scrolling piano roll of the last few seconds. Your sung pitch is
 *    a bright line, each harmony voice an amber bar at its note, so you can see
 *    the chord land around the melody. This is the view that shows what the
 *    harmonizer is actually doing.
 *  - Wave: an oscilloscope of the output, triggered on a rising zero crossing
 *    so a steady note stands still instead of smearing.
 *
 * The app pushes one frame of state per animation frame; this module owns the
 * history and all the drawing.
 */

const WINDOW_SECONDS = 6;
const MIN_SPAN = 24;             // semitones visible at least - two octaves
const VOICE_WIDTH = 2;

export function createVisualizer(canvas) {
  const g = canvas.getContext('2d');
  const history = [];            // { t, voice: midi|null, notes: [midi] }
  let mode = 'pitch';
  let center = 57;               // midi at the vertical middle, eased toward the data
  let span = MIN_SPAN;
  let scopeGain = 1;
  let width = 0, height = 0, ratio = 1;

  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const theme = {
    text: color('--text'), muted: color('--muted'), faint: color('--faint'),
    line: color('--line'), line2: color('--line-2'), accent: color('--accent'),
    mono: color('--mono'),
  };

  function resize() {
    ratio = window.devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  new ResizeObserver(() => { resize(); drawIdle(); }).observe(canvas);
  resize();

  /* ---------- pitch view ---------- */

  const yOf = (midi) => height / 2 - (midi - center) / span * (height - 16);

  function fitRange(now) {
    let lo = Infinity, hi = -Infinity;
    for (const f of history) {
      if (now - f.t > WINDOW_SECONDS) continue;
      if (f.voice !== null) { lo = Math.min(lo, f.voice); hi = Math.max(hi, f.voice); }
      for (const n of f.notes) { lo = Math.min(lo, n); hi = Math.max(hi, n); }
    }
    if (lo === Infinity) return;
    const wantSpan = Math.max(MIN_SPAN, hi - lo + 6);
    // Ease rather than snap, so the grid glides as the melody moves.
    center += ((lo + hi) / 2 - center) * 0.06;
    span += (wantSpan - span) * 0.06;
  }

  function drawGrid() {
    g.font = `10px ${theme.mono}`;
    g.textBaseline = 'middle';
    const top = Math.ceil(center - span / 2), bottom = Math.floor(center + span / 2);
    for (let m = top; m <= bottom; m++) {
      const y = Math.round(yOf(m)) + 0.5;
      const isC = ((m % 12) + 12) % 12 === 0;
      g.strokeStyle = isC ? theme.line2 : theme.line;
      g.globalAlpha = isC ? 1 : 0.45;
      g.beginPath(); g.moveTo(34, y); g.lineTo(width, y); g.stroke();
      if (isC) {
        g.globalAlpha = 1;
        g.fillStyle = theme.faint;
        g.fillText('C' + (Math.floor(m / 12) - 1), 4, y);
      }
    }
    g.globalAlpha = 1;
  }

  function drawPitch(now) {
    fitRange(now);
    drawGrid();
    const x0 = 34;
    const xOf = (t) => x0 + (1 - (now - t) / WINDOW_SECONDS) * (width - x0 - 8);

    // Harmony bars: one short segment per frame, so held notes read as bars.
    g.fillStyle = theme.accent;
    for (let i = 1; i < history.length; i++) {
      const f = history[i], prev = history[i - 1];
      if (now - f.t > WINDOW_SECONDS) continue;
      const xa = xOf(prev.t), xb = xOf(f.t) + 0.5;
      for (const n of f.notes) g.fillRect(xa, yOf(n) - 2.5, xb - xa, 5);
    }

    // Your voice: a line, broken wherever nothing was tracked.
    g.strokeStyle = theme.text;
    g.lineWidth = VOICE_WIDTH;
    g.lineJoin = 'round';
    g.beginPath();
    let drawing = false;
    for (const f of history) {
      if (now - f.t > WINDOW_SECONDS || f.voice === null) { drawing = false; continue; }
      const x = xOf(f.t), y = yOf(f.voice);
      if (drawing) g.lineTo(x, y); else g.moveTo(x, y);
      drawing = true;
    }
    g.stroke();
    g.lineWidth = 1;

    const last = history[history.length - 1];
    if (last && last.voice !== null && now - last.t < 0.2) {
      g.fillStyle = theme.text;
      g.beginPath(); g.arc(xOf(last.t), yOf(last.voice), 3.5, 0, Math.PI * 2); g.fill();
    }
  }

  /* ---------- wave view ---------- */

  function drawWave(samples) {
    const mid = Math.round(height / 2) + 0.5;
    g.strokeStyle = theme.line2;
    g.beginPath(); g.moveTo(0, mid); g.lineTo(width, mid); g.stroke();
    if (!samples) return;

    // Trigger on a rising zero crossing so a steady note holds still.
    const show = Math.min(1024, samples.length >> 1);
    let start = 0;
    for (let i = 1; i < samples.length - show; i++) {
      if (samples[i - 1] < 0 && samples[i] >= 0) { start = i; break; }
    }
    let peak = 0;
    for (let i = start; i < start + show; i++) peak = Math.max(peak, Math.abs(samples[i]));
    // Auto-scale, eased and floored, so quiet singing is visible but silence stays flat.
    scopeGain += (0.8 / Math.max(peak, 0.05) - scopeGain) * 0.1;

    g.strokeStyle = theme.accent;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < show; i++) {
      const x = i / (show - 1) * width;
      const y = mid - samples[start + i] * scopeGain * (height / 2 - 6);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    g.lineWidth = 1;
  }

  /* ---------- frame ---------- */

  function clear() { g.clearRect(0, 0, width, height); }

  function drawIdle() {
    clear();
    if (mode === 'pitch') drawGrid(); else drawWave(null);
    g.fillStyle = theme.muted;
    g.font = `12px ${css.getPropertyValue('--sans')}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(mode === 'pitch' ? 'Press Start, then sing' : 'Press Start to see the output', width / 2, height / 2);
    g.textAlign = 'left';
  }

  return {
    setMode(m) { mode = m; drawIdle(); },

    /** One animation frame of live state. */
    frame({ voice, notes, samples }) {
      const now = performance.now() / 1000;
      history.push({ t: now, voice, notes });
      while (history.length && now - history[0].t > WINDOW_SECONDS + 0.5) history.shift();
      clear();
      if (mode === 'pitch') drawPitch(now); else drawWave(samples);
    },

    reset() { history.length = 0; drawIdle(); },
  };
}
