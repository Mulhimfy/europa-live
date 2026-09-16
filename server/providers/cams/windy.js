/** Windy Webcams (webcams.travel network): tens of thousands of public webcams with live players. Free key: https://api.windy.com/webcams */
import { config } from '../../config.js';
import { upstream } from '../../lib/http.js';
import { haversine } from '../../lib/geo.js';

export default {
  id: 'windy', label: 'Windy Webcams', kind: 'webcam', keyHint: 'WINDY_WEBCAMS_KEY', countries: null,
  hosts: ['api.windy.com'], imageHosts: ['images-webcams.windy.com', 'images.webcams.travel'],
  enabled: () => !!config.keys.windy,
  async fetch({ lat, lon, radiusKm }) {
    const j = await upstream(`https://api.windy.com/webcams/api/v3/webcams?nearby=${lat},${lon},${Math.min(250, radiusKm)}&limit=50&include=images,location,player,urls,categories&sortKey=distance`, { headers: { 'x-windy-api-key': config.keys.windy }, timeoutMs: 8000 });
    return (j.webcams || []).map((w) => ({
      id: 'windy:' + w.webcamId, title: w.title, lat: w.location?.latitude, lon: w.location?.longitude,
      image: w.images?.current?.preview || w.images?.current?.thumbnail, thumb: w.images?.current?.thumbnail,
      video: w.player?.live || null, embed: w.player?.live || w.player?.day || null, page: w.urls?.detail,
      updated: w.lastUpdatedOn, live: !!w.player?.live, source: 'Windy Webcams', kind: 'webcam', refreshSec: 600,
      categories: (w.categories || []).map((c) => c.name), distanceKm: w.location ? +(haversine(lat, lon, w.location.latitude, w.location.longitude) / 1000).toFixed(1) : null,
    }));
  },
};
