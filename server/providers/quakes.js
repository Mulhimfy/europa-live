/** Seismic activity nearby: EMSC (European-Mediterranean, near-real-time), USGS, INGV (Italy). */
import { upstream } from '../lib/http.js';
import { haversine, bboxAround } from '../lib/geo.js';

export default {
  id: 'quakes', label: 'Earthquakes', tier: 'earth', ttlMs: 2 * 60e3, timeoutMs: 9000,
  hosts: ['www.seismicportal.eu', 'earthquake.usgs.gov', 'webservices.ingv.it'],
  async fetch({ lat, lon, place }) {
    const radiusKm = 250;
    const b = bboxAround(lat, lon, radiusKm * 1000);
    const since = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 19);
    const bb = `minlat=${b.minLat}&maxlat=${b.maxLat}&minlon=${b.minLon}&maxlon=${b.maxLon}`;
    const tasks = [
      upstream(`https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=100&${bb}&start=${since}&orderby=time`, { timeoutMs: 7000 }).then((j) => (j.features || []).map((f) => ({ id: 'emsc:' + f.id, time: f.properties.time, mag: f.properties.mag, magType: f.properties.magtype, depthKm: f.properties.depth, lat: f.properties.lat, lon: f.properties.lon, place: f.properties.flynn_region, source: 'EMSC', url: `https://www.seismicportal.eu/eventdetails.html?unid=${f.properties.unid}` }))),
      upstream(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=100&minlatitude=${b.minLat}&maxlatitude=${b.maxLat}&minlongitude=${b.minLon}&maxlongitude=${b.maxLon}&starttime=${since}&orderby=time`, { timeoutMs: 7000 }).then((j) => (j.features || []).map((f) => ({ id: 'usgs:' + f.id, time: new Date(f.properties.time).toISOString(), mag: f.properties.mag, magType: f.properties.magType, depthKm: f.geometry.coordinates[2], lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], place: f.properties.place, source: 'USGS', url: f.properties.url }))),
    ];
    if (place?.cc === 'IT' || place?.cc === 'SM' || place?.cc === 'VA') {
      tasks.push(upstream(`https://webservices.ingv.it/fdsnws/event/1/query?format=geojson&limit=100&${bb}&starttime=${since}&orderby=time`, { timeoutMs: 7000 }).then((j) => (j.features || []).map((f) => ({ id: 'ingv:' + f.properties.eventId, time: f.properties.time.endsWith('Z') ? f.properties.time : f.properties.time + 'Z', mag: f.properties.mag, magType: f.properties.magType, depthKm: f.geometry.coordinates[2], lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], place: f.properties.place, source: 'INGV', url: `https://terremoti.ingv.it/event/${f.properties.eventId}` }))));
    }
    const results = await Promise.allSettled(tasks);
    const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    // De-duplicate events reported by several agencies (same minute, within 30 km).
    const merged = [];
    for (const q of all.sort((a, b) => new Date(b.time) - new Date(a.time))) {
      q.distanceKm = +(haversine(lat, lon, q.lat, q.lon) / 1000).toFixed(0);
      if (q.distanceKm > radiusKm) continue;
      const dup = merged.find((m) => Math.abs(new Date(m.time) - new Date(q.time)) < 90e3 && haversine(m.lat, m.lon, q.lat, q.lon) < 30_000);
      if (dup) { dup.sources = [...new Set([...(dup.sources || [dup.source]), q.source])]; if ((q.mag ?? 0) > (dup.mag ?? 0)) dup.mag = q.mag; continue; }
      q.sources = [q.source];
      merged.push(q);
    }
    const day = Date.now() - 86400e3;
    return { radiusKm, count: merged.length, last24h: merged.filter((q) => new Date(q.time) > day).length, strongest: merged.reduce((m, q) => (q.mag > (m?.mag ?? -1) ? q : m), null), events: merged.slice(0, 30), attribution: 'EMSC, USGS, INGV' };
  },
};
