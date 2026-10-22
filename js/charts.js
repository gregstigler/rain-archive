// ECharts rendering: one synced chart per variable ("stacked") or a single multi-axis chart ("combined").
// When only the data or the time range changes, existing charts are updated in place (no flicker).
import { VAR_BY_KEY, decimals, wmoLabel, compass } from './vars.js?v=15';
import { fmtWall, STEP_MS } from './data.js?v=15';

const PALETTE = ['#2f7fd8', '#e8743b', '#19a979', '#945ecf', '#d4526e', '#13a4b4', '#ce8f1f', '#6b7a8f'];
const GROUP = 'rain-archive';
const DAY = 86400e3;
let instances = [];
let current = null; // {sig, titleEls: {key: el}, gran}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

const colorFor = (keys, k) => PALETTE[keys.indexOf(k) % PALETTE.length];

const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const PINCH_TOLERANCE = 0.15; // finger spacing may change ±15 % during a two-finger pan

// Full x range of the charts (wall ms) and smallest visible span; shared with the gesture code and the app.
export const chartRange = { min: 0, max: 1, minSpan: 3 * 3600e3 };

// ---------- Axis labels ----------
// Bottom labels depend on the visible span; weekday labels on top only when days are readable.

const WD = ['Sun.', 'Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
let labelMode = 'days';
let topShown = true;

function modeFor(spanMs) {
  const d = spanMs / DAY;
  if (d > 6 * 365) return 'years';      // 2019 2020 2021
  if (d > 540) return 'monthLetters';    // 2025 F M A M J …
  if (d > 60) return 'months';           // 2025 Feb Mar Apr …
  if (d > 4) return 'days';              // 1 Jan 2 Jan 3 Jan
  return 'hours';                        // 1 Jan 06:00 12:00 18:00 2 Jan
}
const topFor = (spanMs, gran) => (gran === 'hour' || gran === 'day') && spanMs <= 45 * DAY;

function bottomLabel(ms) {
  const d = new Date(ms);
  const isDay = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  const isMonth = isDay && d.getUTCDate() === 1;
  const isYear = isMonth && d.getUTCMonth() === 0;
  switch (labelMode) {
    case 'years': return isYear ? String(d.getUTCFullYear()) : '';
    case 'monthLetters': return isYear ? String(d.getUTCFullYear()) : isMonth ? MO[d.getUTCMonth()][0] : '';
    case 'months': return isYear ? String(d.getUTCFullYear()) : isMonth ? MO[d.getUTCMonth()] : '';
    case 'days': return isDay ? `${d.getUTCDate()} ${MO[d.getUTCMonth()]}` : '';
    default: return isDay ? `${d.getUTCDate()} ${MO[d.getUTCMonth()]}` : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
}
const topLabel = (ms) => WD[new Date(ms).getUTCDay()];

function xAxes(theme, gran) {
  const range = { min: chartRange.min, max: chartRange.max };
  const days = gran === 'hour' || gran === 'day';
  return [
    {
      type: 'time', ...range, position: 'bottom',
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: bottomLabel },
      axisLine: { lineStyle: { color: theme.line } },
      splitLine: { show: !topShown, lineStyle: { color: theme.grid } },
    },
    {
      // Weekdays, written diagonally above the chart; their tick lines run down through the plot.
      type: 'time', ...range, position: 'top', show: days && topShown, minInterval: DAY, maxInterval: DAY,
      axisLabel: { color: theme.muted, fontSize: 10, rotate: 45, hideOverlap: true, formatter: topLabel, margin: 4 },
      axisTick: { show: true, length: 5, lineStyle: { color: theme.line } },
      axisLine: { show: false },
      splitLine: { show: true, lineStyle: { color: theme.grid } },
    },
  ];
}

// Called after each zoom/pan: switch label style when the visible span crosses a threshold.
function refreshLabels(chart, spanMs, gran, theme) {
  const m = modeFor(spanMs), t = topFor(spanMs, gran);
  if (m === labelMode && t === topShown) return;
  labelMode = m; topShown = t;
  for (const c of instances) c.setOption({ xAxis: xAxes(theme, gran) });
}

// ---------- Touch gestures ----------

/**
 * Two-finger gestures on a chart: moving both fingers pans the time window; spreading or
 * pinching them (beyond the tolerance) zooms around their midpoint. One finger is left to
 * ECharts, which shows the tooltip under the finger as a tap would.
 */
function attachTouch(chart, el) {
  let g = null;
  const mid = (t) => (t[0].clientX + t[1].clientX) / 2;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) { g = null; return; }
    const { min, max } = chartRange;
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
    const { min, max, minSpan } = chartRange;
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
      s = anchor - frac * newSpan - dx * (newSpan / g.width);
      en = s + newSpan;
    }
    if (s < min) { en += min - s; s = min; }
    if (en > max) { s -= en - max; en = max; }
    chart.dispatchAction({ type: 'dataZoom', startValue: Math.max(min, s), endValue: en });
  }, { passive: false });
  el.addEventListener('touchend', (e) => { if (e.touches.length < 2) g = null; }, { passive: true });
}

// ---------- Titles, tooltip ----------

// Title line: "● Rain (total 14.2 mm)" with an optional detail line. t = {agg, value, extra}.
function titleEl(key, color) {
  const el = document.createElement('div');
  el.className = 'chart-title';
  el.innerHTML = '<span class="dot"></span><span class="name"></span> <span class="agg">(<span class="k"></span> <b></b>)</span><span class="extra"></span>';
  el.querySelector('.dot').style.background = color;
  el.querySelector('.name').textContent = VAR_BY_KEY[key].label;
  return el;
}
function fillTitle(el, t) {
  el.querySelector('.k').textContent = t?.agg || '';
  el.querySelector('b').textContent = t?.value || '–';
  const ex = el.querySelector('.extra');
  ex.textContent = t?.extra || '';
  ex.hidden = !t?.extra;
}

export function disposeCharts() {
  instances.forEach((c) => c.dispose());
  instances = [];
  current = null;
}

export function resizeCharts() { instances.forEach((c) => c.resize()); }

export function setZoom(startMs, endMs) {
  instances[0]?.dispatchAction({ type: 'dataZoom', startValue: startMs, endValue: endMs }); // connected charts follow
}

function fmtVal(v, unit) {
  if (v == null || Number.isNaN(v)) return '–';
  return `${v.toFixed(decimals(unit))} ${unit}`;
}

// Tooltip header for the bar covering [start, end) (wall ms).
function fmtHeader(start, end, gran, hours) {
  const d = new Date(start);
  const partial = (full) => (hours < full ? ` <span style="opacity:.7">(${hours} h)</span>` : '');
  if (gran === 'year') return `${d.getUTCFullYear()}${partial(8760)}`;
  if (gran === 'month') return `${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}${partial(672)}`;
  if (gran === 'day') return fmtWall(start, false) + partial(24);
  const hm = (ms) => fmtWall(ms, true, false).split(' ').pop();
  return `${fmtWall(end)} <span style="opacity:.7">(${hm(start)}–${hm(end)})</span>`;
}

function tooltipLine(color, label, text) {
  return `<div style="display:flex;gap:6px;align-items:center"><span style="width:9px;height:9px;border-radius:50%;background:${color}"></span>${label}: <b>${text}</b></div>`;
}

function describe(key, s, i, gran) {
  const v = VAR_BY_KEY[key];
  if (v.kind === 'code') return wmoLabel(s.val[i]);
  if (v.kind === 'dir') return s.val[i] == null ? '–' : `${Math.round(s.val[i])}° ${compass(s.val[i])}`;
  let t = fmtVal(s.val[i], s.unit);
  if (v.kind === 'mean' && gran !== 'hour' && s.min[i] != null) t += ` <span style="opacity:.75">(${fmtVal(s.min[i], s.unit)} – ${fmtVal(s.max[i], s.unit)})</span>`;
  if (s.cum) t += ` <span style="opacity:.75">· total ${fmtVal(s.cum[i], s.unit)}</span>`;
  return t;
}

// ---------- Series and axes ----------

// Series for one variable. axes = {main, cum} y-axis indices.
function seriesFor(key, s, x, gran, color, axes, theme) {
  const v = VAR_BY_KEY[key];
  const pts = (arr) => x.map((t, i) => [t, arr[i]]);
  const out = [];
  // Long series: bars drawn in "large" batch mode, lines thinned to their visible shape (LTTB).
  const many = x.length > 2000;
  const fast = { sampling: 'lttb', progressive: 4000 };
  if (v.kind === 'sum') {
    out.push({ name: v.label, type: 'bar', yAxisIndex: axes.main, data: pts(s.val), itemStyle: { color }, barMaxWidth: 40, barCategoryGap: '15%',
      large: many, largeThreshold: 2000 });
    out.push({ name: `${v.label} – running total`, type: 'line', yAxisIndex: axes.cum, data: pts(s.cum), showSymbol: false, ...fast,
      lineStyle: { color: theme.text, width: 1.5, type: 'dashed', opacity: 0.8 }, itemStyle: { color: theme.text }, z: 3 });
  } else if (v.kind === 'dir' || v.kind === 'code') {
    out.push({ name: v.label, type: 'scatter', yAxisIndex: axes.main, data: pts(s.val), symbolSize: many ? 3 : 6, itemStyle: { color },
      large: many, largeThreshold: 2000 });
  } else {
    if (gran !== 'hour') {
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

// Unit names run vertically along their axis, so the space above the plot stays free for weekdays.
function yAxis(name, unitKind, theme, position, offset, showGrid, gap) {
  const ax = {
    type: 'value', name, position, offset, nameLocation: 'middle', nameRotate: 90, nameGap: gap,
    nameTextStyle: { color: theme.muted, fontSize: 11 },
    axisLabel: { color: theme.muted, fontSize: 11 }, splitLine: { show: showGrid, lineStyle: { color: theme.grid } }, scale: unitKind !== 'sum',
  };
  if (unitKind === 'sum') ax.min = 0;
  if (unitKind === 'dir') Object.assign(ax, { min: 0, max: 360, interval: 90, axisLabel: { color: theme.muted, fontSize: 11, formatter: (d) => compass(d) } });
  return ax;
}

function baseOption(gran, theme, tooltipFmt, gridRight, gridLeft, zoom) {
  const step = STEP_MS[gran];
  const { min, max } = chartRange;
  const win = zoom ? { startValue: Math.max(min, zoom.startMs), endValue: Math.min(max, zoom.endMs) } : {};
  // Wide bars just outside the window would otherwise spill into view: drop them (not for hours).
  const filterMode = gran === 'hour' ? 'none' : 'filter';
  return {
    useUTC: true, // x values are wall-clock times of the location, encoded as UTC
    animation: false,
    textStyle: { color: theme.text },
    grid: { left: gridLeft, right: gridRight, top: gran === 'hour' || gran === 'day' ? 40 : 14, bottom: 24 },
    tooltip: {
      trigger: 'axis', confine: true, triggerOn: 'mousemove|click',
      backgroundColor: theme.card, borderColor: theme.line, textStyle: { color: theme.text, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: theme.muted }, label: { show: false } },
      formatter: tooltipFmt,
    },
    xAxis: xAxes(theme, gran),
    dataZoom: [
      // Touch screens: built-in drag/pinch off; one finger shows values, two fingers pan/zoom (attachTouch).
      { type: 'inside', id: 'dz-in', xAxisIndex: [0, 1], filterMode, disabled: IS_TOUCH, zoomOnMouseWheel: true, moveOnMouseMove: true,
        minValueSpan: gran === 'hour' ? step * 3 : step, ...win },
    ],
  };
}

function themeColors() {
  return { text: css('--text'), muted: css('--muted'), line: css('--line'), grid: css('--chart-grid'), card: css('--card') };
}

/**
 * agg: result of aggregate(); keys: variables; gran: 'hour'|'day'|'month'|'year'; mode: 'stacked'|'combined'.
 * opts.range: {min, max} x range (wall ms), defaults to the data extent;
 * opts.zoom: {startMs, endMs} visible window (wall ms);
 * opts.titles: {key: {agg, value, extra}};
 * opts.onZoom({startMs, endMs}) is called after the user zooms or pans.
 */
export function renderCharts(container, agg, keys, gran, mode, opts = {}) {
  if (!agg.x.length) { disposeCharts(); container.innerHTML = ''; return; }
  const theme = themeColors();
  const { x, hours, series } = agg;
  const color = (k) => colorFor(keys, k);
  const titles = opts.titles || {};
  const step = STEP_MS[gran];
  const range = opts.range || { min: agg.start[0], max: agg.end[agg.end.length - 1] };
  Object.assign(chartRange, range, { minSpan: gran === 'hour' ? 3 * 3600e3 : step });
  const zoom = opts.zoom;
  const span = zoom ? zoom.endMs - zoom.startMs : range.max - range.min;
  labelMode = modeFor(span);
  topShown = topFor(span, gran);

  const makeTooltip = (ks) => (params) => {
    const i = params[0]?.dataIndex;
    if (i == null) return '';
    return `<div style="margin-bottom:4px">${fmtHeader(agg.start[i], agg.end[i], gran, hours[i])}</div>` +
      ks.map((k) => tooltipLine(color(k), VAR_BY_KEY[k].label, describe(k, series[k], i, gran))).join('');
  };

  // Options for every chart, in display order.
  const narrow = container.clientWidth < 600;
  const charts = [];
  if (mode === 'combined') {
    // One y axis per unit (+ one per unit for running totals), alternating left/right, all labelled
    // and coloured like their variable.
    const AX_W = narrow ? 44 : 52;
    const axes = [];
    const axisIdx = (id, name, kind, col) => {
      let i = axes.findIndex((a) => a.id === id);
      if (i < 0) {
        const side = axes.length % 2 === 0 ? 'left' : 'right';
        const offset = Math.floor(axes.length / 2) * AX_W;
        const ax = yAxis(name, kind, theme, side, offset, axes.length === 0, narrow ? 28 : 34);
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
    const opt = baseOption(gran, theme, makeTooltip(keys), 8 + Math.max(rights, 1) * AX_W, 8 + lefts * AX_W, zoom);
    opt.yAxis = axes.map(({ id, ...a }) => a);
    opt.series = all; // no legend: the coloured titles above the chart play that role
    charts.push({ opt, cls: 'chart combined' });
  } else {
    keys.forEach((k, n) => {
      const v = VAR_BY_KEY[k];
      const s = series[k];
      const unitName = v.kind === 'code' ? 'WMO' : s.unit;
      const yAxes = [yAxis(unitName, v.kind, theme, 'left', 0, true, 36)];
      if (s.cum) yAxes.push(yAxis(`Σ ${s.unit}`, 'sum', theme, 'right', 0, false, 36));
      const opt = baseOption(gran, theme, makeTooltip([k]), 56, 56, zoom);
      opt.yAxis = yAxes;
      opt.series = seriesFor(k, s, x, gran, color(k), { main: 0, cum: 1 }, theme);
      charts.push({ opt, cls: 'chart' + (n === keys.length - 1 ? ' last' : '') });
    });
  }

  // Same layout as now: update in place, so the screen does not flash.
  const sig = [mode, gran, keys.join(','), narrow, theme.text].join('|');
  if (current && current.sig === sig && instances.length === charts.length) {
    charts.forEach((c, i) => instances[i].setOption(c.opt));
    keys.forEach((k) => fillTitle(current.titleEls[k], titles[k]));
    return;
  }

  disposeCharts();
  container.innerHTML = '';
  container.style.setProperty('--n', keys.length); // used by full-screen sizing
  const titleEls = {};
  const listen = (chart) => {
    chart.on('datazoom', () => {
      const { min, max } = chartRange;
      const dz = chart.getOption().dataZoom[0];
      const startMs = min + (dz.start / 100) * (max - min);
      const endMs = min + (dz.end / 100) * (max - min);
      refreshLabels(chart, endMs - startMs, gran, theme);
      opts.onZoom?.({ startMs, endMs });
    });
  };
  if (mode === 'combined') keys.forEach((k) => { titleEls[k] = titleEl(k, color(k)); container.append(titleEls[k]); });
  charts.forEach((c, n) => {
    if (mode !== 'combined') { const k = keys[n]; titleEls[k] = titleEl(k, color(k)); container.append(titleEls[k]); }
    const el = document.createElement('div');
    el.className = c.cls;
    container.append(el);
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    chart.setOption(c.opt);
    if (n === 0) listen(chart); // connected charts zoom together; one listener is enough
    if (IS_TOUCH) attachTouch(chart, el);
    if (mode !== 'combined') chart.group = GROUP;
    instances.push(chart);
  });
  keys.forEach((k) => fillTitle(titleEls[k], titles[k]));
  if (mode !== 'combined') echarts.connect(GROUP);
  current = { sig, titleEls };
}
