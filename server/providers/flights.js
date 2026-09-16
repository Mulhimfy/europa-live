/**
 * Aircraft overhead right now, from community ADS-B networks (no key needed):
 * adsb.fi (primary) and adsb.lol (fallback). OpenSky is used when credentials
 * are configured. Positions are at most a few seconds old.
 */
import { config } from '../config.js';
import { upstream } from '../lib/http.js';
import { haversine, bearing } from '../lib/geo.js';

const NM = 1852;
function normalize(list, lat, lon, source) {
  const now = Date.now();
  return list.filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lon)).map((a) => {
    const d = haversine(lat, lon, a.lat, a.lon);
    return {
      hex: a.hex, callsign: (a.flight || '').trim() || null, registration: a.r || null, type: a.t || null, description: a.desc || null,
      lat: a.lat, lon: a.lon, altFt: a.alt_baro === 'ground' ? 0 : a.alt_baro ?? a.alt_geom ?? null, onGround: a.alt_baro === 'ground',
      groundSpeedKt: a.gs ?? null, track: a.track ?? a.true_heading ?? null, verticalRateFpm: a.baro_rate ?? a.geom_rate ?? null,
      squawk: a.squawk || null, category: a.category || null, emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
      seenSec: a.seen_pos ?? a.seen ?? null, distanceKm: +(d / 1000).toFixed(1), bearing: Math.round(bearing(lat, lon, a.lat, a.lon)),
      source, at: now,
    };
  }).sort((x, y) => x.distanceKm - y.distanceKm);
}

export async function flightsNear(lat, lon, radiusKm) {
  const nm = Math.min(250, Math.max(5, Math.round((radiusKm * 1000) / NM)));
  const sources = [
    ['adsb.fi', () => upstream(`https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`, { timeoutMs: 6000, retries: 0 }).then((j) => normalize(j.aircraft || j.ac || [], lat, lon, 'adsb.fi'))],
    ['adsb.lol', () => upstream(`https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`, { timeoutMs: 6000, retries: 0 }).then((j) => normalize(j.ac || [], lat, lon, 'adsb.lol'))],
  ];
  if (config.keys.openskyUser) {
    const b = { lamin: lat - radiusKm / 111, lamax: lat + radiusKm / 111, lomin: lon - radiusKm / (111 * Math.cos((lat * Math.PI) / 180)), lomax: lon + radiusKm / (111 * Math.cos((lat * Math.PI) / 180)) };
    sources.push(['opensky', () => upstream(`https://opensky-network.org/api/states/all?lamin=${b.lamin}&lomin=${b.lomin}&lamax=${b.lamax}&lomax=${b.lomax}`, {
      timeoutMs: 8000, retries: 0, headers: { authorization: 'Basic ' + Buffer.from(`${config.keys.openskyUser}:${config.keys.openskyPass}`).toString('base64') },
    }).then((j) => normalize((j.states || []).map((s) => ({ hex: s[0], flight: s[1], lon: s[5], lat: s[6], alt_baro: s[13] ?? s[7], gs: s[9] != null ? s[9] * 1.944 : null, track: s[10], baro_rate: s[11] != null ? s[11] * 196.85 : null, squawk: s[14], seen: j.time - s[4] })), lat, lon, 'opensky'))]);
  }
  const errors = [];
  for (const [name, fn] of sources) {
    try { const list = await fn(); return { aircraft: list, source: name, errors }; } catch (e) { errors.push(`${name}: ${e.message.slice(0, 80)}`); }
  }
  throw new Error('all ADS-B sources failed: ' + errors.join('; '));
}

export default {
  id: 'flights', label: 'Aircraft overhead', tier: 'air', ttlMs: 8e3, timeoutMs: 9000,
  hosts: ['opendata.adsb.fi', 'api.adsb.lol', 'opensky-network.org'],
  async fetch({ lat, lon }) {
    const r = await flightsNear(lat, lon, 60);
    const airborne = r.aircraft.filter((a) => !a.onGround);
    return { count: r.aircraft.length, airborne: airborne.length, radiusKm: 60, aircraft: r.aircraft.slice(0, 40), source: r.source, at: new Date().toISOString(), attribution: 'ADS-B community feeders via adsb.fi / adsb.lol' };
  },
};
