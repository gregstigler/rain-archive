// Time-zone helpers, Open-Meteo requests and aggregation.
import { VAR_BY_KEY, baseUnit, displayUnit, convert } from './vars.js';

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ELEVATION = 'https://api.open-meteo.com/v1/elevation';
const GEOCODE ='https://geocoding-api.open-meteo.com/v1/search';
const REVERSE = 'https://nominatim.openstreetmap.org/reverse';

export const HOUR = 3600;
const FORECAST_PAST_DAYS = 92;

// ---------- Time zones ----------
// All times are unix seconds. "Local" means the selected location's IANA time zone.

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return dtfCache.get(tz);
}

export function localParts(sec, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(new Date(sec * 1000))) p[type] = +value;
  return p; // {year, month, day, hour, minute, second}
}

// Offset of tz from UTC at instant sec, in seconds.
export function tzOffset(sec, tz) {
  const p = localParts(sec, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - Math.floor(sec);
}

// "YYYY-MM-DDTHH:mm" in tz -> unix seconds.
export function zonedToUnix(str, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(str || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
  let ts = guess - tzOffset(guess, tz);
  ts = guess - tzOffset(ts, tz); // second pass handles DST edges
  return ts;
}

const pad = (n) => String(n).padStart(2, '0');

export function unixToZonedInput(sec, tz) {
  const p = localParts(sec, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function localDate(sec, tz) {
  const p = localParts(sec, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Start of the current local hour (handles :30 / :45 offsets).
export function floorLocalHour(sec, tz) {
  const off = tzOffset(sec, tz);
  return Math.floor((sec + off) / HOUR) * HOUR - off;
}

// Shift a unix time so that UTC formatting shows local wall-clock time (used by charts with useUTC).
export function wallMs(sec, tz) { return (sec + tzOffset(sec, tz)) * 1000; }

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format a wall-clock ms value (from wallMs) — no tz math needed.
export function fmtWall(ms, withTime = true, withYear = true) {
  const d = new Date(ms);
  let s = `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
  if (withYear) s += ` ${d.getUTCFullYear()}`;
  if (withTime) s += ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return s;
}

export function fmtDuration(hours) {
  if (hours % 24 === 0) return `${hours / 24} day${hours === 24 ? '' : 's'}`;
  if (hours > 72) return `${(hours / 24).toFixed(1)} days`;
  return `${hours} h`;
}

// ---------- HTTP ----------

async function getJSON(url, signal) {
  const res = await fetch(url, { signal });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok || !body || body.error) throw new Error(body?.reason || `HTTP ${res.status}`);
  return body;
}

export async function searchPlaces(name, signal) {
  const url = `${GEOCODE}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
  const j = await getJSON(url, signal);
  return (j.results || []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude, lon: r.longitude, elevation: r.elevation, tz: r.timezone,
  }));
}

// Name + time zone + elevation for an arbitrary point (GPS or map tap).
export async function resolvePoint(lat, lon) {
  const tzReq = getJSON(`${FORECAST}?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=1&hourly=temperature_2m`);
  const nameReq = fetch(`${REVERSE}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12&accept-language=en`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [meta, rev] = await Promise.all([tzReq, nameReq]);
  const a = rev?.address || {};
  const name = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || rev?.name;
  return {
    name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    region: [a.state, a.country].filter(Boolean).join(', '),
    lat: +lat.toFixed(4), lon: +lon.toFixed(4),
    elevation: meta.elevation, tz: meta.timezone,
  };
}

// Terrain elevation (m) of a point, from Open-Meteo's 90 m digital elevation model.
export async function getElevation(lat, lon, signal) {
  const j = await getJSON(`${ELEVATION}?latitude=${lat}&longitude=${lon}`, signal);
  return j.elevation?.[0] ?? null;
}

// ---------- Weather data ----------

function buildUrl(base, loc, keys, startDate, endDate, model) {
  const q = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon,
    start_date: startDate, end_date: endDate,
    hourly: keys.join(','),
    timezone: loc.tz, timeformat: 'unixtime',
  });
  if (model && model !== 'best_match') q.set('models', model);
  return `${base}?${q}`;
}

/**
 * Hourly values for the window (startSec, endSec] — an hourly value stamped hh:00 covers the
 * preceding hour, so "last 6 h until 14:00" is the six stamps 09:00…14:00.
 * Returns { times: [sec], values: {key: [base-unit numbers|null]}, filledHours, model }.
 */
export async function fetchHourly({ loc, keys, startSec, endSec, model, signal }) {
  const tz = loc.tz;
  const nowSec = Date.now() / 1000;
  const startDate = localDate(startSec + HOUR, tz);
  const endDate = localDate(endSec, tz);

  const arch = await getJSON(buildUrl(ARCHIVE, loc, keys, startDate, endDate, model), signal);
  const times = [];
  const idx = [];
  arch.hourly.time.forEach((t, i) => { if (t > startSec && t <= endSec) { times.push(t); idx.push(i); } });
  const values = {};
  for (const k of keys) values[k] = idx.map((i) => arch.hourly[k]?.[i] ?? null);

  // Auto mode: fill recent gaps (reanalysis lag) from the forecast API, which keeps ~3 months of past data.
  let filledHours = 0;
  if (model === 'best_match') {
    const oldest = nowSec - (FORECAST_PAST_DAYS - 1) * 86400;
    const gaps = times.map((t, i) => (t >= oldest && keys.some((k) => values[k][i] == null) ? i : -1)).filter((i) => i >= 0);
    if (gaps.length) {
      try {
        const fc = await getJSON(buildUrl(FORECAST, loc, keys,
          localDate(times[gaps[0]], tz), localDate(times[gaps[gaps.length - 1]], tz), null), signal);
        const pos = new Map(fc.hourly.time.map((t, i) => [t, i]));
        const filled = new Set();
        for (const i of gaps) {
          const j = pos.get(times[i]);
          if (j == null) continue;
          for (const k of keys) {
            if (values[k][i] == null && fc.hourly[k]?.[j] != null) { values[k][i] = fc.hourly[k][j]; filled.add(i); }
          }
        }
        filledHours = filled.size;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // Forecast fill is best effort; gaps simply stay empty.
      }
    }
  }
  return { times, values, filledHours, model, tz };
}

// ---------- Aggregation ----------

function reduce(kind, arr) {
  const xs = arr.filter((x) => x != null);
  if (!xs.length) return { val: null, min: null, max: null, n: 0 };
  if (kind === 'sum') return { val: xs.reduce((a, b) => a + b, 0), n: xs.length };
  if (kind === 'code') return { val: Math.max(...xs), n: xs.length };
  if (kind === 'dir') {
    let sx = 0, sy = 0;
    for (const d of xs) { sx += Math.sin(d * Math.PI / 180); sy += Math.cos(d * Math.PI / 180); }
    return { val: (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360, n: xs.length };
  }
  return { val: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

/**
 * mode: 'hour' | 'day' | 'total'.
 * Returns { x: [wall ms], hours: [hours per bucket], series: {key: {unit, val[], min[], max[], cum[]|null, n[]}} }
 * Values are converted to display units.
 */
export function aggregate(raw, keys, mode, units) {
  const { times, values, tz } = raw;
  const buckets = []; // {x, idx: []}
  if (mode === 'hour') {
    times.forEach((t, i) => buckets.push({ x: wallMs(t, tz), idx: [i] }));
  } else if (mode === 'day') {
    const byDay = new Map();
    times.forEach((t, i) => {
      // An hourly stamp at 00:00 covers 23:00–24:00 of the previous day.
      const p = localParts(t - 1, tz);
      const key = Date.UTC(p.year, p.month - 1, p.day);
      if (!byDay.has(key)) { byDay.set(key, { x: key, idx: [] }); buckets.push(byDay.get(key)); }
      byDay.get(key).idx.push(i);
    });
  } else {
    buckets.push({ x: times.length ? wallMs(times[times.length - 1], tz) : 0, idx: times.map((_, i) => i) });
  }

  const series = {};
  for (const k of keys) {
    const v = VAR_BY_KEY[k];
    const from = baseUnit(v);
    const unit = displayUnit(v, units);
    const s = { unit, val: [], min: [], max: [], n: [], cum: v.kind === 'sum' ? [] : null };
    let run = 0;
    for (const b of buckets) {
      const r = reduce(v.kind, b.idx.map((i) => values[k][i]));
      s.val.push(convert(r.val, from, unit));
      s.min.push(convert(r.min ?? null, from, unit));
      s.max.push(convert(r.max ?? null, from, unit));
      s.n.push(r.n);
      if (s.cum) { if (r.val != null) run += r.val; s.cum.push(convert(run, from, unit)); }
    }
    series[k] = s;
  }
  return { x: buckets.map((b) => b.x), hours: buckets.map((b) => b.idx.length), series };
}
