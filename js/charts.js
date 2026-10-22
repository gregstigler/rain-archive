// ECharts rendering: one synced chart per variable ("stacked") or a single multi-axis chart ("combined").
import { VAR_BY_KEY, decimals, wmoLabel, compass } from './vars.js?v=10';
import { fmtWall } from './data.js?v=10';

const PALETTE = ['#2f7fd8', '#e8743b', '#19a979', '#945ecf', '#d4526e', '#13a4b4', '#ce8f1f', '#6b7a8f'];
const GROUP = 'rain-archive';
let instances = [];

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

const colorFor = (keys, k) => PALETTE[keys.indexOf(k) % PALETTE.length];

const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const PINCH_TOLERANCE = 0.15; // finger spacing may change ±15 % during a two-finger pan

/**
 * Two-finger gestures on a chart: moving both fingers pans the time window; spreading or
 * pinching them (beyond the tolerance) zooms around their midpoint. One finger is left to
 * ECharts, which shows the tooltip under the finger as a tap would.
 */
function attachTouch(chart, el, min, max, minSpan) {
  let g = null;
  const mid = (t) => (t[0].clientX + t[1].clientX) / 2;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) { g = null; return; }
    const dz = chart.getOption().dataZoom[0];
    const rect = chart.getModel().getComponent('grid').coordinateSystem.getRect();
    const box = el.getBoundingClientRect();
    g = {
      s: min + (dz.start / 100) * (max - min), e: min + (dz.end / 100) * (max - min),
      m0: mid(e.touches), d0: dist(e.touches), left: box.left + rect.x, width: rect.width, mode: null,
    };
    chart.dispatchAction({ type: 'hideTip' });
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length !== 2) return;
    e.preventDefault();
    const ratio = dist(e.touches) / g.d0;
    const dx = mid(e.touches) - g.m0;
    if (!g.mode) {
      if (Math.abs(ratio - 1) > PINCH_TOLERANCE) g.mode = 'zoom';
      else if (Math.abs(dx) > 8) g.mode = 'pan';
      else return;
    }
    const span = g.e - g.s;
    const perPx = span / g.width;
    let s, en;
    if (g.mode === 'pan') {
      s = g.s - dx * perPx;
      en = g.e - dx * perPx;
    } else {
      const anchor = g.s + (g.m0 - g.left) * perPx; // time under the fingers at the start
      const newSpan = Math.min(max - min, Math.max(minSpan, span / ratio));
      const frac = (g.m0 - g.left) / g.width;
      s = anchor - frac * newSpan + -dx * (newSpan / g.width);
      en = s + newSpan;
    }
    if (s < min) { en += min - s; s = min; }
    if (en > max) { s -= en - max; en = max; }
    chart.dispatchAction({ type: 'dataZoom', startValue: Math.max(min, s), endValue: en });
  }, { passive: false });
  el.addEventListener('touchend', (e) => { if (e.touches.length < 2) g = null; }, { passive: true });
}

// Title line: "● Rain (total 14.2 mm)" with an optional detail line. t = {agg, value, extra}.
function titleEl(key, color, t) {
  const el = document.createElement('div');
  el.className = 'chart-title';
  el.innerHTML = '<span class="dot"></span><span class="name"></span> <span class="agg">(<span class="k"></span> <b></b>)</span><span class="extra"></span>';
  el.querySelector('.dot').style.background = color;
  el.querySelector('.name').textContent = VAR_BY_KEY[key].label;
  el.querySelector('.k').textContent = t?.agg || '';
  el.querySelector('b').textContent = t?.value || '–';
  el.querySelector('.extra').textContent = t?.extra || '';
  if (!t?.extra) el.querySelector('.extra').remove();
  return el;
}

export function disposeCharts() {
  instances.forEach((c) => c.dispose());
  instances = [];
}

export function resizeCharts() { instances.forEach((c) => c.resize()); }

// Full x range of the last render (wall ms) and a way to set the visible window from outside.
export let chartRange = null;
export function setZoom(startMs, endMs) {
  instances[0]?.dispatchAction({ type: 'dataZoom', startValue: startMs, endValue: endMs }); // connected charts follow
}

function fmtVal(v, unit) {
  if (v == null || Number.isNaN(v)) return '–';
  return `${v.toFixed(decimals(unit))} ${unit}`;
}

function fmtHeader(ms, gran, hours) {
  if (gran === 'day') return fmtWall(ms, false) + (hours < 24 ? ` <span style="opacity:.7">(${hours} h)</span>` : '');
  const start = fmtWall(ms - 3600e3, true, false).split(' ').pop();
  return `${fmtWall(ms)} <span style="opacity:.7">(${start}–${fmtWall(ms, true, false).split(' ').pop()})</span>`;
}

function tooltipLine(color, label, text) {
  return `<div style="display:flex;gap:6px;align-items:center"><span style="width:9px;height:9px;border-radius:50%;background:${color}"></span>${label}: <b>${text}</b></div>`;
}

function describe(key, s, i, gran) {
  const v = VAR_BY_KEY[key];
  if (v.kind === 'code') return wmoLabel(s.val[i]);
  if (v.kind === 'dir') return s.val[i] == null ? '–' : `${Math.round(s.val[i])}° ${compass(s.val[i])}`;
  let t = fmtVal(s.val[i], s.unit);
  if (v.kind === 'mean' && gran === 'day' && s.min[i] != null) t += ` <span style="opacity:.75">(${fmtVal(s.min[i], s.unit)} – ${fmtVal(s.max[i], s.unit)})</span>`;
  if (s.cum) t += ` <span style="opacity:.75">· total ${fmtVal(s.cum[i], s.unit)}</span>`;
  return t;
}

// Series for one variable. axes = {main, cum} y-axis indices.
function seriesFor(key, s, x, gran, color, axes, theme) {
  const v = VAR_BY_KEY[key];
  const pts = (arr) => x.map((t, i) => [t, arr[i]]);
  const out = [];
  // Long series: bars drawn in "large" batch mode, lines thinned to their visible shape (LTTB).
  const many = x.length > 2000;
  const fast = { sampling: 'lttb', progressive: 4000 };
  if (v.kind === 'sum') {
    out.push({ name: v.label, type: 'bar', yAxisIndex: axes.main, data: pts(s.val), itemStyle: { color }, barMaxWidth: 26, barCategoryGap: '15%',
      large: many, largeThreshold: 2000 });
    out.push({ name: `${v.label} – running total`, type: 'line', yAxisIndex: axes.cum, data: pts(s.cum), showSymbol: false, ...fast,
      lineStyle: { color: theme.text, width: 1.5, type: 'dashed', opacity: 0.8 }, itemStyle: { color: theme.text }, step: false, z: 3 });
  } else if (v.kind === 'dir' || v.kind === 'code') {
    out.push({ name: v.label, type: 'scatter', yAxisIndex: axes.main, data: pts(s.val), symbolSize: many ? 3 : 6, itemStyle: { color },
      large: many, largeThreshold: 2000 });
  } else {
    if (gran === 'day') {
      const stack = `band-${key}`;
      out.push({ name: `${v.label} min`, type: 'line', yAxisIndex: axes.main, data: pts(s.min), stack, showSymbol: false, lineStyle: { opacity: 0 }, silent: true, ...fast });
      out.push({ name: `${v.label} range`, type: 'line', yAxisIndex: axes.main, data: x.map((t, i) => [t, s.max[i] == null ? null : s.max[i] - s.min[i]]),
        stack, showSymbol: false, lineStyle: { opacity: 0 }, areaStyle: { color, opacity: 0.18 }, silent: true, ...fast });
    }
    out.push({ name: v.label, type: 'line', yAxisIndex: axes.main, data: pts(s.val), showSymbol: x.length < 60, symbolSize: 4, ...fast,
      connectNulls: false, lineStyle: { color, width: 2 }, itemStyle: { color } });
  }
  return out;
}

function yAxis(name, unitKind, theme, position, offset, showGrid) {
  const ax = {
    type: 'value', name, position, offset, nameTextStyle: { color: theme.muted, fontSize: 11, align: position === 'left' ? 'left' : 'right' },
    axisLabel: { color: theme.muted, fontSize: 11 }, splitLine: { show: showGrid, lineStyle: { color: theme.grid } }, scale: unitKind !== 'sum',
  };
  if (unitKind === 'sum') ax.min = 0;
  if (unitKind === 'dir') Object.assign(ax, { min: 0, max: 360, interval: 90, axisLabel: { color: theme.muted, fontSize: 11, formatter: (d) => compass(d) } });
  return ax;
}

function axisRange(x, gran) {
  const step = gran === 'day' ? 86400e3 : 3600e3;
  return { min: x[0] - step / 2, max: x[x.length - 1] + step / 2 };
}

function baseOption(x, gran, theme, tooltipFmt, showSlider, gridRight, gridLeft, zoom) {
  const step = gran === 'day' ? 86400e3 : 3600e3;
  const { min, max } = axisRange(x, gran);
  const win = zoom ? { startValue: Math.max(min, zoom.startMs), endValue: Math.min(max, zoom.endMs) } : {};
  // Wide daily bars just outside the window would otherwise spill into view: drop them.
  const filterMode = gran === 'day' ? 'filter' : 'none';
  return {
    useUTC: true, // x values are wall-clock times of the location, encoded as UTC
    animation: false,
    textStyle: { color: theme.text },
    grid: { left: gridLeft, right: gridRight, top: 30, bottom: 24 }, // the time bar lives outside (rangebar.js)
    tooltip: {
      trigger: 'axis', confine: true, triggerOn: 'mousemove|click',
      backgroundColor: theme.card, borderColor: theme.line, textStyle: { color: theme.text, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: theme.muted }, label: { show: false } },
      formatter: tooltipFmt,
    },
    xAxis: {
      type: 'time', min, max, minInterval: gran === 'day' ? 86400e3 : undefined,
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true,
        ...(gran === 'day' ? { formatter: { year: '{yyyy}', month: '{MMM}', day: '{d} {MMM}', hour: '', minute: '' } } : {}) },
      axisLine: { lineStyle: { color: theme.line } },
      splitLine: { show: false },
    },
    dataZoom: [
      // Touch screens: built-in drag/pinch off; one finger shows values, two fingers pan/zoom (attachTouch).
      { type: 'inside', id: 'dz-in', xAxisIndex: 0, filterMode, disabled: IS_TOUCH, zoomOnMouseWheel: true, moveOnMouseMove: true, minValueSpan: gran === 'day' ? step : step * 3, ...win },
    ],
  };
}

function themeColors() {
  return { text: css('--text'), muted: css('--muted'), line: css('--line'), grid: css('--chart-grid'), card: css('--card') };
}

/**
 * agg: result of aggregate(); keys: variables; gran: 'hour'|'day'; mode: 'stacked'|'combined'.
 * opts.zoom: {startMs, endMs} visible window to restore (wall ms);
 * opts.onZoom({startMs, endMs, atLeftEdge, atRightEdge}) is called after the user zooms or pans.
 */
export function renderCharts(container, agg, keys, gran, mode, opts = {}) {
  disposeCharts();
  container.innerHTML = '';
  container.style.setProperty('--n', keys.length); // used by full-screen sizing
  if (!agg.x.length) return;
  const theme = themeColors();
  const { x, hours, series } = agg;
  const color = (k) => colorFor(keys, k);
  const titles = opts.titles || {};
  const { min, max } = axisRange(x, gran);
  const minSpan = gran === 'day' ? 86400e3 : 3 * 3600e3;
  chartRange = { min, max, minSpan };
  const zoom = opts.zoom;
  const listen = (chart) => {
    if (!opts.onZoom) return;
    chart.on('datazoom', () => {
      const dz = chart.getOption().dataZoom[0];
      const startMs = min + (dz.start / 100) * (max - min);
      const endMs = min + (dz.end / 100) * (max - min);
      opts.onZoom({ startMs, endMs, atLeftEdge: dz.start <= 0.2, atRightEdge: dz.end >= 99.8 });
    });
  };

  const makeTooltip = (ks) => (params) => {
    const i = params[0]?.dataIndex;
    if (i == null) return '';
    return `<div style="margin-bottom:4px">${fmtHeader(x[i], gran, hours[i])}</div>` +
      ks.map((k) => tooltipLine(color(k), VAR_BY_KEY[k].label, describe(k, series[k], i, gran))).join('');
  };

  if (mode === 'combined') {
    keys.forEach((k) => container.append(titleEl(k, color(k), titles[k])));
    const el = document.createElement('div');
    el.className = 'chart combined';
    container.appendChild(el);
    // One y axis per unit (+ one per unit for running totals), alternating left/right, all labelled.
    // Each axis is coloured like its variable so it is clear which scale goes with which curve.
    const narrow = container.clientWidth < 600;
    const AX_W = narrow ? 34 : 46;
    const axes = [];
    const axisIdx = (id, name, kind, col) => {
      let i = axes.findIndex((a) => a.id === id);
      if (i < 0) {
        const side = axes.length % 2 === 0 ? 'left' : 'right';
        const offset = Math.floor(axes.length / 2) * AX_W;
        const ax = yAxis(name, kind, theme, side, offset, axes.length === 0);
        ax.axisLine = { show: true, lineStyle: { color: col } };
        ax.axisLabel = { ...ax.axisLabel, color: col, fontSize: narrow ? 10 : 11, margin: 4 };
        ax.nameTextStyle = { ...ax.nameTextStyle, color: col, fontSize: narrow ? 10 : 11 };
        axes.push({ id, ...ax });
        i = axes.length - 1;
      }
      return i;
    };
    const all = [];
    for (const k of keys) {
      const v = VAR_BY_KEY[k];
      const s = series[k];
      const unitName = v.kind === 'code' ? 'WMO' : s.unit;
      const main = axisIdx(`${v.kind === 'dir' ? 'dir' : unitName}`, unitName, v.kind, color(k));
      const cum = s.cum ? axisIdx(`${unitName}-cum`, `Σ ${unitName}`, 'sum', theme.muted) : 0;
      all.push(...seriesFor(k, s, x, gran, color(k), { main, cum }, theme));
    }
    const lefts = Math.ceil(axes.length / 2), rights = Math.floor(axes.length / 2);
    const opt = baseOption(x, gran, theme, makeTooltip(keys), true, 8 + Math.max(rights, 1) * AX_W, 8 + lefts * AX_W, zoom);
    opt.yAxis = axes.map(({ id, ...a }) => a);
    opt.series = all; // no legend: the coloured titles above the chart play that role
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chart.setOption(opt);
    listen(chart);
    if (IS_TOUCH) attachTouch(chart, el, min, max, minSpan);
    instances.push(chart);
    return;
  }

  keys.forEach((k, n) => {
    const v = VAR_BY_KEY[k];
    const s = series[k];
    const last = n === keys.length - 1;
    const title = titleEl(k, color(k), titles[k]);
    const el = document.createElement('div');
    el.className = 'chart' + (last ? ' last' : '');
    container.append(title, el);

    const unitName = v.kind === 'code' ? 'WMO' : s.unit;
    const yAxes = [yAxis(unitName, v.kind, theme, 'left', 0, true)];
    if (s.cum) yAxes.push(yAxis(`Σ ${s.unit}`, 'sum', theme, 'right', 0, false));
    const opt = baseOption(x, gran, theme, makeTooltip([k]), last, 56, 56, zoom);
    opt.yAxis = yAxes;
    opt.series = seriesFor(k, s, x, gran, color(k), { main: 0, cum: 1 }, theme);
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chart.setOption(opt);
    chart.group = GROUP;
    if (n === 0) listen(chart); // connected charts zoom together; one listener is enough
    if (IS_TOUCH) attachTouch(chart, el, min, max, minSpan);
    instances.push(chart);
  });
  echarts.connect(GROUP);
}
