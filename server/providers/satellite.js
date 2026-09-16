/**
 * Live satellite views of the clicked place.
 *  - Meteosat Third Generation "GeoColour" (EUMETSAT, every 10 min, day: true
 *    colour / night: city lights + blue clouds) as an animated loop
 *  - Meteosat IR 10.5 µm (every 10 min, works in darkness)
 *  - Sentinel-3 OLCI daily true colour at 300 m (Copernicus via EUMETSAT WMS)
 *  - VIIRS (NOAA-20 / Suomi-NPP) daily true colour at 375 m (NASA GIBS)
 *  - Sentinel-2 cloudless mosaic (EOX) for very high-resolution context
 * Everything is fetched by the browser straight from the agencies' WMS/WMTS;
 * the server only works out the latest available timestamps.
 */
import { upstream } from '../lib/http.js';
import { cached } from '../lib/cache.js';
import { mercatorBbox } from '../lib/geo.js';

const EUM = 'https://view.eumetsat.int/geoserver/wms';
const GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
const LAYERS = ['mtg_fd:rgb_geocolour', 'mtg_fd:ir105_hrfi', 'msg_fes:rgb_natural', 'msg_fes:ir108', 'copernicus:daily_sentinel3ab_olci_l1_rgb_fulres', 'mtg_fd:li_afa', 'mtg_fd:frp', 'msg_fes:fire'];

/** Latest timestamp per EUMETSAT layer, parsed from the (large) capabilities doc; refreshed every 5 min. */
export function eumetsatLatest() {
  return cached('eumetsat:caps', 5 * 60e3, async () => {
    const xml = await upstream(`${EUM}?service=WMS&version=1.3.0&request=GetCapabilities`, { as: 'text', timeoutMs: 20000, accept: 'text/xml' });
    const out = {};
    for (const name of LAYERS) {
      const i = xml.indexOf(`<Name>${name}</Name>`);
      if (i < 0) continue;
      const seg = xml.slice(i, i + 12000);
      const m = seg.match(/<Dimension name="time"[^>]*default="([^"]+)"[^>]*>([^<]*)<\/Dimension>/);
      if (!m) continue;
      const extent = m[2].trim();
      const parts = extent.split('/');
      out[name] = { latest: m[1], end: parts[1] || m[1], period: parts[2] || null };
    }
    return { fetchedAt: new Date().toISOString(), layers: out };
  });
}

const isoDay = (d) => d.toISOString().slice(0, 10);
/** GIBS publishes today's swaths progressively; probe today then yesterday. */
export function gibsLatest() {
  return cached('gibs:latest', 30 * 60e3, async () => {
    const today = new Date();
    const candidates = [0, 1, 2].map((n) => isoDay(new Date(today.getTime() - n * 86400e3)));
    for (const day of candidates) {
      for (const layer of ['VIIRS_NOAA20_CorrectedReflectance_TrueColor', 'VIIRS_SNPP_CorrectedReflectance_TrueColor']) {
        // A central-Europe tile at zoom 7; 404/400 means the day is not published yet.
        const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${day}/GoogleMapsCompatible_Level9/7/68/47.jpg`;
        try { await upstream(url, { as: 'buffer', method: 'HEAD', timeoutMs: 6000, retries: 0 }); return { day, layer }; } catch { /* try next */ }
      }
    }
    return { day: candidates[2], layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor' };
  });
}

const stepMs = (period) => { const m = /PT(\d+)M/.exec(period || ''); return m ? +m[1] * 60e3 : 10 * 60e3; };
const getmap = (layer, bbox, time, size = 640) => `${EUM}?service=WMS&version=1.3.0&request=GetMap&layers=${encodeURIComponent(layer)}&styles=&crs=EPSG:3857&bbox=${bbox}&width=${size}&height=${size}&format=image/png&time=${encodeURIComponent(time)}`;

export default {
  id: 'satellite', label: 'Satellite', tier: 'sky', ttlMs: 2 * 60e3, timeoutMs: 22000,
  hosts: ['view.eumetsat.int', 'gibs.earthdata.nasa.gov'],
  async fetch({ lat, lon }) {
    const [eum, gibs] = await Promise.all([eumetsatLatest().catch(() => ({ layers: {} })), gibsLatest().catch(() => null)]);
    const L = eum.layers;
    const wide = mercatorBbox(lat, lon, 600_000).str; // 600 km: weather-scale
    const mid = mercatorBbox(lat, lon, 160_000).str;   // 160 km: Sentinel-3 / VIIRS
    const geo = L['mtg_fd:rgb_geocolour'];
    const frames = [];
    if (geo) {
      const end = new Date(geo.latest).getTime();
      const step = stepMs(geo.period);
      for (let i = 11; i >= 0; i--) { const t = new Date(end - i * step).toISOString().replace(/\.\d{3}Z$/, 'Z'); frames.push({ time: t, url: getmap('mtg_fd:rgb_geocolour', wide, t) }); }
    }
    const ir = L['mtg_fd:ir105_hrfi'] || L['msg_fes:ir108'];
    const irLayer = L['mtg_fd:ir105_hrfi'] ? 'mtg_fd:ir105_hrfi' : 'msg_fes:ir108';
    const s3 = L['copernicus:daily_sentinel3ab_olci_l1_rgb_fulres'];
    const s3Day = s3 ? s3.latest.slice(0, 10) : isoDay(new Date(Date.now() - 86400e3));
    return {
      geocolour: geo ? { latest: geo.latest, cadenceMin: stepMs(geo.period) / 60e3, frames, satellite: 'Meteosat-12 (MTG-I1) FCI', resolutionKm: 1 } : null,
      infrared: ir ? { latest: ir.latest, url: getmap(irLayer, wide, ir.latest), satellite: irLayer.startsWith('mtg') ? 'Meteosat-12 FCI IR10.5' : 'Meteosat-11 SEVIRI IR10.8' } : null,
      sentinel3: { day: s3Day, url: getmap('copernicus:daily_sentinel3ab_olci_l1_rgb_fulres', mid, s3Day, 768), satellite: 'Sentinel-3 A/B OLCI', resolutionM: 300 },
      viirs: gibs ? { day: gibs.day, layer: gibs.layer, url: `${GIBS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${gibs.layer}&CRS=EPSG:3857&BBOX=${mid}&WIDTH=768&HEIGHT=768&FORMAT=image/jpeg&TIME=${gibs.day}`, satellite: gibs.layer.includes('NOAA20') ? 'NOAA-20 VIIRS' : 'Suomi-NPP VIIRS', resolutionM: 375 } : null,
      sentinel2: { url: null, tiles: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg', note: 'Sentinel-2 cloudless 2023 mosaic (EOX)', resolutionM: 10 },
      lightning: L['mtg_fd:li_afa'] ? { latest: L['mtg_fd:li_afa'].latest, cadenceMin: 5 } : null,
      fires: L['mtg_fd:frp'] ? { latest: L['mtg_fd:frp'].latest, cadenceMin: 10 } : null,
      attribution: 'EUMETSAT (MTG/MSG), Copernicus Sentinel-3, NASA GIBS/Worldview, EOX Sentinel-2 cloudless',
    };
  },
};
