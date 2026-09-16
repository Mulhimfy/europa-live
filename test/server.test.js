/** Integration tests against a real server instance on an ephemeral port (network-free endpoints only). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let server, base;
before(async () => {
  process.env.RATE_LIMIT_MAX = '50';
  const { handle } = await import('../server/app.js');
  server = http.createServer((req, res) => handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const get = (p, h = {}) => fetch(base + p, { headers: h });

test('health, readiness and metrics', async () => {
  assert.equal((await get('/healthz')).status, 200);
  assert.equal((await (await get('/readyz')).json()).ok, true);
  const m = await get('/metrics');
  assert.equal(m.status, 200);
  assert.match(await m.text(), /process_uptime_seconds/);
});
test('security headers on every response', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('x-request-id'));
  assert.match(r.headers.get('content-type'), /text\/html/);
});
test('static assets: etag + 304, brotli/gzip negotiation, immutable vendor caching, no traversal', async () => {
  const r = await get('/app.js', { 'accept-encoding': 'br' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'br');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  assert.equal((await get('/app.js', { 'if-none-match': etag })).status, 304);
  const g = await get('/styles.css', { 'accept-encoding': 'gzip' });
  assert.equal(g.headers.get('content-encoding'), 'gzip');
  const v = await get('/vendor/maplibre-gl.css');
  assert.match(v.headers.get('cache-control'), /immutable/);
  assert.equal((await get('/../package.json')).status, 404);
  assert.equal((await get('/%2e%2e/package.json')).status, 404);
});
test('city index and local place context are instant and correct', async () => {
  const c = await get('/data/cities.json');
  assert.equal(c.status, 200);
  const j = await c.json();
  assert.ok(j.rows.length > 8000);
  assert.ok(j.rows.some((r) => r[0] === 'Rome' && r[1] === 'IT'));
  const p = await (await get('/api/place?lat=41.8902&lon=12.4922')).json();
  assert.equal(p.cc, 'IT');
  assert.equal(p.nearestCity.name, 'Rome');
  assert.equal(p.tz, 'Europe/Rome');
  assert.ok(p.sun.sunrise);
  const hel = await (await get('/api/place?lat=60.17&lon=24.94')).json();
  assert.equal(hel.nearestCity.name, 'Helsinki');
});
test('input validation: bad or non-European coordinates are rejected', async () => {
  assert.equal((await get('/api/place?lat=abc&lon=1')).status, 400);
  assert.equal((await get('/api/place?lat=40.7&lon=-74')).status, 400);
  assert.equal((await get('/api/live.json?lat=91&lon=0')).status, 400);
  assert.equal((await get('/api/p/nope?lat=41&lon=12')).status, 404);
  assert.equal((await get('/api/unknown')).status, 404);
  const r = await fetch(base + '/api/place?lat=41&lon=12', { method: 'POST' });
  assert.equal(r.status, 405);
});
test('status lists providers and camera sources and only reports whether keys exist', async () => {
  const s = await (await get('/api/status')).json();
  assert.ok(s.providers.length >= 12);
  assert.ok(s.cameraSources.length >= 8);
  assert.equal(typeof s.keysConfigured.windy, 'boolean');
  for (const v of Object.values(s.keysConfigured)) assert.equal(typeof v, 'boolean');
});
test('image proxy refuses non-allow-listed hosts and unknown /cam ids', async () => {
  assert.equal((await get('/img?u=' + encodeURIComponent('https://example.com/a.jpg'))).status, 403);
  assert.equal((await get('/img?u=' + encodeURIComponent('http://127.0.0.1:1/x'))).status, 403);
  assert.equal((await get('/cam/nope/123')).status, 404);
  assert.equal((await get('/cam/ee-tarktee/..%2F..%2Fetc')).status, 404);
});
test('rate limit headers are present and the limiter trips', async () => {
  const r = await get('/api/place?lat=41&lon=12');
  assert.ok(+r.headers.get('x-ratelimit-limit') > 0);
  let last;
  for (let i = 0; i < 60; i++) last = await get('/api/place?lat=41&lon=12');
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});
