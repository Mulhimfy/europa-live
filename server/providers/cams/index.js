/**
 * Live camera aggregator. Every source returns cameras in a common shape; the
 * aggregator runs the sources relevant to the area concurrently (each with its
 * own timeout), merges, de-duplicates and ranks by distance.
 *
 * Camera shape:
 *  { id, title, lat, lon, image, thumb?, video?, embed?, page, updated?, live,
 *    source, kind: 'traffic'|'webcam'|'video'|'weather', refreshSec, distanceKm, proxy? }
 */
import { config } from '../../config.js';
import { haversine } from '../../lib/geo.js';
import { cached } from '../../lib/cache.js';
import { log } from '../../lib/log.js';
import windy from './windy.js';
import osm from './osm.js';
import youtube from './youtube.js';
import { countrySources } from './countries.js';

export const sources = [windy, osm, youtube, ...countrySources];

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms).unref())]);
const intersects = (a, b) => !(a.maxLat < b.minLat || a.minLat > b.maxLat || a.maxLon < b.minLon || a.minLon > b.maxLon);

/** Which sources apply at this point (global ones always; country ones when their bbox covers the search area). */
export function sourcesFor(bbox) {
  return sources.filter((s) => (s.enabled ? s.enabled(config) : true) && (!s.bbox || intersects(s.bbox, bbox)));
}
export function camSourceStatus() {
  return sources.map((s) => ({ id: s.id, label: s.label, kind: s.kind, enabled: s.enabled ? s.enabled(config) : true, keyHint: s.keyHint || null, countries: s.countries || null }));
}
export function camImageHosts() { return sources.flatMap((s) => s.imageHosts || []); }

/** Current upstream image URL for a camera whose frames have changing URLs (served via /cam/{source}/{id}). */
export async function resolveCamImage(sourceId, camId) {
  const src = sources.find((s) => s.id === sourceId && typeof s.resolveImage === 'function');
  if (!src || !/^[\w.-]{1,80}$/.test(camId)) return null;
  return src.resolveImage(camId);
}

/** Cameras from a country-wide list source, filtered by distance. Lists are cached for `listTtlMs`. */
export async function fromList(src, ctx) {
  const list = await cached('camlist:' + src.id, src.listTtlMs || 30 * 60e3, () => src.list(ctx), { staleMs: 6 * 3600e3 });
  const out = [];
  for (const c of list) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    if (Math.abs(c.lat - ctx.lat) > ctx.radiusKm / 90) continue;
    const d = haversine(ctx.lat, ctx.lon, c.lat, c.lon);
    if (d <= ctx.radiusKm * 1000) out.push({ ...c, distanceKm: +(d / 1000).toFixed(1) });
  }
  return out;
}

export function proxied(url) { return url ? `/img?u=${encodeURIComponent(url)}` : null; }

export async function camerasNear(ctx) {
  const { lat, lon, radiusKm } = ctx;
  const bbox = { minLat: lat - radiusKm / 111, maxLat: lat + radiusKm / 111, minLon: lon - radiusKm / 70, maxLon: lon + radiusKm / 70 };
  const active = sourcesFor(bbox);
  const t0 = Date.now();
  const results = await Promise.allSettled(active.map((s) => withTimeout(s.list ? fromList(s, ctx) : s.fetch(ctx), s.timeoutMs || 12000, s.id).then((cams) => ({ s, cams, ms: Date.now() - t0 }))));
  const bySource = {};
  const all = [];
  results.forEach((r, i) => {
    const s = active[i];
    if (r.status === 'fulfilled') { bySource[s.id] = { label: s.label, ok: true, count: r.value.cams.length, ms: r.value.ms }; all.push(...r.value.cams); }
    else { bySource[s.id] = { label: s.label, ok: false, error: String(r.reason?.message || r.reason).slice(0, 120) }; log.debug({ src: s.id, err: r.reason?.message }, 'camera source failed'); }
  });
  // Rank: live video first at equal distance; then de-duplicate near-identical cameras.
  all.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || (b.live ? 1 : 0) - (a.live ? 1 : 0));
  const kept = [];
  for (const c of all) {
    if (!c.image && !c.video && !c.page) continue;
    if (c.image && /^http:\/\//i.test(c.image)) { c.image = proxied(c.image); c.proxy = true; }
    else if (c.proxy && c.image && !c.image.startsWith('/img')) c.image = proxied(c.image);
    if (c.thumb && /^http:\/\//i.test(c.thumb)) c.thumb = proxied(c.thumb);
    const dup = kept.find((k) => k.lat != null && c.lat != null && haversine(k.lat, k.lon, c.lat, c.lon) < 25 && (k.title === c.title || k.page === c.page));
    if (dup) continue;
    kept.push(c);
    if (kept.length >= 80) break;
  }
  const name = encodeURIComponent(ctx.place?.locality || ctx.place?.name || ctx.place?.nearestCity?.name || '');
  return {
    count: kept.length, radiusKm, withImage: kept.filter((c) => c.image).length, withVideo: kept.filter((c) => c.video || c.embed).length,
    cams: kept, sources: bySource, at: new Date().toISOString(),
    // Curated jump-off points for networks that cannot be queried without a key or an account.
    more: [
      { label: 'Windy webcams map', url: `https://www.windy.com/-Webcams/webcams/${lat}/${lon}?${lat},${lon},11` },
      { label: 'SkylineWebcams', url: `https://www.skylinewebcams.com/en/webcam.html?q=${name}` },
      { label: 'YouTube live', url: `https://www.youtube.com/results?search_query=${name}+live+cam&sp=EgJAAQ%253D%253D` },
      { label: 'EarthCam', url: `https://www.earthcam.com/search/ft_search.php?term=${name}` },
    ],
  };
}

export default {
  id: 'cams', label: 'Live cameras', tier: 'cams', ttlMs: 45e3, timeoutMs: 34000,
  hosts: [...new Set(sources.flatMap((s) => s.hosts || []))],
  async fetch(ctx) { return camerasNear({ ...ctx, radiusKm: ctx.radiusKm || 25 }); },
};
