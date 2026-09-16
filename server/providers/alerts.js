/** Active hazards: Meteoalarm (official national weather warnings), GDACS disaster alerts, NASA EONET events. */
import { upstream } from '../lib/http.js';
import { cached } from '../lib/cache.js';
import { countries } from './place.js';
import { haversine } from '../lib/geo.js';

const SEVERITY = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };
// Meteoalarm awareness_level: 1 green (none), 2 yellow, 3 orange, 4 red.
const LEVEL = { 4: 'red', 3: 'orange', 2: 'yellow', 1: 'green', 0: 'none' };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function meteoalarmCountry(slug) {
  return cached('meteoalarm:' + slug, 5 * 60e3, async () => {
    const j = await upstream(`https://feeds.meteoalarm.org/api/v1/warnings/feeds-${slug}`, { timeoutMs: 8000 });
    const now = Date.now();
    const out = [];
    for (const w of j.warnings || []) {
      const a = w.alert || {};
      for (const info of a.info || []) {
        if (info.language && !/^en/i.test(info.language) && (a.info || []).some((i) => /^en/i.test(i.language || ''))) continue; // prefer English block
        const expires = info.expires ? new Date(info.expires).getTime() : 0;
        if (expires && expires < now) continue;
        const level = (info.parameter || []).find((p) => p.valueName === 'awareness_level')?.value || '';
        const type = (info.parameter || []).find((p) => p.valueName === 'awareness_type')?.value || '';
        const lvlNum = +(level.split(';')[0]) || SEVERITY[info.severity] || 0;
        out.push({
          id: a.identifier, event: info.event || type.split(';')[1]?.trim() || info.headline || 'Warning', severity: info.severity, level: LEVEL[Math.min(4, Math.max(0, lvlNum))] || 'yellow', levelNum: lvlNum,
          type: type.split(';')[1]?.trim() || '', onset: info.onset || info.effective || a.sent, expires: info.expires || null,
          areas: (info.area || []).map((x) => x.areaDesc), description: (info.description || '').slice(0, 400), instruction: (info.instruction || '').slice(0, 300),
          sender: info.senderName || a.sender, web: info.web || 'https://meteoalarm.org',
        });
      }
    }
    return out;
  });
}

export default {
  id: 'alerts', label: 'Warnings & hazards', tier: 'earth', ttlMs: 3 * 60e3, timeoutMs: 10000,
  hosts: ['feeds.meteoalarm.org', 'www.gdacs.org', 'eonet.gsfc.nasa.gov'],
  async fetch({ lat, lon, place }) {
    const cc = place?.cc;
    const slug = countries[cc]?.meteoalarm;
    const regionNames = [place?.region, place?.county, place?.locality, place?.nearestCity?.name, place?.nearestCity?.admin1].filter(Boolean).map(norm);
    const [ma, gd, eo] = await Promise.allSettled([
      slug ? meteoalarmCountry(slug) : Promise.resolve([]),
      cached('gdacs:events', 5 * 60e3, () => upstream(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;WF;DR&fromDate=${new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10)}&toDate=${new Date(Date.now() + 86400e3).toISOString().slice(0, 10)}&alertlevel=Green;Orange;Red`, { timeoutMs: 8000 })),
      cached('eonet:eu', 10 * 60e3, () => upstream('https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&bbox=-32,82,60,27&days=30', { timeoutMs: 8000 })),
    ]);
    const warnings = ma.status === 'fulfilled' ? ma.value : [];
    // Warnings for the exact region first, then the rest of the country (summarised).
    const local = warnings.filter((w) => w.areas.some((ad) => regionNames.some((r) => r && (norm(ad).includes(r) || r.includes(norm(ad))))));
    const localIds = new Set(local.map((w) => w.id + w.event));
    const elsewhere = warnings.filter((w) => !localIds.has(w.id + w.event));
    const gdacs = gd.status === 'fulfilled' ? (gd.value.features || []).map((f) => {
      const p = f.properties || {}; const [x, y] = f.geometry?.coordinates || [];
      return { id: p.eventid, type: p.eventtype, name: p.name || p.eventname, level: (p.alertlevel || '').toLowerCase(), from: p.fromdate, to: p.todate, country: p.country, lat: y, lon: x, distanceKm: Number.isFinite(x) ? Math.round(haversine(lat, lon, y, x) / 1000) : null, url: p.url?.report || p.url?.details || `https://www.gdacs.org/report.aspx?eventid=${p.eventid}&eventtype=${p.eventtype}`, iscurrent: p.iscurrent };
    }).filter((e) => e.distanceKm != null && e.distanceKm < 800).sort((a, b) => a.distanceKm - b.distanceKm) : [];
    const eonet = eo.status === 'fulfilled' ? (eo.value.features || []).map((f) => {
      const p = f.properties || {}; const [x, y] = f.geometry?.type === 'Point' ? f.geometry.coordinates : (f.geometry?.coordinates?.[0]?.[0] || []);
      return { id: p.id, title: p.title, category: p.categories?.[0]?.title, date: p.date, lat: y, lon: x, distanceKm: Number.isFinite(x) ? Math.round(haversine(lat, lon, y, x) / 1000) : null, url: p.link };
    }).filter((e) => e.distanceKm != null && e.distanceKm < 800).sort((a, b) => a.distanceKm - b.distanceKm) : [];
    const maxLevel = Math.max(0, ...local.map((w) => w.levelNum));
    return {
      country: countries[cc]?.name || cc || null, meteoalarmCovered: !!slug, maxLevel: LEVEL[Math.min(4, Math.max(0, maxLevel))] || 'none',
      local: local.slice(0, 12), countryCount: warnings.length, elsewhere: elsewhere.slice(0, 8).map((w) => ({ event: w.event, level: w.level, areas: w.areas.slice(0, 3), expires: w.expires })),
      gdacs: gdacs.slice(0, 8), eonet: eonet.slice(0, 8),
      attribution: 'Meteoalarm / EUMETNET national weather services, GDACS (EC JRC & UN OCHA), NASA EONET',
    };
  },
};
