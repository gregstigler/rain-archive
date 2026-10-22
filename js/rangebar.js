// Time bar under the charts: the highlighted window shows the visible part of the loaded data.
// Dragging the window only moves it in time. A long press on one of its edges (≈0.45 s without
// moving) unlocks that edge, which can then be dragged to widen or narrow the window.
// Tapping the track outside the window centres the window there.

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 6; // px of finger jitter allowed during the long press
const EDGE_ZONE = 18;     // px around each edge where a long press grabs that edge

export function createRangeBar(el, { onChange, minSpan }) {
  el.innerHTML = '<svg class="rb-shadow" preserveAspectRatio="none" aria-hidden="true"><path/></svg>'
    + '<div class="rb-thumb"><span class="rb-h rb-l"></span><span class="rb-h rb-r"></span></div>';
  const thumb = el.querySelector('.rb-thumb');
  const shadowPath = el.querySelector('.rb-shadow path');
  let min = 0, max = 1, start = 0, end = 1, span = minSpan;
  let g = null;

  const toX = (t) => ((t - min) / (max - min)) * el.clientWidth;
  const perPx = () => (max - min) / el.clientWidth;

  function draw() {
    const l = toX(start), r = toX(end);
    thumb.style.left = `${l}px`;
    thumb.style.width = `${Math.max(6, r - l)}px`;
  }

  function emit(s, e) {
    start = s; end = e;
    draw();
    onChange(start, end);
  }

  function clampMove(s, e) {
    const w = e - s;
    if (s < min) { s = min; e = min + w; }
    if (e > max) { e = max; s = max - w; }
    return [s, e];
  }

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0) return;
    try { el.setPointerCapture(ev.pointerId); } catch { /* pointer already gone */ }
    const rect = el.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const l = toX(start), r = toX(end);
    const onThumb = x >= l - EDGE_ZONE / 2 && x <= r + EDGE_ZONE / 2;
    if (!onThumb) {
      // Tap on the track: centre the window there.
      const c = min + x * perPx();
      emit(...clampMove(c - (end - start) / 2, c + (end - start) / 2));
      return;
    }
    const dl = Math.abs(x - l), dr = Math.abs(x - r);
    const edge = Math.min(dl, dr) <= EDGE_ZONE ? (dl <= dr ? 'l' : 'r') : null;
    g = { id: ev.pointerId, x0: ev.clientX, s0: start, e0: end, mode: 'move', moved: false, timer: 0 };
    if (edge) {
      g.timer = setTimeout(() => {
        if (!g || g.moved) return;
        g.mode = edge;
        el.classList.add(`resizing-${edge}`);
        navigator.vibrate?.(25);
      }, LONG_PRESS_MS);
    }
  });

  el.addEventListener('pointermove', (ev) => {
    if (!g || ev.pointerId !== g.id) return;
    const dx = ev.clientX - g.x0;
    if (!g.moved && Math.abs(dx) <= MOVE_TOLERANCE) return;
    if (!g.moved) { g.moved = true; clearTimeout(g.timer); }
    const dt = dx * perPx();
    if (g.mode === 'move') emit(...clampMove(g.s0 + dt, g.e0 + dt));
    else if (g.mode === 'l') emit(Math.min(Math.max(min, g.s0 + dt), g.e0 - span), g.e0);
    else emit(g.s0, Math.max(Math.min(max, g.e0 + dt), g.s0 + span));
  });

  const stop = () => {
    if (!g) return;
    clearTimeout(g.timer);
    el.classList.remove('resizing-l', 'resizing-r');
    g = null;
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);

  return {
    // Full range, visible window (wall ms) and an optional data profile [[t, v], …] drawn in the track.
    update(o) {
      if (o.min != null) { min = o.min; max = o.max; }
      if (o.minSpan != null) span = o.minSpan;
      if (o.start != null && !g) { start = Math.max(min, o.start); end = Math.min(max, o.end); }
      if (o.shadow) {
        // One column per 2 px holding the largest value: cheap even for years of hourly data.
        const w = el.clientWidth, h = el.clientHeight;
        const cols = new Float64Array(Math.max(1, Math.ceil(w / 2)));
        let top = 1e-9;
        for (const [t, v] of o.shadow) {
          if (v == null) continue;
          const i = Math.min(cols.length - 1, Math.max(0, Math.floor(((t - min) / (max - min)) * cols.length)));
          const a = Math.abs(v);
          if (a > cols[i]) cols[i] = a;
          if (a > top) top = a;
        }
        let d = `M0,${h}`;
        cols.forEach((v, i) => { d += `L${(i * 2).toFixed(0)},${(h - (v / top) * (h - 4)).toFixed(1)}`; });
        shadowPath.setAttribute('d', `${d}L${w},${h}Z`);
        el.querySelector('svg').setAttribute('viewBox', `0 0 ${w} ${h}`);
      }
      draw();
    },
  };
}
