/**
 * HTTP request handling: routing, security headers, rate limiting, API and
 * static assets. Pure Node core: no framework, no runtime dependencies.
 */
import { gzipSync, brotliCompressSync, constants as Z } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { config, EUROPE_BBOX } from './config.js';
import { log } from './lib/log.js';
import { metrics } from './lib/metrics.js';
import { RateLimiter } from './lib/ratelimit.js';
import { loadStatic, serveStatic } from './lib/static.js';
import { openSSE } from './lib/sse.js';
import { proxyImage, setImageHosts, listImageHosts } from './lib/imageproxy.js';
import { cached, cacheStats } from './lib/cache.js';
import { upstream, upstreamHealth } from './lib/http.js';
import { inEurope, parseBbox, clampBbox, bboxArea, haversine } from './lib/geo.js';
import { providers, getProvider, isEnabled, providerStatus, camSourceStatus, imageHosts, contextFor, runProvider, liveStream, liveAll } from './providers/index.js';
import { camerasNear, resolveCamImage } from './providers/cams/index.js';
import { flightsNear } from './providers/flights.js';
import { shipsNear, aisStatus, shipsEnabled } from './providers/ships.js';
import { eumetsatLatest, gibsLatest } from './providers/satellite.js';
import { rainviewerFrames } from './providers/radar.js';
import { cityRows, countries, citiesBuilt, localContext } from './providers/place.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const staticFiles = loadStatic(join(ROOT, 'public'));
// The city index is served as a static, cacheable asset.
{ const body = readFileSync(join(ROOT, 'data', 'cities.json')); const { createHash } = await import('node:crypto'); const etag = '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"';
  staticFiles.set('/data/cities.json', { body, etag, type: 'application/json; charset=utf-8', size: body.length, immutable: false, br: brotliCompressSync(body, { params: { [Z.BROTLI_PARAM_QUALITY]: 9 } }), gz: gzipSync(body) }); }
setImageHosts(imageHosts());

const apiLimiter = new RateLimiter({ max: config.rateLimit.max, windowMs: config.rateLimit.windowMs });
const imgLimiter = new RateLimiter({ max: config.rateLimit.imgMax, windowMs: config.rateLimit.windowMs });
const startedAt = Date.now();

const TILE_HOSTS = ['https://tiles.openfreemap.org', 'https://view.eumetsat.int', 'https://tilecache.rainviewer.com', 'https://gibs.earthdata.nasa.gov', 'https://tiles.maps.eox.at', 'https://server.arcgisonline.com', 'https://maps.effis.emergency.copernicus.eu', 'https://basemaps.cartocdn.com', 'https://*.basemaps.cartocdn.com'];
const CSP = [
  "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
  "script-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self'", "worker-src 'self' blob:", "child-src blob:",
  "img-src 'self' data: blob: https:", "media-src 'self' blob: https:",
  `connect-src 'self' ${TILE_HOSTS.join(' ')}`,
  "frame-src https://webcams.windy.com https://www.youtube-nocookie.com https://www.youtube.com https://embed.windy.com",
].join('; ');
// upgrade-insecure-requests would rewrite the page's own http://host:port/app.js to https and break
// plain-http deployments (http://IP:port, LAN, SSH tunnels), so it is only sent over https.
const CSP_HTTPS = CSP + '; upgrade-insecure-requests';
const isHttps = (req) => !!req.socket.encrypted || (config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https');

function securityHeaders(req, res) {
  const https = isHttps(req);
  res.setHeader('content-security-policy', https ? CSP_HTTPS : CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('x-dns-prefetch-control', 'off');
  if (https) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

function clientIp(req) {
  if (config.trustProxy) { const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim(); }
  return req.socket.remoteAddress || '0.0.0.0';
}

function sendJson(req, res, status, obj, { cache = 'no-store' } = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, vary: 'accept-encoding' };
  let out = body;
  const ae = String(req.headers['accept-encoding'] || '');
  if (body.length > 1024) {
    if (/\bbr\b/.test(ae)) { out = brotliCompressSync(body, { params: { [Z.BROTLI_PARAM_QUALITY]: 4 } }); headers['content-encoding'] = 'br'; }
    else if (/\bgzip\b/.test(ae)) { out = gzipSync(body, { level: 5 }); headers['content-encoding'] = 'gzip'; }
  }
  headers['content-length'] = out.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : out);
}
const bad = (req, res, msg, status = 400) => sendJson(req, res, status, { error: msg, requestId: res.requestId });

function parsePoint(sp) {
  const lat = Number(sp.get('lat')), lon = Number(sp.get('lon') ?? sp.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: 'lat and lon must be valid numbers' };
  if (!inEurope(lat, lon)) return { error: 'Europa Live covers Europe only (lat 27.5–82, lon −32–60)' };
  const r = Number(sp.get('r') || sp.get('radius') || 25);
  const radiusKm = Number.isFinite(r) ? Math.min(100, Math.max(1, r)) : 25;
  return { lat: +lat.toFixed(5), lon: +lon.toFixed(5), radiusKm };
}
function parseOnly(sp) { const v = sp.get('only'); if (!v) return null; return v.split(',').map((s) => s.trim()).filter((s) => getProvider(s)); }

// ---------------------------------------------------------------- handlers
const routes = {
  async '/api/live'(req, res, sp) {
    const p = parsePoint(sp); if (p.error) return bad(req, res, p.error);
    const ctx = contextFor(p.lat, p.lon, p.radiusKm);
    const sse = openSSE(req, res);
    sse.send('meta', { requestId: res.requestId, point: { lat: ctx.lat, lon: ctx.lon, radiusKm: ctx.radiusKm }, place: ctx.place, providers: providers.filter(isEnabled).map((x) => x.id), at: ctx.now.toISOString() });
    const deadline = setTimeout(() => { sse.send('done', { timedOut: true }); sse.close(); }, config.liveDeadlineMs).unref();
    try {
      for await (const r of liveStream(ctx, { only: parseOnly(sp) })) { if (sse.closed) break; sse.send(r.id, r); }
      if (!sse.closed) sse.send('done', { ms: Date.now() - ctx.now.getTime() });
    } finally { clearTimeout(deadline); sse.close(); }
  },
  async '/api/live.json'(req, res, sp) {
    const p = parsePoint(sp); if (p.error) return bad(req, res, p.error);
    const ctx = contextFor(p.lat, p.lon, p.radiusKm);
    const { results, timedOut } = await liveAll(ctx, { only: parseOnly(sp), deadlineMs: config.liveDeadlineMs });
    sendJson(req, res, 200, { point: { lat: ctx.lat, lon: ctx.lon, radiusKm: ctx.radiusKm }, place: ctx.place, at: ctx.now.toISOString(), timedOut, results }, { cache: 'private, max-age=5' });
  },
  async '/api/search'(req, res, sp) {
    const q = String(sp.get('q') || '').trim().slice(0, 120);
    if (q.length < 2) return sendJson(req, res, 200, { results: [] });
    const ql = q.toLowerCase();
    // Local city index first (instant), then Photon (OSM) for streets, landmarks and everything else.
    const local = [];
    for (const r of cityRows) { if (r[0].toLowerCase().startsWith(ql)) { local.push({ name: r[0], cc: r[1], country: countries[r[1]]?.name, flag: countries[r[1]]?.flag, lat: r[2], lon: r[3], population: r[4], type: 'city', source: 'index' }); if (local.length >= 6) break; } }
    let remote = [];
    try {
      const j = await cached('search:' + ql, 3600e3, () => upstream(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en&bbox=${EUROPE_BBOX.minLon},${EUROPE_BBOX.minLat},${EUROPE_BBOX.maxLon},${EUROPE_BBOX.maxLat}`, { timeoutMs: 5000, retries: 0 }));
      remote = (j.features || []).map((f) => { const p = f.properties; const [lon, lat] = f.geometry.coordinates; return { name: p.name || p.street || '', detail: [p.street && p.name !== p.street ? p.street : null, p.city, p.state, p.country].filter(Boolean).join(', '), cc: p.countrycode, flag: countries[p.countrycode]?.flag || '', lat, lon, type: p.osm_value || p.type, source: 'photon', extent: p.extent }; }).filter((x) => x.name && inEurope(x.lat, x.lon));
    } catch (e) { log.debug({ err: e.message }, 'photon failed'); }
    const seen = new Set();
    const results = [...local, ...remote].filter((x) => { const k = `${x.name}|${x.lat.toFixed(2)}|${x.lon.toFixed(2)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
    sendJson(req, res, 200, { q, results }, { cache: 'public, max-age=300' });
  },
  async '/api/layers'(req, res) {
    const [eum, rv, gibs] = await Promise.allSettled([eumetsatLatest(), rainviewerFrames(), gibsLatest()]);
    sendJson(req, res, 200, {
      at: new Date().toISOString(),
      eumetsat: eum.status === 'fulfilled' ? eum.value.layers : null,
      radar: rv.status === 'fulfilled' ? rv.value : null,
      gibs: gibs.status === 'fulfilled' ? gibs.value : null,
    }, { cache: 'public, max-age=60' });
  },
  async '/api/cams'(req, res, sp) {
    const p = parsePoint(sp); if (p.error) return bad(req, res, p.error);
    const ctx = contextFor(p.lat, p.lon, Math.min(100, p.radiusKm));
    const data = await cached(`cams:${ctx.lat},${ctx.lon}:${ctx.radiusKm}`, 45e3, () => camerasNear(ctx));
    sendJson(req, res, 200, data, { cache: 'public, max-age=30' });
  },
  async '/api/flights'(req, res, sp) {
    const p = parsePoint(sp); if (p.error) return bad(req, res, p.error);
    const ctx = contextFor(p.lat, p.lon, Math.min(250, Number(sp.get('r')) || 120));
    const data = await cached(`flightsmap:${ctx.lat},${ctx.lon}:${ctx.radiusKm}`, 6e3, () => flightsNear(ctx.lat, ctx.lon, ctx.radiusKm));
    sendJson(req, res, 200, { at: new Date().toISOString(), radiusKm: ctx.radiusKm, ...data }, { cache: 'public, max-age=5' });
  },
  async '/api/ships'(req, res, sp) {
    const p = parsePoint(sp); if (p.error) return bad(req, res, p.error);
    if (!shipsEnabled()) return sendJson(req, res, 200, { enabled: false, vessels: [], hint: 'Set AISSTREAM_KEY to enable live vessel tracking' });
    const { ensureAis } = await import('./providers/ships.js'); ensureAis();
    sendJson(req, res, 200, { at: new Date().toISOString(), enabled: true, status: aisStatus(), vessels: shipsNear(p.lat, p.lon, Math.min(150, Number(sp.get('r')) || 60)).slice(0, 300) }, { cache: 'public, max-age=5' });
  },
  async '/api/p'(req, res, sp, rest) {
    const p = getProvider(rest); if (!p || !isEnabled(p)) return bad(req, res, 'unknown provider', 404);
    const pt = parsePoint(sp); if (pt.error) return bad(req, res, pt.error);
    const ctx = contextFor(pt.lat, pt.lon, pt.radiusKm);
    sendJson(req, res, 200, await runProvider(p, ctx), { cache: `public, max-age=${Math.max(1, Math.floor(p.ttlMs / 1000 / 2))}` });
  },
  async '/api/place'(req, res, sp) {
    const p = parsePoint(sp); if (p.error) return bad(req, res, p.error);
    sendJson(req, res, 200, localContext(p.lat, p.lon), { cache: 'public, max-age=60' });
  },
  async '/api/status'(req, res) {
    sendJson(req, res, 200, {
      name: pkg.name, version: pkg.version, node: process.version, uptimeSec: Math.round((Date.now() - startedAt) / 1000), pid: process.pid,
      providers: providerStatus(), cameraSources: camSourceStatus(), ais: aisStatus(), cache: cacheStats(), upstream: upstreamHealth(), imageProxyHosts: listImageHosts().length, citiesIndexBuilt: citiesBuilt,
      keysConfigured: Object.fromEntries(Object.entries(config.keys).map(([k, v]) => [k, !!v])),
    });
  },
};

export async function handle(req, res) {
  const t0 = process.hrtime.bigint();
  res.requestId = randomUUID().slice(0, 8);
  res.setHeader('x-request-id', res.requestId);
  securityHeaders(req, res);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return bad(req, res, 'bad url'); }
  const path = url.pathname;
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    metrics.inc('http_requests_total', { route: path.startsWith('/api/p/') ? '/api/p' : path.startsWith('/cam/') ? '/cam' : path.startsWith('/api') || path === '/img' ? path : 'static', status: res.statusCode });
    metrics.observe('http_request_seconds', { route: path.startsWith('/api') ? path.split('/').slice(0, 3).join('/') : 'static' }, ms / 1000);
    if (path.startsWith('/api') || path === '/img' || path.startsWith('/cam/') || res.statusCode >= 400) log.info({ req: { m: req.method, p: path, q: url.search.slice(0, 200), ip: clientIp(req) }, s: res.statusCode, ms: Math.round(ms), id: res.requestId });
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end(); }
  if (path.length > 2048 || url.search.length > 4096) return bad(req, res, 'request too long', 414);

  try {
    if (path === '/healthz') return sendJson(req, res, 200, { ok: true });
    if (path === '/readyz') return sendJson(req, res, 200, { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    if (path === '/metrics') { const body = metrics.render({ europa_cache_entries: cacheStats().l1Size, europa_ais_vessels: aisStatus().vessels }); res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }); return res.end(body); }

    if (path.startsWith('/cam/')) {
      const rl = imgLimiter.hit(clientIp(req));
      if (!rl.ok) { res.writeHead(429, { 'retry-after': Math.ceil(rl.resetMs / 1000) }); return res.end(); }
      const m = path.match(/^\/cam\/([\w-]+)\/([\w.-]+)$/);
      const target = m ? await resolveCamImage(m[1], m[2]) : null;
      if (!target) return bad(req, res, 'unknown camera', 404);
      const r = await proxyImage(target);
      if (r.status !== 200) return bad(req, res, r.error, r.status);
      res.writeHead(200, { 'content-type': r.type, 'content-length': r.body.length, 'cache-control': 'public, max-age=30', 'cross-origin-resource-policy': 'same-origin', ...(r.lastModified ? { 'last-modified': r.lastModified } : {}) });
      return res.end(req.method === 'HEAD' ? undefined : r.body);
    }
    if (path === '/img') {
      const rl = imgLimiter.hit(clientIp(req));
      if (!rl.ok) { res.writeHead(429, { 'retry-after': Math.ceil(rl.resetMs / 1000) }); return res.end(); }
      const r = await proxyImage(url.searchParams.get('u') || '');
      if (r.status !== 200) return bad(req, res, r.error, r.status);
      const headers = { 'content-type': r.type, 'content-length': r.body.length, 'cache-control': `public, max-age=${Math.floor(config.imgProxy.ttlMs / 1000)}`, 'cross-origin-resource-policy': 'same-origin' };
      if (r.lastModified) headers['last-modified'] = r.lastModified;
      res.writeHead(200, headers); return res.end(req.method === 'HEAD' ? undefined : r.body);
    }

    if (path.startsWith('/api/')) {
      const rl = apiLimiter.hit(clientIp(req));
      res.setHeader('x-ratelimit-limit', config.rateLimit.max); res.setHeader('x-ratelimit-remaining', rl.remaining);
      if (!rl.ok) { res.setHeader('retry-after', Math.ceil(rl.resetMs / 1000)); return bad(req, res, 'rate limit exceeded', 429); }
      const m = path.match(/^\/api\/p\/([a-z]+)$/);
      if (m) return routes['/api/p'](req, res, url.searchParams, m[1]);
      const h = routes[path];
      if (h) return h(req, res, url.searchParams);
      return bad(req, res, 'not found', 404);
    }

    if (serveStatic(staticFiles, req, res, path)) return;
    // SPA fallback for deep links like /@41.89,12.49,12z
    if (!path.includes('.') && req.headers.accept?.includes('text/html')) return serveStatic(staticFiles, req, res, '/index.html');
    return bad(req, res, 'not found', 404);
  } catch (err) {
    log.error({ err, path, id: res.requestId }, 'request failed');
    if (!res.headersSent) return bad(req, res, config.env === 'development' ? err.message : 'internal error', 500);
    try { res.end(); } catch {}
  }
}
