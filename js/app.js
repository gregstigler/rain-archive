import {
  VARS, VAR_BY_KEY, QUICK_VARS, FAMILIES, MODELS, IFS_FROM, pre2017Source, defaultUnits, decimals, wmoLabel, compass,
} from './vars.js?v=6';
import {
  HOUR, searchPlaces, resolvePoint, getElevation, fetchHourly, aggregate,
  zonedToUnix, unixToZonedInput, floorLocalHour, wallMs, fmtWall, fmtDuration,
  DURATION_UNITS, subtractDuration, bestDuration,
} from './data.js?v=6';
import { renderCharts, disposeCharts, resizeCharts } from './charts.js?v=6';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'rain-archive-state';
const MIN_DATE = Date.UTC(1940, 0, 1) / 1000;
const MAX_SPAN_DAYS = 366 * 20;

// ---------- State ----------

const state = {
  loc: null,
  favorites: [],
  otherMode: 'end',
  endNow: true,          // "Up to now": the end follows the current hour
  end: '', qty: 1, qtyUnit: 'd',
  rangeStart: '', rangeEnd: '',
  vars: ['rain'],
  agg: 'hour',
  chartMode: 'stacked',
  units: defaultUnits(),
  model: 'best_match',
};
let raw = null;          // last fetched hourly data (raw.loadedS: start of loaded data, may precede the period)
let rawWindow = null;    // {S, E} of the selected period
let zoomWin = null;      // visible chart window {startMs, endMs} in wall ms, kept across re-renders

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s) {
      Object.assign(state, s, { units: { ...defaultUnits(), ...(s.units || {}) } });
      // Older versions had a "Last N hours" preset list: turn it into "Up to now" + duration.
      if ('preset' in s) {
        if (s.preset !== 'other') {
          const h = Number(s.preset);
          Object.assign(state, { otherMode: 'end', endNow: true, qty: h % 24 ? h : h / 24, qtyUnit: h % 24 ? 'h' : 'd' });
        } else if (!('endNow' in s)) state.endNow = false;
        delete state.preset;
      }
    }
  } catch { /* storage unavailable */ }
  state.vars = state.vars.filter((k) => VAR_BY_KEY[k]);
  if (!['hour', 'day'].includes(state.agg)) state.agg = 'hour'; // the old "whole period" mode is now in chart titles
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

const tz = () => state.loc?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
const nowHour = () => floorLocalHour(Date.now() / 1000, tz());

// ---------- Tabs (settings panels shown as an overlay under the header) ----------

const tabs = [...document.querySelectorAll('.tab')];
function openPanel(id) {
  document.documentElement.style.setProperty('--header-h', `${Math.round($('topbar').getBoundingClientRect().bottom)}px`);
  for (const t of tabs) {
    const on = t.dataset.panel === id;
    t.setAttribute('aria-expanded', on);
    $(t.dataset.panel).hidden = !on;
  }
  $('panel-backdrop').hidden = !id;
}
tabs.forEach((t) => {
  t.onclick = () => openPanel(t.getAttribute('aria-expanded') === 'true' ? null : t.dataset.panel);
});
$('panel-backdrop').onclick = () => openPanel(null);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('panel-backdrop').hidden && !$('map-dialog').open) openPanel(null); });

function updateTabs() {
  $('tab-location').textContent = state.loc ? state.loc.name : 'Choose…';
  const w = computeWindow();
  let p;
  const dur = `${state.qty} ${DURATION_UNITS[state.qtyUnit] || state.qtyUnit}`;
  if (state.otherMode === 'end' && state.endNow) p = `Last ${dur}`;
  else if (w.error) p = 'Incomplete';
  else {
    const z = tz();
    const sameYear = new Date(wallMs(w.S, z)).getUTCFullYear() === new Date(wallMs(w.E, z)).getUTCFullYear();
    p = state.otherMode === 'end'
      ? `${dur} → ${fmtWall(wallMs(w.E, z), false).slice(4)}`
      : `${fmtWall(wallMs(w.S, z), false, !sameYear).slice(4)} → ${fmtWall(wallMs(w.E, z), false).slice(4)}`;
  }
  $('tab-period').textContent = p;
  const first = state.vars[0] ? VAR_BY_KEY[state.vars[0]].label : 'None';
  const aggTxt = { day: 'daily', hour: 'hourly' }[state.agg];
  $('tab-data').textContent = `${first}${state.vars.length > 1 ? ` +${state.vars.length - 1}` : ''} · ${aggTxt}`;
}

// ---------- Location ----------

function setLocation(loc) {
  state.loc = loc;
  save();
  renderLocation();
  renderPeriodSummary();
  openPanel(null);
  scheduleFetch(0);
}

function renderLocation() {
  const box = $('loc-info');
  const loc = state.loc;
  $('btn-fav').disabled = !loc;
  if (!loc) { box.textContent = 'No location selected.'; renderFavorites(); return; }
  const fav = isFavorite(loc);
  $('btn-fav').textContent = fav ? '★ Saved' : '☆ Save';
  box.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = loc.name;
  box.append(strong);
  if (loc.region) box.append(`, ${loc.region}`);
  const sub = document.createElement('div');
  sub.className = 'small';
  const coords = `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn mini';
  copy.textContent = 'Copy';
  copy.title = 'Copy coordinates';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(coords); copy.textContent = '✓ Copied'; }
    catch { copy.textContent = 'Failed'; }
    setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
  };
  sub.append(`${loc.lat.toFixed(3)}°, ${loc.lon.toFixed(3)}°`, copy,
    (loc.elevation != null ? ` · ${Math.round(loc.elevation)} m` : '') + ` · ${loc.tz}`);
  box.append(sub);
  renderFavorites();
}

const sameLoc = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-3 && Math.abs(a.lon - b.lon) < 1e-3;
const isFavorite = (loc) => state.favorites.some((f) => sameLoc(f, loc));

function renderFavorites() {
  const box = $('favorites');
  box.innerHTML = '';
  for (const f of state.favorites) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (sameLoc(f, state.loc) ? ' active' : '');
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = `★ ${f.name}`;
    go.title = [f.name, f.region].filter(Boolean).join(', ');
    go.onclick = () => setLocation(f);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Remove ${f.name} from favorites`);
    del.onclick = () => { state.favorites = state.favorites.filter((x) => x !== f); save(); renderLocation(); };
    chip.append(go, del);
    box.append(chip);
  }
}

$('btn-fav').onclick = () => {
  if (!state.loc) return;
  if (isFavorite(state.loc)) state.favorites = state.favorites.filter((f) => !sameLoc(f, state.loc));
  else state.favorites.push({ ...state.loc });
  save();
  renderLocation();
};

// Search
let searchTimer, searchAbort;
const results = $('search-results');
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { results.hidden = true; return; }
  searchTimer = setTimeout(() => runSearch(q), 300);
});
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); results.querySelector('button')?.click(); }
  if (e.key === 'Escape') results.hidden = true;
  if (e.key === 'ArrowDown') { e.preventDefault(); results.querySelector('button')?.focus(); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) results.hidden = true; });

async function runSearch(q) {
  searchAbort?.abort();
  searchAbort = new AbortController();
  try {
    const list = await searchPlaces(q, searchAbort.signal);
    results.innerHTML = '';
    if (!list.length) results.innerHTML = '<li class="muted small" style="padding:8px">No place found.</li>';
    for (const p of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<span></span><span class="sub"></span>';
      b.firstChild.textContent = p.name;
      b.lastChild.textContent = [p.region, p.elevation != null ? `${Math.round(p.elevation)} m` : ''].filter(Boolean).join(' · ');
      b.onclick = () => { results.hidden = true; $('search').value = ''; setLocation(p); };
      b.onkeydown = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); li.nextElementSibling?.querySelector('button')?.focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); (li.previousElementSibling?.querySelector('button') || $('search')).focus(); }
      };
      li.append(b);
      results.append(li);
    }
    results.hidden = false;
  } catch (e) {
    if (e.name !== 'AbortError') { results.innerHTML = `<li class="small" style="padding:8px">Search failed: ${e.message}</li>`; results.hidden = false; }
  }
}

// GPS
$('btn-gps').onclick = () => {
  if (!navigator.geolocation) return setStatus('Geolocation is not available on this device.', 'error');
  setStatus('Getting your position…', 'loading');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try { setLocation(await resolvePoint(pos.coords.latitude, pos.coords.longitude)); }
      catch (e) { setStatus(`Could not resolve your position: ${e.message}`, 'error'); }
    },
    (err) => setStatus(`Position unavailable: ${err.message}`, 'error'),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
  );
};

// Map picker
let map, marker, picked;
const dlg = $('map-dialog');
$('btn-map').onclick = () => {
  if (typeof L === 'undefined') return setStatus('Map library could not be loaded (offline?).', 'error');
  dlg.showModal();
  if (!map) {
    map = L.map('map', { worldCopyJump: true });
    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, subdomains: 'abc',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · style © <a href="https://opentopomap.org/">OpenTopoMap</a> (CC BY-SA)',
    }).addTo(map);
    let elevAbort;
    map.on('click', async (e) => {
      picked = e.latlng.wrap();
      if (marker) marker.setLatLng(e.latlng); else marker = L.marker(e.latlng).addTo(map);
      const txt = `${picked.lat.toFixed(4)}°, ${picked.lng.toFixed(4)}°`;
      $('map-picked').textContent = `${txt} · … m`;
      $('map-use').disabled = false;
      elevAbort?.abort();
      elevAbort = new AbortController();
      const at = picked;
      try {
        const elev = await getElevation(at.lat, at.lng, elevAbort.signal);
        if (picked === at) $('map-picked').textContent = `${txt}${elev != null ? ` · ${Math.round(elev)} m` : ''}`;
      } catch (err) {
        if (err.name !== 'AbortError' && picked === at) $('map-picked').textContent = txt;
      }
    });
  }
  const c = state.loc ? [state.loc.lat, state.loc.lon] : [46.6, 2.5];
  map.setView(c, state.loc ? 9 : 5);
  setTimeout(() => map.invalidateSize(), 50);
};
$('map-close').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
$('map-use').onclick = async () => {
  if (!picked) return;
  $('map-use').disabled = true;
  $('map-picked').textContent = 'Looking up the place…';
  try {
    const loc = await resolvePoint(picked.lat, picked.lng);
    dlg.close();
    setLocation(loc);
  } catch (e) {
    $('map-picked').textContent = `Lookup failed: ${e.message}`;
  } finally { $('map-use').disabled = false; }
};

// ---------- Period ----------

function computeWindow() {
  const z = tz();
  const now = nowHour();
  let S, E, note = '';
  if (state.otherMode === 'end') {
    E = state.endNow ? now : zonedToUnix(state.end, z);
    const q = Math.floor(Number(state.qty));
    if (E == null) return { error: 'Choose an end date and time.' };
    if (!(q >= 1)) return { error: 'Duration must be at least 1.' };
    S = subtractDuration(E, q, state.qtyUnit, z);
  } else {
    S = zonedToUnix(state.rangeStart, z);
    E = zonedToUnix(state.rangeEnd, z);
    if (S == null || E == null) return { error: 'Choose both start and end.' };
  }
  if (E > now) { E = now; note = 'End moved to the current hour.'; }
  if (S >= E) return { error: 'Start must be before end.' };
  if (S < MIN_DATE) return { error: 'Data is only available from 1 January 1940.' };
  if (E - S > MAX_SPAN_DAYS * 86400) return { error: 'Please choose a period of 20 years or less.' };
  return { S, E, note };
}

function renderPeriodSummary() {
  updateTabs();
  const w = computeWindow();
  const el = $('period-summary');
  if (w.error) { el.textContent = w.error; return; }
  const z = tz();
  el.textContent = `${fmtWall(wallMs(w.S, z))} → ${fmtWall(wallMs(w.E, z))} · ${fmtDuration(Math.round((w.E - w.S) / HOUR))} · ${z}` +
    (w.note ? ` · ${w.note}` : '');
}

function syncPeriodUI() {
  document.querySelector(`input[name="other-mode"][value="${state.otherMode}"]`).checked = true;
  $('mode-end').hidden = state.otherMode !== 'end';
  $('mode-range').hidden = state.otherMode !== 'range';
  $('end-now').checked = state.endNow;
  $('end').disabled = state.endNow;
  if (state.endNow) state.end = unixToZonedInput(nowHour(), tz());
  $('end').value = state.end;
  $('qty').value = state.qty;
  $('qty-unit').value = state.qtyUnit;
  $('range-start').value = state.rangeStart;
  $('range-end').value = state.rangeEnd;
  renderPeriodSummary();
}

function prefillOther() {
  const now = nowHour();
  if (!state.end) state.end = unixToZonedInput(now, tz());
  if (!state.rangeEnd) state.rangeEnd = unixToZonedInput(now, tz());
  if (!state.rangeStart) state.rangeStart = unixToZonedInput(now - 7 * 86400, tz());
}

function onPeriodChange() { save(); syncPeriodUI(); scheduleFetch(); }

$('end-now').onchange = (e) => { state.endNow = e.target.checked; onPeriodChange(); };
// Switching between "end + duration" and "date range" keeps the same period.
function convertOtherMode(to) {
  const z = tz();
  if (to === 'range') {
    const w = computeWindow();
    if (!w.error) {
      state.rangeEnd = unixToZonedInput(w.E, z);
      state.rangeStart = unixToZonedInput(w.S, z);
    } else if (state.end) state.rangeEnd = state.end;
  } else {
    const S = zonedToUnix(state.rangeStart, z), E = zonedToUnix(state.rangeEnd, z);
    if (E != null) { state.end = state.rangeEnd; state.endNow = E >= nowHour(); }
    if (S != null && E != null && E > S) {
      const d = bestDuration(S, E, z);
      state.qty = d.qty;
      state.qtyUnit = d.unit;
    }
  }
}
document.querySelectorAll('input[name="other-mode"]').forEach((r) => {
  r.onchange = () => { convertOtherMode(r.value); state.otherMode = r.value; onPeriodChange(); };
});
$('end').onchange = (e) => { state.end = e.target.value; onPeriodChange(); };
$('qty').oninput = (e) => { state.qty = e.target.value; save(); renderPeriodSummary(); scheduleFetch(900); };
$('qty-unit').onchange = (e) => { state.qtyUnit = e.target.value; onPeriodChange(); };
$('range-start').onchange = (e) => { state.rangeStart = e.target.value; onPeriodChange(); };
$('range-end').onchange = (e) => { state.rangeEnd = e.target.value; onPeriodChange(); };

// ---------- Variables ----------

function checkbox(v) {
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = v.key;
  cb.checked = state.vars.includes(v.key);
  cb.onchange = () => {
    if (cb.checked) { if (!state.vars.includes(v.key)) state.vars.push(v.key); }
    else state.vars = state.vars.filter((k) => k !== v.key);
    save();
    renderVars(); // selected variables move to the top list, unselected ones go back to "Other"
    renderUnits();
    // Already-fetched variables only need a re-render; new ones need a fetch.
    if (raw && state.vars.every((k) => k in raw.values)) renderResults(); else scheduleFetch();
  };
  label.append(cb, document.createTextNode(v.label));
  label.dataset.search = `${v.label} ${v.key} ${v.cat}`.toLowerCase();
  return label;
}

// Top list: the quick variables plus every selected one; "Other variables": the rest.
function renderVars() {
  const top = [...QUICK_VARS, ...state.vars.filter((k) => !QUICK_VARS.includes(k))];
  const quick = $('quick-vars');
  quick.innerHTML = '';
  top.forEach((k) => quick.append(checkbox(VAR_BY_KEY[k])));
  const list = $('var-list');
  list.innerHTML = '';
  let cat = null;
  for (const v of VARS) {
    if (top.includes(v.key)) continue;
    if (v.cat !== cat) {
      cat = v.cat;
      const h = document.createElement('h3');
      h.textContent = cat;
      list.append(h);
    }
    list.append(checkbox(v));
  }
  renderVarCount();
  applyVarFilter();
}

function renderVarCount() { updateTabs(); }

$('var-filter').addEventListener('input', applyVarFilter);
function applyVarFilter() {
  const q = $('var-filter').value.trim().toLowerCase();
  const list = $('var-list');
  list.querySelectorAll('label').forEach((l) => { l.hidden = q && !l.dataset.search.includes(q); });
  list.querySelectorAll('h3').forEach((h) => {
    let el = h.nextElementSibling, any = false;
    while (el && el.tagName === 'LABEL') { if (!el.hidden) any = true; el = el.nextElementSibling; }
    h.hidden = !any;
  });
}

// Time step (hour/day): set from the Data panel or the "/h" "/d" toolbar button.
function syncStepUI() {
  document.querySelector(`input[name="agg"][value="${state.agg}"]`).checked = true;
  const b = $('btn-step');
  const day = state.agg === 'day';
  b.textContent = day ? '/d' : '/h';
  b.title = day ? 'Time step: per day (tap for per hour)' : 'Time step: per hour (tap for per day)';
  b.setAttribute('aria-label', day ? 'Time step: per day' : 'Time step: per hour');
}
function setAgg(value) {
  state.agg = value;
  save();
  syncStepUI();
  updateTabs();
  if (activeView && activeView !== 'period' && raw) applyView(activeView); else renderResults();
}
document.querySelectorAll('input[name="agg"]').forEach((r) => { r.onchange = () => setAgg(r.value); });
$('btn-step').onclick = () => setAgg(state.agg === 'day' ? 'hour' : 'day');

// ---------- Units & model ----------

function renderUnits() {
  const box = $('units');
  box.innerHTML = '';
  const fams = [...new Set(state.vars.map((k) => VAR_BY_KEY[k].family).filter(Boolean))];
  if (!fams.length) { box.innerHTML = '<p class="muted small">No adjustable units for the selected data.</p>'; return; }
  for (const f of fams) {
    const fam = FAMILIES[f];
    const label = document.createElement('label');
    label.className = 'field';
    label.innerHTML = '<span></span><select></select>';
    label.firstChild.textContent = fam.label;
    const sel = label.lastChild;
    fam.units.forEach((u) => sel.add(new Option(u, u, false, u === state.units[f])));
    sel.onchange = () => { state.units[f] = sel.value; save(); renderResults(); };
    box.append(label);
  }
}

function renderModels() {
  const sel = $('model');
  MODELS.forEach((m) => sel.add(new Option(m.label, m.id, false, m.id === state.model)));
  const note = () => { $('model-note').textContent = MODELS.find((m) => m.id === state.model)?.note || ''; };
  note();
  sel.onchange = () => { state.model = sel.value; save(); note(); scheduleFetch(0); };
}

// ---------- Fetch & results ----------

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

let fetchTimer, fetchAbort;
function scheduleFetch(delay = 400) {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(doFetch, delay);
}

async function doFetch() {
  if (!state.loc) { setStatus('Search a place, use your position or pick one on the map to start.'); return; }
  if (!state.vars.length) { setStatus('Select at least one variable.'); clearResults(); return; }
  const w = computeWindow();
  if (w.error) { setStatus(w.error, 'error'); clearResults(); return; }
  fetchAbort?.abort();
  fetchAbort = new AbortController();
  setStatus('Loading data…', 'loading');
  try {
    raw = await fetchHourly({ loc: state.loc, keys: [...state.vars], startSec: w.S, endSec: w.E, model: state.model, signal: fetchAbort.signal });
    raw.loadedS = w.S;
    raw.loadedE = w.E;
    rawWindow = w;
    zoomWin = null;
    setActiveView('period');
    setStatus('');
    renderResults();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus(`Could not load data: ${e.message}`, 'error');
    clearResults();
  }
}

// Earlier data, fetched when the chart is panned to its left end: 3× the visible span.
let loadingEarlier = false, edgeTimer;
function onChartZoom(z) {
  zoomWin = { startMs: z.startMs, endMs: z.endMs };
  setActiveView(null);
  clearTimeout(edgeTimer);
  if (z.atLeftEdge && raw) {
    edgeTimer = setTimeout(() => loadEarlierTo(raw.loadedS - 3 * (z.endMs - z.startMs) / 1000), 350);
  }
}

// Extend loaded data back to S1 (unix seconds). Returns true when new data was added.
async function loadEarlierTo(S1) {
  if (loadingEarlier || !raw || raw.loadedS <= MIN_DATE) return false;
  const target = raw;
  const S0 = target.loadedS;
  S1 = floorLocalHour(Math.max(MIN_DATE, S1), target.tz);
  if (S0 - S1 < HOUR) return false;
  loadingEarlier = true;
  setStatus('Loading earlier data…', 'loading');
  try {
    const prev = await fetchHourly({ loc: state.loc, keys: Object.keys(target.values), startSec: S1, endSec: S0, model: target.model, signal: fetchAbort?.signal });
    if (raw !== target) return false; // a new search replaced the data meanwhile
    target.times = prev.times.concat(target.times);
    for (const k of Object.keys(target.values)) target.values[k] = prev.values[k].concat(target.values[k]);
    target.filledHours += prev.filledHours;
    target.loadedS = S1;
    setStatus('');
    renderResults();
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(`Could not load earlier data: ${e.message}`, 'error');
    return false;
  } finally { loadingEarlier = false; }
}

// Extend loaded data forward to E1 (the "Up to now" view). When the gap after the loaded data
// is large, only (from, E1] is fetched and a null point breaks the curves across the gap.
let loadingLater = false;
async function loadLaterTo(E1, from) {
  if (loadingLater || !raw) return false;
  const target = raw;
  const E0 = target.loadedE;
  if (E1 - E0 < HOUR) return false;
  const start = Math.max(E0, floorLocalHour(from, target.tz));
  loadingLater = true;
  setStatus('Loading recent data…', 'loading');
  try {
    const next = await fetchHourly({ loc: state.loc, keys: Object.keys(target.values), startSec: start, endSec: E1, model: target.model, signal: fetchAbort?.signal });
    if (raw !== target) return false;
    if (start - E0 > HOUR && next.times.length) {
      target.times.push(E0 + HOUR);
      for (const k of Object.keys(target.values)) target.values[k].push(null);
    }
    target.times = target.times.concat(next.times);
    for (const k of Object.keys(target.values)) target.values[k] = target.values[k].concat(next.values[k]);
    target.filledHours += next.filledHours;
    target.loadedE = E1;
    setStatus('');
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(`Could not load recent data: ${e.message}`, 'error');
    return false;
  } finally { loadingLater = false; }
}

// View buttons: the whole period; "now": the current visible length ending now (the saved period is
// not changed); 1 d…1 m: the last N hours/days of the loaded data.
let activeView = null;
let lastX = [];
function setActiveView(v) {
  activeView = v;
  document.querySelectorAll('#view-btns button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
}

// Number of buckets a view shows: N hours = N hourly bars, or N/24 daily bars (the last day may be partial).
const viewBuckets = (view) => (state.agg === 'day' ? Math.max(1, Math.round(Number(view) / 24)) : Number(view));

function viewWindow(view, spanMs) {
  const step = state.agg === 'day' ? 86400e3 : 3600e3;
  const endMs = lastX[lastX.length - 1] + step / 2;
  if (view === 'now') return { startMs: endMs - spanMs, endMs };
  if (view === 'period') {
    // Buckets of the period: hourly stamps in (S, E], or the days containing them.
    const dayShift = state.agg === 'day' ? 86400e3 - 3600e3 : 0;
    const from = wallMs(rawWindow.S, raw.tz) - dayShift;
    const to = wallMs(rawWindow.E, raw.tz);
    const first = lastX.find((x) => x > from) ?? lastX[0];
    const last = [...lastX].reverse().find((x) => x <= to) ?? lastX[lastX.length - 1];
    return { startMs: first - step / 2, endMs: last + step / 2 };
  }
  const first = lastX[Math.max(0, lastX.length - viewBuckets(view))];
  return { startMs: first - step / 2, endMs };
}

async function applyView(view) {
  setActiveView(view);
  const stepSec = state.agg === 'day' ? 86400 : HOUR;
  let spanMs = 0;
  if (view === 'now') {
    spanMs = zoomWin ? zoomWin.endMs - zoomWin.startMs : (rawWindow.E - rawWindow.S) * 1000 + stepSec * 1000;
    const now = floorLocalHour(Date.now() / 1000, raw.tz);
    await loadLaterTo(now, now - spanMs / 1000);
  }
  const S = view === 'period' ? rawWindow.S
    : view === 'now' ? raw.loadedE - spanMs / 1000
    : raw.loadedE - viewBuckets(view) * stepSec;
  if (S < raw.loadedS) await loadEarlierTo(S);
  if (activeView !== view) return; // user moved on meanwhile
  renderResults(); // refreshes lastX for the current time step
  zoomWin = viewWindow(view, spanMs);
  renderResults();
  setActiveView(view);
}

document.querySelectorAll('#view-btns button').forEach((b) => {
  b.onclick = () => { if (raw) applyView(b.dataset.view); };
});

// Data restricted to the selected period (titles ignore earlier data loaded by panning).
function periodRaw() {
  const idx = [];
  raw.times.forEach((t, i) => { if (t > rawWindow.S && t <= rawWindow.E) idx.push(i); });
  return { ...raw, times: idx.map((i) => raw.times[i]), values: Object.fromEntries(Object.entries(raw.values).map(([k, v]) => [k, idx.map((i) => v[i])])) };
}

// Which model(s) produced the data, spelled out for "Auto".
function modelUsedText(keys, S, E) {
  if (raw.model !== 'best_match') return `Model: ${MODELS.find((m) => m.id === raw.model)?.label}.`;
  const parts = [];
  if (S < IFS_FROM) {
    const groups = { era5: [], land: [], mix: [] };
    keys.forEach((k) => groups[pre2017Source(k)].push(VAR_BY_KEY[k].label));
    const names = { era5: 'ERA5', land: 'ERA5-Land', mix: 'ERA5 + ERA5-Land' };
    const g = Object.entries(groups).filter(([, l]) => l.length);
    const txt = g.length === 1 ? names[g[0][0]] : g.map(([s, l]) => `${names[s]} (${l.join(', ')})`).join(', ');
    parts.push(E <= IFS_FROM ? txt : `${txt} until 31 Dec 2016`);
  }
  if (E > IFS_FROM) parts.push(S < IFS_FROM ? 'then ECMWF IFS 9 km' : 'ECMWF IFS 9 km');
  let t = `Currently used: ${parts.join(', ')}.`;
  if (raw.filledHours) t += ` Last ${raw.filledHours} h from Open-Meteo forecast.`;
  return t;
}

function clearResults() {
  raw = null;
  disposeCharts();
  $('charts').innerHTML = '';
  $('model-used').textContent = '';
  $('source-note').textContent = '';
  $('btn-chart-mode').hidden = true;
  $('btn-fullscreen').hidden = true;
  $('view-btns').hidden = true;
}

function fmt(v, unit) { return v == null ? '–' : v.toFixed(decimals(unit)); }

// Whole-period value per variable, shown in each chart title: {agg: 'total'|'mean'|…, value, extra}.
function buildTitles(keys) {
  const pr = periodRaw();
  const tot = aggregate(pr, keys, 'total', state.units);
  const hrs = aggregate(pr, keys, 'hour', state.units);
  const total = pr.times.length;
  const titles = {};
  for (const k of keys) {
    const v = VAR_BY_KEY[k];
    const s = tot.series[k];
    const t = {};
    if (v.kind === 'code') { t.agg = 'most severe'; t.value = wmoLabel(s.val[0]); }
    else if (v.kind === 'dir') { t.agg = 'mean'; t.value = s.val[0] == null ? '–' : `${Math.round(s.val[0])}° ${compass(s.val[0])}`; }
    else { t.agg = v.kind === 'sum' ? 'total' : 'mean'; t.value = `${fmt(s.val[0], s.unit)} ${s.unit}`; }
    const extra = [];
    if (v.kind === 'sum') {
      const h = hrs.series[k].val.filter((x) => x != null);
      const wet = h.filter((x) => x > 0).length;
      extra.push(`max ${fmt(h.length ? Math.max(...h) : null, s.unit)} ${s.unit}/h`);
      if (v.key === 'sunshine_duration') extra.push(`${wet} h with sun`);
      else if (v.family === 'precip' && v.key !== 'et0_fao_evapotranspiration' || v.family === 'snow') extra.push(`${wet} wet h`);
    } else if (v.kind === 'mean') {
      extra.push(`min ${fmt(s.min[0], s.unit)} · max ${fmt(s.max[0], s.unit)} ${s.unit}`);
    }
    const missing = total - s.n[0];
    if (missing > 0) extra.push(`${missing} of ${total} h missing`);
    t.extra = extra.join(' · ');
    titles[k] = t;
  }
  return titles;
}

function renderResults() {
  if (!raw) return;
  const keys = state.vars.filter((k) => k in raw.values);
  if (!keys.length) { clearResults(); return; }
  if (!raw.times.length) { setStatus('No data returned for this period.', 'error'); return; }
  const titles = buildTitles(keys);

  $('view-btns').hidden = false;
  $('btn-fullscreen').hidden = !document.fullscreenEnabled;
  const modeBtn = $('btn-chart-mode');
  const combined = state.chartMode === 'combined';
  modeBtn.hidden = keys.length < 2;
  modeBtn.setAttribute('aria-pressed', combined);
  modeBtn.title = combined ? 'Separate charts' : 'Combine charts';
  modeBtn.setAttribute('aria-label', modeBtn.title);
  if (typeof echarts === 'undefined') setStatus('Chart library could not be loaded (offline?).', 'error');
  else {
    const agg = aggregate(raw, keys, state.agg, state.units);
    lastX = agg.x;
    renderCharts($('charts'), agg, keys, state.agg, keys.length < 2 ? 'stacked' : state.chartMode,
      { zoom: zoomWin, onZoom: onChartZoom, titles });
  }

  const z = raw.tz;
  $('model-used').textContent = modelUsedText(keys, raw.loadedS, rawWindow.E);
  let note = `Period: ${fmtWall(wallMs(rawWindow.S, z))} → ${fmtWall(wallMs(rawWindow.E, z))} (${z}).`;
  if (raw.loadedS < rawWindow.S) note += ` Chart also shows earlier data from ${fmtWall(wallMs(raw.loadedS, z))}.`;
  if (raw.loadedE > rawWindow.E) note += ` Chart also shows later data up to ${fmtWall(wallMs(raw.loadedE, z))}.`;
  note += ' Source: Open-Meteo historical API. Values stamped hh:00 cover the preceding hour.';
  $('source-note').textContent = note;
}

$('btn-refresh').onclick = () => { syncPeriodUI(); scheduleFetch(0); };
$('btn-chart-mode').onclick = () => {
  state.chartMode = state.chartMode === 'stacked' ? 'combined' : 'stacked';
  save();
  renderResults();
};

$('btn-fullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('results').requestFullscreen().catch((e) => setStatus(`Full screen unavailable: ${e.message}`, 'error'));
};
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  $('btn-fullscreen').title = on ? 'Exit full screen' : 'Full screen';
  $('btn-fullscreen').setAttribute('aria-pressed', on);
  setTimeout(resizeCharts, 120);
});

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resizeCharts, 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderResults());

// ---------- Boot ----------

load();
prefillOther();
syncStepUI();
renderLocation();
syncPeriodUI();
renderVars();
renderUnits();
renderModels();
updateTabs();
if (!state.loc) openPanel('card-location');
scheduleFetch(0);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
}

// Show unexpected errors in the status line so they can be reported.
window.addEventListener('error', (e) => setStatus(`Error: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => setStatus(`Error: ${e.reason?.message || e.reason}`, 'error'));
