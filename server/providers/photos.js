/** Latest ground-level imagery: Mapillary (recent street-level captures, optional token) and Wikimedia Commons photos taken nearby, newest first. */
import { config } from '../config.js';
import { upstream } from '../lib/http.js';
import { bboxAround, haversine } from '../lib/geo.js';

export default {
  id: 'photos', label: 'Latest photos', tier: 'latest', ttlMs: 30 * 60e3, timeoutMs: 10000,
  hosts: ['commons.wikimedia.org', 'graph.mapillary.com'],
  async fetch({ lat, lon }) {
    const tasks = [
      upstream(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=geosearch&ggscoord=${lat}|${lon}&ggsradius=1500&ggslimit=40&ggsnamespace=6&prop=imageinfo|coordinates&iiprop=url|timestamp|user|extmetadata&iiurlwidth=800&iiextmetadatafilter=DateTimeOriginal|LicenseShortName|Artist|ImageDescription`, { timeoutMs: 9000 })
        .then((j) => Object.values(j.query?.pages || {}).map((p) => {
          const ii = p.imageinfo?.[0] || {}; const md = ii.extmetadata || {};
          const taken = md.DateTimeOriginal?.value ? new Date(md.DateTimeOriginal.value.replace(' ', 'T')) : null;
          const co = p.coordinates?.[0];
          return { id: 'commons:' + p.pageid, title: p.title.replace(/^File:/, '').replace(/\.\w+$/, ''), thumb: ii.thumburl, url: ii.descriptionurl || `https://commons.wikimedia.org/?curid=${p.pageid}`, taken: taken && !isNaN(taken) ? taken.toISOString() : ii.timestamp, uploaded: ii.timestamp, author: (md.Artist?.value || ii.user || '').replace(/<[^>]+>/g, '').slice(0, 60), license: md.LicenseShortName?.value || '', source: 'Wikimedia Commons', distanceM: co ? Math.round(haversine(lat, lon, co.lat, co.lon)) : null };
        }).filter((p) => p.thumb)),
    ];
    if (config.keys.mapillary) {
      const b = bboxAround(lat, lon, 400);
      tasks.push(upstream(`https://graph.mapillary.com/images?fields=id,captured_at,thumb_1024_url,compass_angle,geometry,is_pano&bbox=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&limit=40`, { timeoutMs: 9000, headers: { authorization: 'OAuth ' + config.keys.mapillary } })
        .then((j) => (j.data || []).map((m) => ({ id: 'mly:' + m.id, title: m.is_pano ? '360° street view' : 'Street-level view', thumb: m.thumb_1024_url, url: `https://www.mapillary.com/app/?pKey=${m.id}&focus=photo`, taken: new Date(m.captured_at).toISOString(), heading: m.compass_angle, source: 'Mapillary', distanceM: m.geometry ? Math.round(haversine(lat, lon, m.geometry.coordinates[1], m.geometry.coordinates[0])) : null }))));
    }
    const rs = await Promise.allSettled(tasks);
    const photos = rs.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => new Date(b.taken || 0) - new Date(a.taken || 0));
    if (rs.every((r) => r.status === 'rejected')) throw rs[0].reason;
    return { count: photos.length, photos: photos.slice(0, 24), mapillary: !!config.keys.mapillary, attribution: 'Wikimedia Commons contributors' + (config.keys.mapillary ? ', Mapillary' : '') };
  },
};
