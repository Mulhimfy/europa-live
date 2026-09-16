import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, bearing, inEurope, bboxAround, snap, parseBbox, mercatorBbox, sunPosition, sunTimes, daylight, moonPhase, lonLatToTile } from '../server/lib/geo.js';

test('haversine: Rome to Paris is about 1105 km', () => {
  const d = haversine(41.9028, 12.4964, 48.8566, 2.3522);
  assert.ok(Math.abs(d / 1000 - 1105) < 5, `got ${d / 1000}`);
});
test('bearing: due north / due east', () => {
  assert.ok(Math.abs(bearing(45, 10, 46, 10)) < 0.5);
  assert.ok(Math.abs(bearing(0, 10, 0, 11) - 90) < 0.5);
});
test('inEurope', () => {
  assert.equal(inEurope(41.9, 12.5), true);
  assert.equal(inEurope(40.7, -74), false);
  assert.equal(inEurope(64.1, -21.9), true); // Reykjavik
  assert.equal(inEurope(-33.9, 18.4), false);
});
test('bboxAround is symmetric in latitude and widens with latitude', () => {
  const a = bboxAround(0, 0, 10_000), b = bboxAround(60, 0, 10_000);
  assert.ok(Math.abs((a.maxLat - a.minLat) - (b.maxLat - b.minLat)) < 1e-9);
  assert.ok(b.maxLon - b.minLon > a.maxLon - a.minLon);
});
test('snap: idempotent, stays within one grid step of the input, separates distant points', () => {
  const s = snap(41.89021, 12.49221, 150);
  assert.deepEqual(snap(s.lat, s.lon, 150), s);
  assert.ok(haversine(41.89021, 12.49221, s.lat, s.lon) < 150);
  assert.notDeepEqual(s, snap(41.895, 12.49221, 150));
});
test('parseBbox validates', () => {
  assert.deepEqual(parseBbox('12,41,13,42'), { minLon: 12, minLat: 41, maxLon: 13, maxLat: 42 });
  assert.equal(parseBbox('13,41,12,42'), null);
  assert.equal(parseBbox('a,b,c,d'), null);
  assert.equal(parseBbox(undefined), null);
});
test('mercatorBbox is square in projected metres around the point', () => {
  const m = mercatorBbox(41.9, 12.5, 100_000);
  assert.ok(Math.abs((m.maxx - m.minx) - (m.maxy - m.miny)) < 1e-6);
  assert.ok(m.maxx - m.minx > 100_000); // stretched by 1/cos(lat)
});
test('lonLatToTile', () => {
  assert.deepEqual(lonLatToTile(0, 0, 1), { x: 1, y: 1, z: 1 });
  const t = lonLatToTile(41.9, 12.5, 7);
  assert.equal(t.x, 68);
  assert.equal(t.y, 47);
});
test('sun: noon in Rome in June is high, midnight is below the horizon', () => {
  const noon = sunPosition(new Date('2026-06-21T11:10:00Z'), 41.9, 12.5);
  assert.ok(noon.altitude > 70, `alt ${noon.altitude}`);
  const night = sunPosition(new Date('2026-06-21T23:00:00Z'), 41.9, 12.5);
  assert.ok(night.altitude < -20);
  assert.equal(daylight(new Date('2026-06-21T23:00:00Z'), 41.9, 12.5).isDay, false);
});
test('sunTimes: Rome on 15 Sep 2026 within minutes of 04:50Z / 17:20Z; Svalbard midsummer is polar day', () => {
  const s = sunTimes(new Date('2026-09-15T12:00:00Z'), 41.9, 12.5);
  assert.ok(Math.abs(s.sunrise.getTime() - Date.parse('2026-09-15T04:50:00Z')) < 6 * 60e3);
  assert.ok(Math.abs(s.sunset.getTime() - Date.parse('2026-09-15T17:20:00Z')) < 6 * 60e3);
  assert.equal(sunTimes(new Date('2026-06-21T12:00:00Z'), 78.2, 15.6).polar, 'day');
});
test('moonPhase is in range and names phases', () => {
  const m = moonPhase(new Date('2026-09-15T00:00:00Z'));
  assert.ok(m.phase >= 0 && m.phase < 1);
  assert.ok(m.illumination >= 0 && m.illumination <= 1);
  assert.ok(m.name.length > 3);
});
