# Rain Archive

Installable web app (PWA) showing past rain totals and other weather history for any place,
using the free [Open-Meteo](https://open-meteo.com/) historical weather API.

- Location: name search, GPS position, tap on a map, saved favorites
- Period: last 6 h / 12 h / 1 / 2 / 3 days, or end date + duration, or a date range (location's local time)
- Data: rain (quick access) plus every Open-Meteo hourly historical variable
- Values: one total/mean over the whole period, per day, or per hour
- Charts: one synced chart per variable, or a combined chart; tap/hover for values, pinch/wheel to zoom, drag to pan;
  period total/mean in each chart title; quick views Period / 1 d / 3 d / 1 w; panning to the left end loads earlier data
- Units: mm/cm/in, °C/°F, km/h, m/s, mph, kn, hPa…
- Advanced: force a reanalysis model (ERA5, ERA5-Land, ECMWF IFS, CERRA)

No build step, no API key. Plain HTML/CSS/JS modules; ECharts and Leaflet from jsDelivr.

## Run locally

```
python -m http.server 8765
```

Then open http://127.0.0.1:8765/

## Notes

- An hourly value stamped hh:00 covers the preceding hour, so "last 6 h until 14:00" sums 09:00…14:00.
- In Auto mode, recent hours missing from the archive are completed with Open-Meteo forecast data.
- Weather data by Open-Meteo.com (CC BY 4.0). Place names and map © OpenStreetMap contributors.
