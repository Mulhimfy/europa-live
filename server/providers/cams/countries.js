/**
 * Country-specific open-data road/traffic camera networks (no API key).
 * Each source lists every camera of the network (`list()`, cached country-wide
 * by the aggregator) and declares a `bbox` so it is only consulted when the
 * clicked area overlaps it. Cameras whose image URL changes per frame expose
 * `resolveImage(id)` and are served through /cam/{source}/{id}.
 *
 * Verified 2026-09-15 with real HTTP 200 image responses.
 */
import { config } from '../../config.js';
import { upstream } from '../../lib/http.js';
import { cached } from '../../lib/cache.js';

const pretty = (s) => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)<`)); return m ? m[1] : ''; };

// ---------------------------------------------------------------- Finland
export const digitraffic = {
  id: 'fi-digitraffic', label: 'Fintraffic weather cams', kind: 'traffic', countries: ['FI', 'AX'],
  bbox: { minLat: 59.5, maxLat: 70.2, minLon: 19, maxLon: 31.6 }, listTtlMs: 30 * 60e3, timeoutMs: 15000,
  hosts: ['tie.digitraffic.fi'], imageHosts: ['weathercam.digitraffic.fi'],
  async list() {
    const j = await upstream('https://tie.digitraffic.fi/api/weathercam/v1/stations', { timeoutMs: 15000, headers: { 'accept-encoding': 'gzip', 'digitraffic-user': 'EuropaLive' } });
    const out = [];
    for (const f of j.features || []) {
      const p = f.properties || {}; const [lon, lat] = f.geometry?.coordinates || [];
      if (p.collectionStatus && p.collectionStatus !== 'GATHERING') continue;
      const name = pretty(p.name.replace(/^[a-z]+\d+_/i, '')) || p.id;
      const road = (p.name.match(/^([a-z]+\d+)_/i) || [])[1];
      (p.presets || []).filter((x) => x.inCollection).forEach((pr, i) => out.push({
        id: 'fi:' + pr.id, title: `${name}${road ? ` (${road.toUpperCase()})` : ''} · view ${i + 1}`, lat, lon,
        image: `https://weathercam.digitraffic.fi/${pr.id}.jpg`, page: `https://www.digitraffic.fi/en/road-traffic/`,
        live: false, source: 'Fintraffic (Digitraffic)', kind: 'traffic', refreshSec: 600,
      }));
    }
    return out;
  },
};

// ---------------------------------------------------------------- London
export const tfl = {
  id: 'gb-tfl', label: 'TfL JamCams (London)', kind: 'traffic', countries: ['GB'],
  bbox: { minLat: 51.2, maxLat: 51.75, minLon: -0.6, maxLon: 0.35 }, listTtlMs: 30 * 60e3, timeoutMs: 15000,
  hosts: ['api.tfl.gov.uk'], imageHosts: ['s3-eu-west-1.amazonaws.com'],
  async list() {
    const j = await upstream('https://api.tfl.gov.uk/Place/Type/JamCam', { timeoutMs: 15000 });
    return (j || []).map((c) => {
      const p = Object.fromEntries((c.additionalProperties || []).map((a) => [a.key, a]));
      if (p.available?.value !== 'true') return null;
      return {
        id: 'tfl:' + c.id, title: `${c.commonName}${p.view?.value ? ` · ${p.view.value}` : ''}`, lat: c.lat, lon: c.lon,
        image: p.imageUrl?.value, video: p.videoUrl?.value || null, page: 'https://www.tfljamcams.net/', updated: p.imageUrl?.modified || p.available?.modified,
        live: !!p.videoUrl?.value, source: 'Transport for London', kind: 'traffic', refreshSec: 300,
      };
    }).filter(Boolean);
  },
};

// ---------------------------------------------------------------- Iceland
export const vegagerdin = {
  id: 'is-vegagerdin', label: 'Vegagerðin road cams', kind: 'traffic', countries: ['IS'],
  bbox: { minLat: 63.2, maxLat: 66.7, minLon: -24.7, maxLon: -13.3 }, listTtlMs: 60 * 60e3, timeoutMs: 15000,
  hosts: ['gagnaveita.vegagerdin.is'], imageHosts: ['www.vegagerdin.is', 'vegagerdin.is'],
  async list() {
    const j = await upstream('https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1', { timeoutMs: 15000 });
    return (j || []).filter((c) => c.Slod && Number.isFinite(c.Breidd)).map((c) => ({
      id: 'is:' + c.Slod.split('/').pop().replace(/\.\w+$/, ''), title: `${c.Myndavel}${c.Skyring && c.Skyring !== c.Myndavel ? ` · ${c.Skyring}` : ''}`, lat: c.Breidd, lon: c.Lengd,
      image: c.Slod, page: 'https://umferdin.is/', road: c.Vegheiti, live: false, source: 'Vegagerðin (Icelandic Road Administration)', kind: 'traffic', refreshSec: 120, proxy: true,
    }));
  },
};

// ---------------------------------------------------------------- Spain
export const dgt = {
  id: 'es-dgt', label: 'DGT traffic cams', kind: 'traffic', countries: ['ES', 'GI', 'AD'],
  bbox: { minLat: 27.5, maxLat: 44, minLon: -18.5, maxLon: 4.6 }, listTtlMs: 60 * 60e3, timeoutMs: 15000,
  hosts: ['etraffic.dgt.es'], imageHosts: ['etraffic.dgt.es'],
  async list() {
    // The eTraffic site ships its camera catalogue base64-encoded and XOR-obfuscated with the byte 0x66.
    const txt = await upstream('https://etraffic.dgt.es/etrafficWEB/api/cache/getCamaras', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }, as: 'text', timeoutMs: 15000 });
    const raw = Buffer.from(txt.trim(), 'base64');
    for (let i = 0; i < raw.length; i++) raw[i] ^= 0x66;
    const j = JSON.parse(raw.toString('utf8'));
    const base = j.urlBase || 'https://etraffic.dgt.es/camarasEtraffic/';
    return (j.camaras || []).filter((c) => Number.isFinite(c.coordY) && Number.isFinite(c.coordX)).map((c) => ({
      id: 'dgt:' + c.idCamara, title: `${c.carretera || 'Road'} km ${c.pk ?? '?'}${c.sentido && c.sentido !== '-' ? ` · ${c.sentido}` : ''}`, lat: c.coordY, lon: c.coordX,
      image: `${base}${c.idCamara}.jpg`, page: 'https://etraffic.dgt.es/etrafficWEB/', live: false, source: 'DGT (Dirección General de Tráfico)', kind: 'traffic', refreshSec: 120, proxy: true,
    }));
  },
};

// ---------------------------------------------------------------- Estonia
const eeLocations = () => cached('camlist:ee-locations', 6 * 3600e3, async () => {
  const xml = await upstream('https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraLocations', { as: 'text', accept: 'application/xml', timeoutMs: 15000 });
  const out = new Map();
  for (const m of xml.matchAll(/<predefinedLocation id="([^"]+)"[^>]*>([\s\S]*?)<\/predefinedLocation>/g)) {
    const seg = m[2];
    out.set(m[1], { name: ((seg.match(/<value[^>]*lang="[^"]*"[^>]*>([^<]*)</) || [])[1] || '').trim() || 'Road camera', lat: +tag(seg, 'latitude'), lon: +tag(seg, 'longitude') });
  }
  return [...out.entries()];
});
const eeImages = () => cached('camlist:ee-images', 2 * 60e3, async () => {
  const xml = await upstream('https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraImages', { as: 'text', accept: 'application/xml', timeoutMs: 15000 });
  const out = {};
  for (const m of xml.matchAll(/<trafficView id="([^"]+)">([\s\S]*?)<\/trafficView>/g)) {
    const seg = m[2];
    const loc = (seg.match(/PredefinedLocation" id="([^"]+)"/) || [])[1];
    const url = tag(seg, 'urlLinkAddress');
    if (loc && url) out[loc] = { url, time: tag(seg, 'trafficViewTime'), camId: m[1].split('-')[0] };
  }
  return out;
});
export const tarktee = {
  id: 'ee-tarktee', label: 'Tark Tee road cams', kind: 'traffic', countries: ['EE'],
  bbox: { minLat: 57.5, maxLat: 59.7, minLon: 21.7, maxLon: 28.3 }, listTtlMs: 2 * 60e3, timeoutMs: 20000,
  hosts: ['tarktee.transpordiamet.ee'], imageHosts: ['tarktee.transpordiamet.ee'],
  async list() {
    const [locs, imgs] = await Promise.all([eeLocations(), eeImages()]);
    return locs.map(([uuid, l]) => {
      const im = imgs[uuid]; if (!im || !Number.isFinite(l.lat)) return null;
      return { id: 'ee:' + uuid, title: l.name, lat: l.lat, lon: l.lon, image: `/cam/ee-tarktee/${uuid}`, page: 'https://tarktee.transpordiamet.ee/', updated: im.time, live: false, source: 'Transpordiamet (Tark Tee)', kind: 'traffic', refreshSec: 120 };
    }).filter(Boolean);
  },
  async resolveImage(uuid) { const imgs = await eeImages(); return imgs[uuid]?.url || null; },
};

// ---------------------------------------------------------------- Italy: A22 Brennero motorway
export const autobrennero = {
  id: 'it-a22', label: 'Autobrennero A22 cams', kind: 'traffic', countries: ['IT', 'AT'],
  bbox: { minLat: 44.5, maxLat: 47.2, minLon: 10.5, maxLon: 11.8 }, listTtlMs: 6 * 3600e3, timeoutMs: 25000,
  hosts: ['www.autobrennero.it'], imageHosts: ['www.autobrennero.it', 'autobrennero.it'],
  async list() {
    const html = await upstream('https://www.autobrennero.it/it/in-viaggio/webcam/', { as: 'text', accept: 'text/html', timeoutMs: 25000, maxBytes: 8e6 });
    const i = html.indexOf('coordinateTratte'); const j = html.indexOf('puntiWebcam');
    const line = i >= 0 ? html.slice(i, i + 4_000_000) : '';
    const pts = [...line.matchAll(/"Distanza":([\d.]+),"Lat":([\d.]+),"Lng":([\d.]+)/g)].map((m) => [+m[1], +m[2], +m[3]]);
    const at = (km) => { let best = null, bd = Infinity; for (const p of pts) { const d = Math.abs(p[0] - km); if (d < bd) { bd = d; best = p; } } return best; };
    const cams = [];
    const seg = j >= 0 ? html.slice(j, j + 200_000) : html;
    for (const m of seg.matchAll(/\{"ID":"(\d+)","Titolo":"([^"]*)","Descrizione":"([^"]*)","Immagine":"([^"]+WebCamImg\/km(\d+)\.jpg)"[^}]*?"Localita":"([^"]*)"/g)) {
      const km = +m[5]; const p = at(km); if (!p) continue;
      cams.push({ id: 'a22:' + km, title: `A22 ${m[2]} · ${m[6].split('|')[0].trim()} km ${km}`, subtitle: m[3], lat: p[1], lon: p[2], image: 'https:' + m[4].replace(/^https?:/, ''), page: 'https://www.autobrennero.it/it/in-viaggio/webcam/', live: false, source: 'Autostrada del Brennero', kind: 'traffic', refreshSec: 120, proxy: true });
    }
    return cams;
  },
};

// ---------------------------------------------------------------- Sweden (free key)
export const trafikverket = {
  id: 'se-trafikverket', label: 'Trafikverket road cams', kind: 'traffic', countries: ['SE'], keyHint: 'TRAFIKVERKET_KEY',
  bbox: { minLat: 55.2, maxLat: 69.1, minLon: 10.9, maxLon: 24.2 }, listTtlMs: 30 * 60e3, timeoutMs: 15000,
  hosts: ['api.trafikinfo.trafikverket.se'], imageHosts: ['api.trafikinfo.trafikverket.se'],
  enabled: () => !!config.keys.trafikverket,
  async list() {
    const body = `<REQUEST><LOGIN authenticationkey="${config.keys.trafikverket}"/><QUERY objecttype="Camera" schemaversion="1" limit="3000"><FILTER><EQ name="Active" value="true"/></FILTER><INCLUDE>Id</INCLUDE><INCLUDE>Name</INCLUDE><INCLUDE>PhotoUrl</INCLUDE><INCLUDE>PhotoTime</INCLUDE><INCLUDE>Geometry.WGS84</INCLUDE><INCLUDE>Type</INCLUDE><INCLUDE>Direction</INCLUDE><INCLUDE>Location</INCLUDE></QUERY></REQUEST>`;
    const j = await upstream('https://api.trafikinfo.trafikverket.se/v2/data.json', { method: 'POST', body, headers: { 'content-type': 'text/xml' }, timeoutMs: 15000 });
    const cams = j.RESPONSE?.RESULT?.[0]?.Camera || [];
    return cams.map((c) => { const m = /POINT \(([-\d.]+) ([-\d.]+)\)/.exec(c.Geometry?.WGS84 || ''); if (!m) return null; return { id: 'se:' + c.Id, title: `${c.Name}${c.Location ? ` · ${c.Location}` : ''}`, lat: +m[2], lon: +m[1], image: c.PhotoUrl + (c.PhotoUrl?.includes('?') ? '&' : '?') + 'type=fullsize', page: 'https://www.trafikverket.se/trafikinformation/', updated: c.PhotoTime, live: false, source: 'Trafikverket', kind: 'traffic', refreshSec: 300, proxy: true }; }).filter(Boolean);
  },
};

export const countrySources = [digitraffic, tfl, vegagerdin, dgt, tarktee, autobrennero, trafikverket];
