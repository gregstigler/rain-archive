import {
  VARS, VAR_BY_KEY, QUICK_VARS, FAMILIES, MODELS, IFS_FROM, pre2017Source, defaultUnits, decimals, wmoLabel, compass,
} from './vars.js?v=23';
import {
  HOUR, STEP_MS, STEPS, bucketBounds, searchPlaces, resolvePoint, getElevation, fetchHourly, aggregate,
  zonedToUnix, unixToZonedInput, floorLocalHour, wallMs, tzOffset, fmtWall, fmtDuration,
  DURATION_UNITS, subtractDuration, bestDuration,
} from './data.js?v=23';
import { renderCharts, disposeCharts, resizeCharts, setZoom, chartRange } from './charts.js?v=23';
import { createRangeBar } from './rangebar.js?v=23';

const $ = (id) => document.getElementById(id);

// Date + time pickers of the Period panel: a date field (required, so browsers show no "Clear"
// button) and a time list in 30-minute steps. The wrapper element behaves like one input:
// .value is "YYYY-MM-DDTHH:mm", .disabled, and a single 'change' event.
document.querySelectorAll('.dt').forEach((el) => {
  const [date, time] = el.children;
  for (let m = 0; m < 24 * 60; m += 30) {
    const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    time.add(new Option(v, v));
  }
  let last = '';
  Object.defineProperty(el, 'value', {
    get: () => (date.value ? `${date.value}T${time.value}` : last),
    set: (v) => {
      last = v || '';
      const [d, t = '00:00'] = last.split('T');
      date.value = d || '';
      const [h, mi] = t.split(':').map(Number);
      const q = Math.floor((mi || 0) / 30) * 30; // snap to :00 / :30
      time.value = `${String(h || 0).padStart(2, '0')}:${String(q).padStart(2, '0')}`;
    },
  });
  Object.defineProperty(el, 'disabled', { set: (b) => { date.disabled = b; time.disabled = b; }, get: () => date.disabled });
  for (const c of [date, time]) {
    c.addEventListener('change', (e) => {
      e.stopPropagation();
      if (!date.value) { el.value = last; return; } // an emptied date falls back to the previous one
      last = el.value;
      el.dispatchEvent(new Event('change'));
    });
  }
});
const STORE_KEY = 'rain-archive-state';
const MIN_DATE = Date.UTC(1940, 0, 1) / 1000;
const MAX_SPAN_DAYS = 366 * 20;

// ---------- State ----------

const LAUSANNE = { name: 'Lausanne', region: 'Vaud, Switzerland', lat: 46.516, lon: 6.6328, elevation: 495, tz: 'Europe/Zurich' };

const state = {
  loc: LAUSANNE,         // first launch

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
let raw = null;          // hourly data behind the chart (see "Data model" below)
let rawWindow = null;    // {S, E} of the saved period
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
  if (!STEPS.includes(state.agg)) state.agg = 'hour'; // the old "whole period" mode is now in chart titles
  if (!state.loc) state.loc = LAUSANNE;
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
  const aggTxt = { hour: 'per hour', day: 'per day', week: 'per week', month: 'per month', year: 'per year' }[state.agg];
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
const favAt = (loc) => state.favorites.find((f) => sameLoc(f, loc));
function setFavorites(list) {
  state.favorites = list;
  save();
  renderLocation();
  refreshMapFavorites();
}

// ---------- Favorites ----------
// Tap: show that place. Long press: menu (rename, move on map, edit coordinates, delete).
// Press and drag onto another favorite: reorder.

const LONG_PRESS_MS = 500;

function renderFavorites() {
  const box = $('favorites');
  box.innerHTML = '';
  state.favorites.forEach((f, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip fav' + (sameLoc(f, state.loc) ? ' active' : '');
    chip.textContent = `★ ${f.name}`;
    chip.title = 'Tap: show · Long press: options · Drag: reorder';
    chip.dataset.i = i;
    attachChipGestures(chip, f);
    box.append(chip);
  });
}

function attachChipGestures(chip, fav) {
  let g = null;
  chip.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    try { chip.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, long: false, over: null };
    g.timer = setTimeout(() => {
      if (!g || g.moved) return;
      g.long = true;
      navigator.vibrate?.(25);
      openFavMenu(chip, fav);
    }, LONG_PRESS_MS);
  });
  chip.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id || g.long) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) < 8) return;
    if (!g.moved) { g.moved = true; clearTimeout(g.timer); chip.classList.add('dragging'); }
    chip.style.transform = `translate(${dx}px, ${dy}px)`;
    chip.style.pointerEvents = 'none';
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('#favorites .chip');
    chip.style.pointerEvents = '';
    g.over = over && over !== chip ? Number(over.dataset.i) : null;
    document.querySelectorAll('#favorites .chip').forEach((c) => c.classList.toggle('drop', Number(c.dataset.i) === g.over));
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.timer);
    const { moved, long, over } = g;
    g = null;
    chip.classList.remove('dragging');
    chip.style.transform = '';
    if (long) return;
    if (moved) {
      if (over != null) {
        const list = [...state.favorites];
        list.splice(list.indexOf(fav), 1);
        list.splice(over, 0, fav);
        setFavorites(list);
      } else renderFavorites();
      return;
    }
    if (e.type === 'pointerup') setLocation(fav);
  };
  chip.addEventListener('pointerup', end);
  chip.addEventListener('pointercancel', end);
  chip.addEventListener('contextmenu', (e) => e.preventDefault());
  chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLocation(fav); } });
}

function closeFavMenu() { $('fav-menu')?.remove(); }
function openFavMenu(chip, fav) {
  closeFavMenu();
  const m = document.createElement('div');
  m.id = 'fav-menu';
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  const items = [
    ['Rename', () => editFav(fav, 'rename')],
    ['Move on map', () => openMap({ moveFav: fav })],
    ['Edit coordinates', () => editFav(fav, 'coords')],
    ['Delete', () => setFavorites(state.favorites.filter((x) => x !== fav))],
  ];
  for (const [label, run] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    if (label === 'Delete') b.className = 'danger';
    b.onclick = () => { closeFavMenu(); run(); };
    m.append(b);
  }
  document.body.append(m);
  const r = chip.getBoundingClientRect();
  m.style.left = `${Math.min(Math.max(8, r.left), innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', function away(e) {
    if (!e.target.closest('#fav-menu')) { closeFavMenu(); document.removeEventListener('pointerdown', away); }
  }), 0);
}

// Rename or edit coordinates in a small dialog.
function editFav(fav, what) {
  const dlgF = $('fav-dialog');
  $('fav-title').textContent = what === 'rename' ? 'Rename favorite' : `Coordinates of ${fav.name}`;
  $('fav-name-row').hidden = what !== 'rename';
  $('fav-coords-row').hidden = what !== 'coords';
  $('fav-name').value = fav.name;
  $('fav-lat').value = fav.lat;
  $('fav-lon').value = fav.lon;
  $('fav-error').textContent = '';
  dlgF.showModal();
  $('fav-save').onclick = async () => {
    if (what === 'rename') {
      const name = $('fav-name').value.trim();
      if (!name) { $('fav-error').textContent = 'Enter a name.'; return; }
      updateFav(fav, { name });
      dlgF.close();
      return;
    }
    const lat = Number($('fav-lat').value), lon = Number($('fav-lon').value);
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || $('fav-lat').value === '' || $('fav-lon').value === '') {
      $('fav-error').textContent = 'Latitude −90…90, longitude −180…180.';
      return;
    }
    $('fav-error').textContent = 'Updating…';
    try { await moveFav(fav, lat, lon); dlgF.close(); }
    catch (e) { $('fav-error').textContent = `Failed: ${e.message}`; }
  };
}
$('fav-cancel').onclick = () => $('fav-dialog').close();

function updateFav(fav, changes) {
  const wasCurrent = sameLoc(fav, state.loc);
  const next = { ...fav, ...changes };
  state.favorites = state.favorites.map((f) => (f === fav ? next : f));
  if (wasCurrent) { state.loc = { ...next }; save(); renderLocation(); updateTabs(); scheduleFetch(0); }
  setFavorites(state.favorites);
  return next;
}

// New position for a favorite: keep its name, refresh elevation and time zone.
async function moveFav(fav, lat, lon) {
  const p = await resolvePoint(lat, lon);
  return updateFav(fav, { lat: p.lat, lon: p.lon, elevation: p.elevation, tz: p.tz });
}

$('btn-fav').onclick = () => {
  if (!state.loc) return;
  if (isFavorite(state.loc)) setFavorites(state.favorites.filter((f) => !sameLoc(f, state.loc)));
  else setFavorites([...state.favorites, { ...state.loc }]);
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

// ---------- Map ----------
// Favorites are yellow pins; tapping one selects it. The star next to "Use this point" shows
// whether the selected point is a favorite and toggles it. In "move favorite" mode the button
// saves the new position instead.

let map, marker, favLayer, picked = null, mapMode = null;
const dlg = $('map-dialog');

function refreshMapFavorites() {
  if (!favLayer) return;
  favLayer.clearLayers();
  for (const f of state.favorites) {
    L.circleMarker([f.lat, f.lon], { radius: 8, color: '#8a6d00', weight: 2, fillColor: '#ffd21f', fillOpacity: 0.95 })
      .bindTooltip(f.name, { direction: 'top', offset: [0, -8] })
      .on('click', (e) => { L.DomEvent.stopPropagation(e); pickPoint(f.lat, f.lon); })
      .addTo(favLayer);
  }
  updateStar();
}

function updateStar() {
  const star = $('map-star');
  const fav = picked && favAt(picked);
  star.disabled = !picked || !!mapMode;
  star.textContent = fav ? '★' : '☆';
  star.classList.toggle('on', !!fav);
  star.title = fav ? `Remove ${fav.name} from favorites` : 'Add this point to favorites';
}

let elevAbort;
async function pickPoint(lat, lon) {
  picked = { lat, lon };
  if (marker) marker.setLatLng([lat, lon]); else marker = L.marker([lat, lon]).addTo(map);
  const fav = favAt(picked);
  const txt = `${fav ? `${fav.name} · ` : ''}${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  $('map-picked').textContent = `${txt} · … m`;
  $('map-use').disabled = false;
  updateStar();
  elevAbort?.abort();
  elevAbort = new AbortController();
  const at = picked;
  try {
    const elev = await getElevation(lat, lon, elevAbort.signal);
    if (picked === at) $('map-picked').textContent = `${txt}${elev != null ? ` · ${Math.round(elev)} m` : ''}`;
  } catch (err) {
    if (err.name !== 'AbortError' && picked === at) $('map-picked').textContent = txt;
  }
}

function openMap(opts = {}) {
  if (typeof L === 'undefined') return setStatus('Map library could not be loaded (offline?).', 'error');
  mapMode = opts.moveFav ? { moveFav: opts.moveFav } : null;
  $('map-title').textContent = mapMode ? `Tap the new position of ${mapMode.moveFav.name}` : 'Tap the map to pick a point';
  $('map-use').textContent = mapMode ? 'Save position' : 'Use this point';
  dlg.showModal();
  if (!map) {
    map = L.map('map', { worldCopyJump: true });
    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, subdomains: 'abc',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · style © <a href="https://opentopomap.org/">OpenTopoMap</a> (CC BY-SA)',
    }).addTo(map);
    favLayer = L.layerGroup().addTo(map);
    map.on('click', (e) => { const p = e.latlng.wrap(); pickPoint(p.lat, p.lng); });
  }
  refreshMapFavorites();
  const center = mapMode ? mapMode.moveFav : state.loc;
  const c = center ? [center.lat, center.lon] : [46.52, 6.63];
  map.setView(c, center ? 10 : 6);
  picked = null;
  if (marker) { marker.remove(); marker = null; }
  $('map-picked').textContent = 'No point selected.';
  $('map-use').disabled = true;
  updateStar();
  setTimeout(() => map.invalidateSize(), 50);
}
$('btn-map').onclick = () => openMap();
$('map-close').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

$('map-star').onclick = async () => {
  if (!picked) return;
  const fav = favAt(picked);
  if (fav) { setFavorites(state.favorites.filter((f) => f !== fav)); pickPoint(picked.lat, picked.lon); return; }
  $('map-star').disabled = true;
  try {
    const p = await resolvePoint(picked.lat, picked.lon);
    setFavorites([...state.favorites, p]);
    pickPoint(p.lat, p.lon);
  } catch (e) {
    $('map-picked').textContent = `Lookup failed: ${e.message}`;
    updateStar();
  }
};

$('map-use').onclick = async () => {
  if (!picked) return;
  $('map-use').disabled = true;
  try {
    if (mapMode) {
      $('map-picked').textContent = 'Saving…';
      await moveFav(mapMode.moveFav, picked.lat, picked.lon);
      dlg.close();
      return;
    }
    const fav = favAt(picked);
    if (fav) { dlg.close(); setLocation(fav); return; }
    $('map-picked').textContent = 'Looking up the place…';
    const loc = await resolvePoint(picked.lat, picked.lon);
    dlg.close();
    setLocation(loc);
  } catch (e) {
    $('map-picked').textContent = `Failed: ${e.message}`;
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

// ---------- Aggregation (one bar per hour → day → week → month → year) ----------
// Changing it only regroups the data; the displayed time window does not move.

const STEP_LABEL = { hour: '/h', day: '/d', week: '/wk', month: '/mo', year: '/y' };
const STEP_NAME = { hour: 'per hour', day: 'per day', week: 'per week', month: 'per month', year: 'per year' };

function syncStepUI() {
  document.querySelector(`input[name="agg"][value="${state.agg}"]`).checked = true;
  const i = STEPS.indexOf(state.agg);
  $('step-label').textContent = STEP_LABEL[state.agg];
  $('step-label').title = `Data aggregated ${STEP_NAME[state.agg]}`;
  $('btn-finer').disabled = i === 0;
  $('btn-coarser').disabled = i === STEPS.length - 1;
  $('btn-finer').title = i > 0 ? `Aggregate ${STEP_NAME[STEPS[i - 1]]}` : 'Already the finest aggregation';
  $('btn-coarser').title = i < STEPS.length - 1 ? `Aggregate ${STEP_NAME[STEPS[i + 1]]}` : 'Already the coarsest aggregation';
}
function setAgg(value) {
  state.agg = value;
  save();
  syncStepUI();
  updateTabs();
  if (!raw) return;
  renderResults();
  fillAxis(); // complete the bars at both ends (a month or a year needs all of its hours)
}
document.querySelectorAll('input[name="agg"]').forEach((r) => { r.onchange = () => setAgg(r.value); });
$('btn-finer').onclick = () => { const i = STEPS.indexOf(state.agg); if (i > 0) setAgg(STEPS[i - 1]); };
$('btn-coarser').onclick = () => { const i = STEPS.indexOf(state.agg); if (i < STEPS.length - 1) setAgg(STEPS[i + 1]); };

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

// ---------- Data model ----------
// period: hourly data of the saved period; the totals in the chart titles come from it.
// raw:    hourly data behind the chart, contiguous over [raw.loadedS, raw.loadedE] (unix s).
//         It starts as the period and grows (or is replaced) as the view moves.
// axis:   the chart's time axis [axis.S, axis.E]: the visible window plus one window-width on each
//         side (never before 1940 or after the current hour). The time bar shows this range, so the
//         visible part always fills about a third of it. Data for the margins is fetched in the
//         background; when the view comes near an edge, the axis re-centres on it and the charts
//         are updated in place, without being rebuilt.

let period = null;
let axis = null;

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

const unwall = (ms) => { const s = ms / 1000; return s - tzOffset(s, raw.tz); }; // wall ms → unix s
function axisAround(S, E) {
  const span = E - S;
  return { S: Math.max(MIN_DATE, floorLocalHour(S - span, tz())), E: Math.min(nowHour(), E + span) };
}
// Data needed to draw [S, E] with whole bars: widened to the bars that contain both ends.
function wholeBars({ S, E }) {
  const z = raw?.tz || tz();
  const a = bucketBounds(wallMs(S, z), state.agg)[0], b = bucketBounds(wallMs(E - 1, z), state.agg)[1];
  return { S: a / 1000 - tzOffset(a / 1000, z), E: b / 1000 - tzOffset(b / 1000, z) };
}

async function doFetch() {
  if (!state.loc) { setStatus('Search a place, use your position or pick one on the map to start.'); return; }
  if (!state.vars.length) { setStatus('Select at least one variable.'); clearResults(); return; }
  const w = computeWindow();
  if (w.error) { setStatus(w.error, 'error'); clearResults(); return; }
  fetchAbort?.abort();
  fetchAbort = new AbortController();
  const ctrl = fetchAbort;
  setStatus('Loading data…', 'loading');
  const done = watchSlow('Loading the data', () => ctrl.abort());
  try {
    const p = await fetchHourly({ loc: state.loc, keys: [...state.vars], startSec: w.S, endSec: w.E, model: state.model, signal: ctrl.signal });
    done();
    period = p;
    raw = { ...p, loadedS: w.S, loadedE: w.E };
    rawWindow = w;
    axis = axisAround(w.S, w.E);
    zoomWin = null;
    setStatus('');
    renderResults();
    zoomWin = viewWindow('period');
    renderResults();
    setActiveView('period');
    fillAxis(); // the margins, in the background
  } catch (e) {
    done();
    if (e.name === 'AbortError') return;
    setStatus(`Could not load data: ${e.message}`, 'error');
    clearResults();
  }
}

// Downloads run one after the other so that the pieces of `raw` stay contiguous.
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(fn, fn));

// Make `raw` cover [S, E]: extend it on either side, or replace it when the range is far away.
// Returns true when `raw` changed.
async function ensureData({ S, E }) {
  if (!raw) return false;
  const target = raw;
  S = Math.max(MIN_DATE, floorLocalHour(S, target.tz));
  E = Math.min(nowHour(), E);
  if (S >= target.loadedS && E <= target.loadedE) return false;
  const ctrl = new AbortController();
  fetchAbort?.signal.addEventListener('abort', () => ctrl.abort());
  const get = (a, b) => fetchHourly({ loc: state.loc, keys: Object.keys(target.values), startSec: a, endSec: b, model: target.model, signal: ctrl.signal });
  try {
    if (E < target.loadedS || S > target.loadedE) {
      const next = await get(S, E);
      if (raw !== target) return false;
      raw = { ...next, loadedS: S, loadedE: E };
      return true;
    }
    let { times, values } = target;
    let { loadedS, loadedE } = target;
    let filled = target.filledHours;
    if (S < loadedS) {
      const prev = await get(S, loadedS);
      times = prev.times.concat(times);
      values = Object.fromEntries(Object.keys(values).map((k) => [k, prev.values[k].concat(values[k])]));
      filled += prev.filledHours;
      loadedS = S;
    }
    if (E > loadedE) {
      const next = await get(loadedE, E);
      times = times.concat(next.times);
      values = Object.fromEntries(Object.keys(values).map((k) => [k, values[k].concat(next.values[k])]));
      filled += next.filledHours;
      loadedE = E;
    }
    if (raw !== target) return false;
    raw = { ...target, times, values, loadedS, loadedE, filledHours: filled };
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') setStatus(`Could not load more data: ${e.message}`, 'error');
    return false;
  }
}

// Keep the loaded data from growing without bound while browsing: drop what is far outside the axis.
function trimRaw() {
  const len = axis.E - axis.S;
  if (raw.loadedE - raw.loadedS <= 4 * len) return;
  const wb = wholeBars(axis); // never cut into a bar that is on screen
  const S = Math.max(raw.loadedS, Math.min(wb.S, axis.S - len)), E = Math.min(raw.loadedE, Math.max(wb.E, axis.E + len));
  const idx = [];
  raw.times.forEach((t, i) => { if (t > S && t <= E) idx.push(i); });
  raw = { ...raw, times: idx.map((i) => raw.times[i]),
    values: Object.fromEntries(Object.entries(raw.values).map(([k, v]) => [k, idx.map((i) => v[i])])), loadedS: S, loadedE: E };
}

async function fillAxis() {
  const target = raw;
  if (await queue(() => ensureData(wholeBars(axis))) && raw && raw !== target) renderResults();
}

// After a zoom or pan settles: re-centre the axis on the view when the view nears an edge that can
// still move, or when the view is no longer about a third of the axis.
let relayoutTimer;
function scheduleRelayout(delay = 350) { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(relayout, delay); }
async function relayout() {
  if (!raw || !zoomWin || !axis) return;
  if (rangeBar.isDragging()) { scheduleRelayout(); return; }
  const vS = unwall(zoomWin.startMs), vE = unwall(zoomWin.endMs);
  const span = vE - vS;
  const nearLeft = vS - axis.S < span * 0.5 && axis.S > MIN_DATE;
  const nearRight = axis.E - vE < span * 0.5 && axis.E < nowHour();
  const ratio = (axis.E - axis.S) / span;
  if (!nearLeft && !nearRight && ratio > 2 && ratio < 4.5) {
    // Same axis: only the running totals need to restart at the new left edge (in place, cheap).
    if (state.vars.some((k) => VAR_BY_KEY[k].kind === 'sum')) renderResults();
    return;
  }
  const want = axisAround(vS, vE);
  await queue(() => ensureData(wholeBars(want)));
  if (!raw) return;
  axis = want;
  trimRaw();
  renderResults();
}

function onChartZoom(z) {
  zoomWin = { startMs: z.startMs, endMs: z.endMs };
  setActiveView(null);
  rangeBar.update({ start: z.startMs, end: z.endMs });
  scheduleRelayout();
}

// ---------- "Taking long" dialog (downloads still running after 5 s) ----------

let choiceToken = 0;
function showChoice({ title, text, buttons }) {
  const token = ++choiceToken;
  $('slow-title').textContent = title;
  $('slow-text').textContent = text;
  const box = $('slow-btns');
  box.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `btn${b.primary ? ' primary' : ''}`;
    el.textContent = b.label;
    el.onclick = () => { $('slow-dialog').close(); b.run?.(); };
    box.append(el);
  }
  if (!$('slow-dialog').open) $('slow-dialog').showModal();
  return token;
}
function closeChoice(token) { if (token === choiceToken && $('slow-dialog').open) $('slow-dialog').close(); }

// Start a 5 s watchdog for a download; returns the function to call when it is over.
function watchSlow(what, cancel) {
  let token = 0;
  const t = setTimeout(() => {
    token = showChoice({
      title: 'This is taking long',
      text: `${what} is still running after 5 seconds. Long periods with several variables take longer to download.`,
      buttons: [
        { label: 'Keep waiting', primary: true },
        { label: 'Cancel', run: () => { cancel(); setStatus('Cancelled.'); } },
      ],
    });
  }, 5000);
  return () => { clearTimeout(t); if (token) closeChoice(token); };
}

// ---------- View buttons ----------
// Period: the saved period. Up to now: the current visible length, ending now (the saved period is
// not changed). 1 d…1 y: that length, ending where the chart currently ends.

let activeView = null;
let lastX = [], lastStart = [], lastEnd = []; // bars of the last render: middle, start, end (wall ms)
function setActiveView(v) {
  activeView = v;
  document.querySelectorAll('#view-btns button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
}

// Number of bars a view shows for the current time step (the last one may be partial).
function viewBuckets(view) {
  const h = Number(view);
  return { hour: h, day: Math.round(h / 24), week: Math.round(h / 168), month: Math.round(h / 730.5), year: Math.round(h / 8766) }[state.agg] || 1;
}

// Bars that cover the instants just after `from` and just before `to` (wall ms).
const firstBarAfter = (from) => { const i = lastEnd.findIndex((e) => e > from); return i < 0 ? lastEnd.length - 1 : i; };
function lastBarBefore(to) {
  for (let i = lastStart.length - 1; i >= 0; i--) if (lastStart[i] < to) return i;
  return 0;
}

// Visible window (wall ms) for a view, snapped to whole bars.
function viewWindow(view, spanSec, anchorMs) {
  let i0, i1;
  if (view === 'period') {
    i0 = firstBarAfter(wallMs(rawWindow.S, raw.tz));
    i1 = lastBarBefore(wallMs(rawWindow.E, raw.tz));
  } else if (view === 'now') {
    i1 = lastStart.length - 1;
    i0 = Math.max(0, i1 - Math.max(1, Math.round((spanSec * 1000) / STEP_MS[state.agg])) + 1);
  } else {
    i1 = lastBarBefore(anchorMs);
    i0 = Math.max(0, i1 - viewBuckets(view) + 1);
  }
  return { startMs: lastStart[i0], endMs: lastEnd[i1] };
}

async function applyView(view) {
  setActiveView(view);
  const stepSec = STEP_MS[state.agg] / 1000;
  const anchorMs = zoomWin ? zoomWin.endMs : wallMs(rawWindow.E, raw.tz);
  let S, E, spanSec = 0;
  if (view === 'period') { S = rawWindow.S; E = rawWindow.E; }
  else if (view === 'now') {
    spanSec = zoomWin ? (zoomWin.endMs - zoomWin.startMs) / 1000 : rawWindow.E - rawWindow.S;
    E = nowHour(); S = E - spanSec;
  } else {
    E = unwall(anchorMs) + stepSec;
    S = E - (viewBuckets(view) + 1) * stepSec;
  }
  const want = axisAround(S, E);
  await queue(() => ensureData(wholeBars(want)));
  if (activeView !== view || !raw) return; // the user moved on meanwhile
  axis = want;
  trimRaw();
  renderResults(); // refreshes lastX for the current time step
  zoomWin = viewWindow(view, spanSec, anchorMs);
  renderResults();
  setActiveView(view);
}

document.querySelectorAll('#view-btns button').forEach((b) => {
  b.onclick = () => { if (raw) applyView(b.dataset.view); };
});

// Which model(s) produced the data, spelled out for "Auto".
function modelUsedText(keys, S, E) {
  if (period.model !== 'best_match') return `Model: ${MODELS.find((m) => m.id === period.model)?.label}.`;
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
  if (period.filledHours) t += ` Last ${period.filledHours} h from Open-Meteo forecast.`;
  return t;
}

function clearResults() {
  raw = null;
  period = null;
  axis = null;
  disposeCharts();
  $('charts').innerHTML = '';
  $('rangebar').hidden = true;
  $('model-used').textContent = '';
  $('btn-chart-mode').hidden = true;
  $('btn-fullscreen').hidden = true;
  $('view-btns').hidden = true;
}

function fmt(v, unit) { return v == null ? '–' : v.toFixed(decimals(unit)); }

// Whole-period value per variable, shown in each chart title: {agg: 'total'|'mean'|…, value, extra}.
// Cached: it only changes with the period, the variables or the units, not when the view moves.
let titlesCache = { period: null, key: '', titles: null };
function buildTitles(keys) {
  const key = `${keys.join(',')}|${JSON.stringify(state.units)}`;
  if (titlesCache.period === period && titlesCache.key === key) return titlesCache.titles;
  const titles = computeTitles(keys);
  titlesCache = { period, key, titles };
  return titles;
}
function computeTitles(keys) {
  const tot = aggregate(period, keys, 'total', state.units);
  const hrs = aggregate(period, keys, 'hour', state.units);
  const total = period.times.length;
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
      let wet = 0, top = null; // a loop, not Math.max(...h): years of hours overflow the argument list
      for (const x of hrs.series[k].val) {
        if (x == null) continue;
        if (x > 0) wet++;
        if (top == null || x > top) top = x;
      }
      extra.push(`max ${fmt(top, s.unit)} ${s.unit}/h`);
      if (v.key === 'sunshine_duration') extra.push(`${wet} h with sun`);
      else if ((v.family === 'precip' && v.key !== 'et0_fao_evapotranspiration') || v.family === 'snow') extra.push(`${wet} wet h`);
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
  if (!raw || !period) return false;
  const keys = state.vars.filter((k) => k in raw.values);
  if (!keys.length) { clearResults(); return false; }
  if (!raw.times.length) { setStatus('No data returned for this period.', 'error'); return false; }
  const titles = buildTitles(keys);

  $('view-btns').hidden = false;
  $('btn-fullscreen').hidden = false;
  const modeBtn = $('btn-chart-mode');
  const combined = state.chartMode === 'combined';
  modeBtn.hidden = keys.length < 2;
  modeBtn.setAttribute('aria-pressed', combined);
  modeBtn.title = combined ? 'Separate charts' : 'Combine charts';
  modeBtn.setAttribute('aria-label', modeBtn.title);
  if (typeof echarts === 'undefined') { setStatus('Chart library could not be loaded (offline?).', 'error'); return false; }

  // Running totals start with the bar that contains the left edge of the view.
  const cumFrom = zoomWin ? bucketBounds(zoomWin.startMs + 1, state.agg)[0] : -Infinity;
  const agg = aggregate(raw, keys, state.agg, state.units, cumFrom);
  lastX = agg.x; lastStart = agg.start; lastEnd = agg.end;
  // The axis keeps its time range whatever the aggregation: wide bars at its ends are simply cut.
  // (Only the data behind them is loaded whole, so their values are complete.)
  const range = axis ? { min: wallMs(axis.S, raw.tz), max: wallMs(axis.E, raw.tz) } : undefined;
  renderCharts($('charts'), agg, keys, state.agg, keys.length < 2 ? 'stacked' : state.chartMode,
    { range, zoom: zoomWin, onZoom: onChartZoom, titles });
  // Time bar: the axis range, the visible window, and the first variable's profile.
  $('rangebar').hidden = false;
  lastShadow = agg.x.map((x, i) => [x, agg.series[keys[0]].val[i]]);
  rangeBar.update({ ...chartRange, start: zoomWin ? zoomWin.startMs : chartRange.min, end: zoomWin ? zoomWin.endMs : chartRange.max,
    shadow: lastShadow, unit: state.agg });

  $('model-used').textContent = modelUsedText(keys, rawWindow.S, rawWindow.E);
  return true;
}

$('btn-refresh').onclick = () => { syncPeriodUI(); scheduleFetch(0); };
$('btn-chart-mode').onclick = () => {
  state.chartMode = state.chartMode === 'stacked' ? 'combined' : 'stacked';
  save();
  renderResults();
};

// Full screen: the browser's own when it allows it, otherwise the results block is simply laid over
// the whole page (.fs). Either way the charts are resized to the new space.
function onFullscreenChange() {
  const on = !!document.fullscreenElement || $('results').classList.contains('fs');
  $('btn-fullscreen').title = on ? 'Exit full screen' : 'Full screen';
  $('btn-fullscreen').setAttribute('aria-pressed', on);
  setTimeout(() => { resizeCharts(); rangeBar.update({ redraw: true }); }, 120);
}
function setFallbackFullscreen(on) {
  $('results').classList.toggle('fs', on);
  onFullscreenChange();
}
$('btn-fullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if ($('results').classList.contains('fs')) setFallbackFullscreen(false);
  else if (document.fullscreenEnabled) $('results').requestFullscreen().catch(() => setFallbackFullscreen(true));
  else setFallbackFullscreen(true);
};
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('results').classList.contains('fs')) setFallbackFullscreen(false); });

const rangeBar = createRangeBar($('rangebar'), { onChange: setZoom, onEnd: () => scheduleRelayout(0), minSpan: 3 * 3600e3 });
let lastShadow = null;

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { resizeCharts(); rangeBar.update({ redraw: true }); }, 150);
});
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
scheduleFetch(0);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
}

// Show unexpected errors in the status line so they can be reported.
window.addEventListener('error', (e) => setStatus(`Error: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => setStatus(`Error: ${e.reason?.message || e.reason}`, 'error'));
