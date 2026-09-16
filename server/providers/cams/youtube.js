/** Live YouTube streams of the place (YouTube Data API v3, optional key). Without a key a ready-made search link is returned. */
import { config } from '../../config.js';
import { upstream } from '../../lib/http.js';

export default {
  id: 'youtube', label: 'YouTube live streams', kind: 'video', keyHint: 'YOUTUBE_API_KEY', countries: null,
  hosts: ['www.googleapis.com'], imageHosts: ['i.ytimg.com'],
  enabled: () => !!config.keys.youtube,
  async fetch({ lat, lon, radiusKm, place }) {
    const name = place?.locality || place?.name || place?.nearestCity?.name;
    if (!name) return [];
    const j = await upstream(`https://www.googleapis.com/youtube/v3/search?part=snippet&eventType=live&type=video&maxResults=12&safeSearch=strict&location=${lat},${lon}&locationRadius=${Math.min(1000, radiusKm)}km&q=${encodeURIComponent(name + ' live cam')}&key=${config.keys.youtube}`, { timeoutMs: 8000 });
    return (j.items || []).map((it) => ({
      id: 'yt:' + it.id.videoId, title: it.snippet.title, lat, lon, image: it.snippet.thumbnails?.high?.url || it.snippet.thumbnails?.default?.url,
      video: `https://www.youtube.com/watch?v=${it.id.videoId}`, embed: `https://www.youtube-nocookie.com/embed/${it.id.videoId}?autoplay=1&mute=1`, page: `https://www.youtube.com/watch?v=${it.id.videoId}`,
      live: true, source: 'YouTube', kind: 'video', channel: it.snippet.channelTitle, refreshSec: 0, distanceKm: null,
    }));
  },
};
