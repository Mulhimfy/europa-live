/** Geodesy, tiling and astronomy helpers (pure functions, unit-tested). */
import { EUROPE_BBOX } from '../config.js';

export const R_EARTH = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
export function inEurope(lat, lon) {
  return lat >= EUROPE_BBOX.minLat && lat <= EUROPE_BBOX.maxLat && lon >= EUROPE_BBOX.minLon && lon <= EUROPE_BBOX.maxLon;
}
/** Bounding box (degrees) around a point for a radius in metres. */
export function bboxAround(lat, lon, metres) {
  const dLat = deg(metres / R_EARTH);
  const dLon = deg(metres / (R_EARTH * Math.cos(rad(lat))));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}
/** Snap coordinates to a grid of ~`metres` so nearby requests share a cache key. */
export function snap(lat, lon, metres) {
  const step = deg(metres / R_EARTH);
  const latS = +(Math.round(lat / step) * step).toFixed(5);
  // Longitude step is derived from the *snapped* latitude so snapping is idempotent (stable cache keys).
  const stepLon = step / Math.max(0.2, Math.cos(rad(latS)));
  return { lat: latS, lon: +(Math.round(lon / stepLon) * stepLon).toFixed(5) };
}
export function parseBbox(str) {
  if (typeof str !== 'string') return null;
  const p = str.split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = p;
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180 || minLat >= maxLat || minLon >= maxLon) return null;
  return { minLat, minLon, maxLat, maxLon };
}
export function clampBbox(b, limits = EUROPE_BBOX) {
  return { minLat: Math.max(b.minLat, limits.minLat), maxLat: Math.min(b.maxLat, limits.maxLat), minLon: Math.max(b.minLon, limits.minLon), maxLon: Math.min(b.maxLon, limits.maxLon) };
}
export function bboxArea(b) { return (b.maxLat - b.minLat) * (b.maxLon - b.minLon); }

// ---- Web Mercator ---------------------------------------------------------
const ORIGIN = 20037508.342789244;
export function toMercator(lat, lon) {
  const x = (lon / 180) * ORIGIN;
  const y = (Math.log(Math.tan(((90 + Math.max(-85.05, Math.min(85.05, lat))) * Math.PI) / 360)) / (Math.PI / 180)) * (ORIGIN / 180);
  return { x, y };
}
/** EPSG:3857 bbox string "minx,miny,maxx,maxy" for a square of `metres` around the point. */
export function mercatorBbox(lat, lon, metres) {
  const { x, y } = toMercator(lat, lon);
  const scale = 1 / Math.cos(rad(lat)); // mercator stretches distances by 1/cos(lat)
  const h = (metres / 2) * scale;
  return { minx: x - h, miny: y - h, maxx: x + h, maxy: y + h, str: `${x - h},${y - h},${x + h},${y + h}` };
}
export function lonLatToTile(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * n);
  return { x, y, z };
}

// ---- Astronomy (NOAA solar position approximation, good to ~0.1°) --------
export function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const C = Math.sin(rad(M)) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * t) + Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eqTime = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (minutes + eqTime + 4 * lon + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const cosZ = Math.sin(rad(lat)) * Math.sin(rad(decl)) + Math.cos(rad(lat)) * Math.cos(rad(decl)) * Math.cos(rad(ha));
  const zenith = deg(Math.acos(Math.max(-1, Math.min(1, cosZ))));
  const altitude = 90 - zenith;
  let az = deg(Math.acos(Math.max(-1, Math.min(1, (Math.sin(rad(lat)) * Math.cos(rad(zenith)) - Math.sin(rad(decl))) / (Math.cos(rad(lat)) * Math.sin(rad(zenith)))))));
  az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  return { altitude, azimuth: az, declination: decl, eqTime };
}
/** Sunrise/sunset (UTC Date) for the civil day containing `date`. Returns nulls for polar day/night. */
export function sunTimes(date, lat, lon) {
  const noon = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
  const { declination, eqTime } = sunPosition(noon, lat, lon);
  const cosHa = (Math.cos(rad(90.833)) - Math.sin(rad(lat)) * Math.sin(rad(declination))) / (Math.cos(rad(lat)) * Math.cos(rad(declination)));
  if (cosHa > 1) return { sunrise: null, sunset: null, polar: 'night' };
  if (cosHa < -1) return { sunrise: null, sunset: null, polar: 'day' };
  const ha = deg(Math.acos(cosHa));
  const solarNoonMin = 720 - 4 * lon - eqTime;
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return { sunrise: new Date(day + (solarNoonMin - ha * 4) * 60000), sunset: new Date(day + (solarNoonMin + ha * 4) * 60000), solarNoon: new Date(day + solarNoonMin * 60000), polar: null };
}
export function daylight(date, lat, lon) {
  const { altitude } = sunPosition(date, lat, lon);
  const phase = altitude > 0 ? 'day' : altitude > -6 ? 'civil twilight' : altitude > -12 ? 'nautical twilight' : altitude > -18 ? 'astronomical twilight' : 'night';
  return { altitude: +altitude.toFixed(1), phase, isDay: altitude > -6 };
}
export function moonPhase(date) {
  const synodic = 29.530588853;
  const known = Date.UTC(2000, 0, 6, 18, 14); // reference new moon
  const days = (date.getTime() - known) / 86400000;
  const phase = ((days % synodic) + synodic) % synodic / synodic; // 0 new, 0.5 full
  const illum = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  const name = names[Math.round(phase * 8) % 8];
  return { phase: +phase.toFixed(3), illumination: +illum.toFixed(2), name };
}
