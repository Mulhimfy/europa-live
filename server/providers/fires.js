/** Active fire detections: NASA FIRMS (VIIRS/MODIS, ~3 h latency, optional key) + Copernicus EFFIS hotspot map layers + Meteosat fire radiative power (10 min). */
import { config } from '../config.js';
import { upstream } from '../lib/http.js';
import { bboxAround, haversine } from '../lib/geo.js';

function parseCsv(text) {
  const [head, ...rows] = text.trim().split('\n');
  if (!head) return [];
  const cols = head.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
}

export default {
  id: 'fires', label: 'Active fires', tier: 'earth', ttlMs: 10 * 60e3, timeoutMs: 12000,
  hosts: ['firms.modaps.eosdis.nasa.gov', 'maps.effis.emergency.copernicus.eu'],
  async fetch({ lat, lon }) {
    const radiusKm = 150;
    const b = bboxAround(lat, lon, radiusKm * 1000);
    const bbox = `${b.minLon.toFixed(2)},${b.minLat.toFixed(2)},${b.maxLon.toFixed(2)},${b.maxLat.toFixed(2)}`;
    const out = { radiusKm, detections: null, count: null, source: null, layers: {
      effis: { wms: 'https://maps.effis.emergency.copernicus.eu/effis', layer: 'viirs.hs', note: 'VIIRS hotspots, last 24 h (EFFIS)' },
      meteosat: { wms: 'https://view.eumetsat.int/geoserver/wms', layer: 'mtg_fd:frp', note: 'Fire radiative power, every 10 min (MTG)' },
    }, attribution: 'NASA FIRMS, Copernicus EFFIS, EUMETSAT' };
    if (config.keys.firms) {
      const rs = await Promise.allSettled(['VIIRS_NOAA20_NRT', 'VIIRS_SNPP_NRT'].map((s) => upstream(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${config.keys.firms}/${s}/${bbox}/1`, { as: 'text', timeoutMs: 10000 }).then(parseCsv)));
      const rows = rs.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      out.detections = rows.map((r) => ({ lat: +r.latitude, lon: +r.longitude, time: `${r.acq_date}T${String(r.acq_time).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')}:00Z`, frp: +r.frp, confidence: r.confidence, daynight: r.daynight, satellite: r.satellite, distanceKm: +(haversine(lat, lon, +r.latitude, +r.longitude) / 1000).toFixed(0) }))
        .filter((d) => d.distanceKm <= radiusKm).sort((a, c) => a.distanceKm - c.distanceKm).slice(0, 50);
      out.count = out.detections.length; out.source = 'NASA FIRMS (24 h)';
    } else {
      // Copernicus EFFIS has no keyless per-area feature query (its WMS GetFeatureInfo is pixel-based), so
      // without a free NASA FIRMS MAP_KEY the panel points at the live map layers instead of listing hotspots.
      out.note = 'Hotspot list needs a free NASA FIRMS key (NASA_FIRMS_KEY). The Fires map layer (EFFIS VIIRS 24 h + Meteosat 10-minute fire radiative power) works without it.';
      out.keyHint = 'NASA_FIRMS_KEY';
    }
    return out;
  },
};
