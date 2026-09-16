/** Live precipitation radar (RainViewer global composite, 10-minute frames + nowcast). */
import { upstream } from '../lib/http.js';
import { cached } from '../lib/cache.js';

export function rainviewerFrames() {
  return cached('rainviewer:maps', 60e3, async () => {
    const j = await upstream('https://api.rainviewer.com/public/weather-maps.json', { timeoutMs: 6000 });
    const host = j.host || 'https://tilecache.rainviewer.com';
    const mk = (f, kind) => ({ time: new Date(f.time * 1000).toISOString(), kind, tiles: `${host}${f.path}/256/{z}/{x}/{y}/4/1_1.png` });
    return {
      generated: new Date(j.generated * 1000).toISOString(),
      past: (j.radar?.past || []).map((f) => mk(f, 'past')),
      nowcast: (j.radar?.nowcast || []).map((f) => mk(f, 'nowcast')),
      satelliteIR: (j.satellite?.infrared || []).map((f) => ({ time: new Date(f.time * 1000).toISOString(), tiles: `${host}${f.path}/256/{z}/{x}/{y}/0/0_0.png` })),
    };
  });
}

export default {
  id: 'radar', label: 'Rain radar', tier: 'sky', ttlMs: 60e3, timeoutMs: 8000,
  hosts: ['api.rainviewer.com', 'tilecache.rainviewer.com'],
  async fetch() {
    const f = await rainviewerFrames();
    const latest = f.past[f.past.length - 1];
    return { latest: latest?.time || null, frames: [...f.past, ...f.nowcast], cadenceMin: 10, attribution: 'RainViewer (radar composite of national weather services)' };
  },
};
