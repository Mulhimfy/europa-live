/**
 * Place identity: instant local answer (nearest city from the bundled GeoNames
 * index, timezone, local time, daylight, moon) enriched with an OpenStreetMap
 * reverse geocode when Nominatim answers in time.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upstream } from '../lib/http.js';
import { haversine, daylight, sunTimes, moonPhase, bearing } from '../lib/geo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cities = JSON.parse(readFileSync(join(ROOT, 'data', 'cities.json'), 'utf8'));
export const countries = JSON.parse(readFileSync(join(ROOT, 'data', 'countries.json'), 'utf8'));
export const cityRows = cities.rows; // [name, cc, lat, lon, pop, admin1, tz, geonameId]
export const citiesBuilt = cities.built;

/** Brute force is fine: 8k rows, ~0.1 ms. */
export function nearestCity(lat, lon, { minPop = 0 } = {}) {
  let best = null, bestD = Infinity;
  for (const r of cityRows) {
    if (r[4] < minPop) continue;
    const dLat = Math.abs(r[2] - lat); if (dLat > 3) continue;
    const d = haversine(lat, lon, r[2], r[3]);
    if (d < bestD) { bestD = d; best = r; }
  }
  if (!best) return null;
  return { name: best[0], cc: best[1], lat: best[2], lon: best[3], population: best[4], admin1: best[5], tz: best[6], geonameId: best[7], distanceM: Math.round(bestD), bearing: Math.round(bearing(lat, lon, best[2], best[3])) };
}

export function localContext(lat, lon, now = new Date()) {
  const city = nearestCity(lat, lon);
  const big = nearestCity(lat, lon, { minPop: 100_000 });
  const tz = city?.tz || 'Europe/Paris';
  let localTime = null;
  try { localTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short' }).format(now); } catch { /* unknown tz */ }
  const sun = sunTimes(now, lat, lon);
  const fmt = (d) => { try { return d ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d) : null; } catch { return null; } };
  const cc = city?.cc || null;
  return {
    cc, country: countries[cc]?.name || null, flag: countries[cc]?.flag || '',
    nearestCity: city, nearestBigCity: big, tz, localTime,
    daylight: daylight(now, lat, lon),
    sun: { sunrise: fmt(sun.sunrise), sunset: fmt(sun.sunset), sunriseIso: sun.sunrise?.toISOString() || null, sunsetIso: sun.sunset?.toISOString() || null, polar: sun.polar },
    moon: moonPhase(now),
  };
}

export default {
  id: 'place', label: 'Place', tier: 'now', ttlMs: 6 * 3600e3, timeoutMs: 6000,
  hosts: ['nominatim.openstreetmap.org'],
  async fetch({ lat, lon }) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1&accept-language=en`;
    // Nominatim's usage policy asks for max 1 request/second: keep concurrency at 1 and rely on the snap cache.
    const r = await upstream(url, { timeoutMs: 5000, concurrency: 1, retries: 0 });
    const a = r.address || {};
    const cc = (a.country_code || '').toUpperCase();
    const locality = a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb || a.county || '';
    const shortName = r.name || a.neighbourhood || a.quarter || a.suburb || locality || r.display_name?.split(',')[0] || '';
    return {
      name: shortName, locality, displayName: r.display_name || '', category: r.category, type: r.type,
      cc, country: a.country || countries[cc]?.name || '', flag: countries[cc]?.flag || '',
      region: a.state || a.region || a.province || '', county: a.county || '', postcode: a.postcode || '',
      isoRegion: a['ISO3166-2-lvl4'] || a['ISO3166-2-lvl6'] || '',
      osm: r.osm_type && r.osm_id ? `https://www.openstreetmap.org/${r.osm_type}/${r.osm_id}` : null,
      attribution: 'OpenStreetMap contributors (ODbL)',
    };
  },
};
