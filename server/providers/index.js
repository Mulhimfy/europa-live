/** Provider registry + the aggregation engine behind /api/live. */
import { config } from '../config.js';
import { cached, peek } from '../lib/cache.js';
import { snap } from '../lib/geo.js';
import { metrics } from '../lib/metrics.js';
import { log } from '../lib/log.js';
import place, { localContext } from './place.js';
import weather from './weather.js';
import cams, { camImageHosts, camSourceStatus } from './cams/index.js';
import satellite from './satellite.js';
import radar from './radar.js';
import flights from './flights.js';
import ships from './ships.js';
import quakes from './quakes.js';
import fires from './fires.js';
import alerts from './alerts.js';
import photos from './photos.js';
import news from './news.js';

export const providers = [place, weather, cams, satellite, radar, flights, ships, quakes, fires, alerts, photos, news];
const byId = new Map(providers.map((p) => [p.id, p]));
export const getProvider = (id) => byId.get(id);
export const isEnabled = (p) => (p.enabled ? p.enabled(config) : true);

export function providerStatus() {
  return providers.map((p) => ({ id: p.id, label: p.label, tier: p.tier, enabled: isEnabled(p), ttlMs: p.ttlMs, keyHint: p.keyHint || null, hosts: p.hosts || [] }));
}
export { camSourceStatus };
export function imageHosts() { return [...new Set(camImageHosts())]; }

/** Context shared by all providers for one click. `place` is available instantly from the local index. */
export function contextFor(lat, lon, radiusKm = 25) {
  const s = snap(lat, lon, config.cache.snapMetres);
  return { lat: s.lat, lon: s.lon, rawLat: lat, rawLon: lon, radiusKm, now: new Date(), place: localContext(s.lat, s.lon) };
}

const withDeadline = (p, ms, id) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${id} exceeded ${ms}ms`)), ms).unref())]);

/** Run one provider through the cache; returns an envelope with timing and freshness metadata. */
export async function runProvider(p, ctx) {
  const key = `${p.id}:${ctx.lat},${ctx.lon}:${ctx.radiusKm}`;
  const t0 = process.hrtime.bigint();
  const before = await peek(key);
  try {
    const data = await withDeadline(cached(key, p.ttlMs, () => p.fetch(ctx), { staleMs: p.staleMs ?? p.ttlMs * 3 }), p.timeoutMs || 15000, p.id);
    const entry = await peek(key);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    metrics.observe('provider_seconds', { provider: p.id }, ms / 1000);
    metrics.inc('provider_total', { provider: p.id, result: 'ok' });
    return { id: p.id, ok: true, ms: Math.round(ms), cached: !!before && before.freshUntil > Date.now(), fetchedAt: entry ? new Date(entry.at).toISOString() : new Date().toISOString(), ttlMs: p.ttlMs, data };
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    metrics.inc('provider_total', { provider: p.id, result: 'error' });
    log.warn({ provider: p.id, err: err.message, ms: Math.round(ms) }, 'provider failed');
    return { id: p.id, ok: false, ms: Math.round(ms), error: err.message.slice(0, 200) };
  }
}

/**
 * Fan out every enabled provider and yield envelopes in completion order. The
 * `place` provider (Nominatim) enriches ctx.place for the ones that want a name,
 * but nothing waits for it beyond a short grace period.
 */
export async function* liveStream(ctx, { only } = {}) {
  const wanted = providers.filter((p) => isEnabled(p) && (!only || only.includes(p.id)));
  const queue = [];
  let notify;
  const push = (v) => { queue.push(v); notify?.(); };
  let pending = wanted.length;
  const placeP = wanted.includes(place) ? runProvider(place, ctx) : null;
  const dependsOnName = new Set(['news', 'alerts', 'quakes', 'cams']);
  for (const p of wanted) {
    (async () => {
      if (p !== place && dependsOnName.has(p.id) && placeP) {
        const r = await Promise.race([placeP, new Promise((res) => setTimeout(res, 2500).unref())]);
        if (r?.ok) ctx.place = { ...ctx.place, ...r.data };
      }
      push(await runProvider(p, ctx));
      pending--;
    })();
  }
  while (pending > 0 || queue.length) {
    if (!queue.length) await new Promise((r) => { notify = r; });
    notify = null;
    while (queue.length) yield queue.shift();
  }
}

/** All providers as one object. On `deadlineMs` the results gathered so far are returned with `timedOut: true`. */
export async function liveAll(ctx, opts = {}) {
  const results = {};
  let timedOut = false;
  const deadline = opts.deadlineMs ? new Promise((r) => setTimeout(() => { timedOut = true; r(); }, opts.deadlineMs).unref()) : null;
  const it = liveStream(ctx, opts)[Symbol.asyncIterator]();
  for (;;) {
    const step = await (deadline ? Promise.race([it.next(), deadline]) : it.next());
    if (timedOut || !step || step.done) break;
    results[step.value.id] = step.value;
  }
  return { results, timedOut };
}
