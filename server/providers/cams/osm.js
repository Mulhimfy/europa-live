/**
 * Webcams mapped in OpenStreetMap (surveillance=webcam / contact:webcam), which
 * frequently point at live video pages (SkylineWebcams, YouTube, municipal
 * streams). Overpass is queried through two mirrors with failover.
 */
import { upstream } from '../../lib/http.js';
import { haversine } from '../../lib/geo.js';

const MIRRORS = ['https://lz4.overpass-api.de/api/interpreter', 'https://overpass-api.de/api/interpreter'];
const IMG_RE = /\.(jpe?g|png|gif|webp)(\?|$)/i;

export default {
  id: 'osm', label: 'OpenStreetMap webcams', kind: 'webcam', countries: null,
  hosts: ['lz4.overpass-api.de', 'overpass-api.de'], imageHosts: [], timeoutMs: 30000,
  async fetch({ lat, lon, radiusKm }) {
    const r = Math.min(60_000, radiusKm * 1000);
    // Only the two tags that specifically mark internet webcams are queried: they are rare globally, so
    // Overpass answers in ~2-4 s even over dense cities. (Generic surveillance=* scans take 10 s+.)
    const q = `[out:json][timeout:25];(node(around:${r},${lat},${lon})["contact:webcam"];node(around:${r},${lat},${lon})["man_made"="surveillance"]["surveillance:type"="webcam"];);out body 80;`;
    let j, lastErr;
    for (const m of MIRRORS) {
      try { j = await upstream(m, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeoutMs: 28000, retries: 0 }); break; } catch (e) { lastErr = e; }
    }
    if (!j) throw lastErr;
    return (j.elements || []).map((e) => {
      const t = e.tags || {}; const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon;
      const url = t['contact:webcam'] || t.website || t.url || t['contact:website'] || t.image || null;
      if (!url || !/^https?:\/\//i.test(url) || !Number.isFinite(la)) return null;
      let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
      const isImage = IMG_RE.test(url);
      const yt = /(?:youtube\.com\/(?:watch\?v=|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i.exec(url);
      // Prefer a human title: OSM name > description > the last path segment of the webcam URL ("roma-colosseo" -> "Roma Colosseo").
      let slug = ''; try { slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '').replace(/\.(html?|php|jpe?g|png)$/i, '').replace(/[-_]+/g, ' ').trim(); } catch {}
      const generic = !slug || /^(index|webcam|cam|live|watch|default)$/i.test(slug) || /^[\w-]{11}$/.test(slug) && yt;
      const title = t.name || t.description || (!generic ? slug.replace(/\b\w/g, (c) => c.toUpperCase()) : '') || (t['camera:direction'] ? `Webcam facing ${t['camera:direction']}°` : `Webcam (${host})`);
      return {
        id: 'osm:' + e.type + e.id, title: title.slice(0, 80), lat: la, lon: lo,
        image: isImage && url.startsWith('https://') ? url : (yt ? `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg` : null), video: !isImage ? url : null, page: url, host,
        embed: yt ? `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1&mute=1` : null,
        live: !isImage, source: 'OpenStreetMap', kind: yt ? 'video' : 'webcam', refreshSec: isImage ? 120 : 0, direction: t['camera:direction'] ? +t['camera:direction'] : null,
        operator: t.operator || null, distanceKm: +(haversine(lat, lon, la, lo) / 1000).toFixed(1), osm: `https://www.openstreetmap.org/${e.type}/${e.id}`,
      };
    }).filter(Boolean);
  },
};
