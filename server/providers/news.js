/** Latest headlines mentioning the place (Google News RSS, last 7 days). */
import { upstream } from '../lib/http.js';
import { rssItems } from '../lib/xml.js';

export default {
  id: 'news', label: 'Latest headlines', tier: 'latest', ttlMs: 10 * 60e3, timeoutMs: 9000,
  hosts: ['news.google.com'],
  async fetch({ place }) {
    const name = place?.locality || place?.name || place?.nearestCity?.name;
    if (!name) return { items: [] };
    const q = `"${name}" ${place?.country || ''} when:7d`.trim();
    const xml = await upstream(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { as: 'text', accept: 'application/rss+xml, application/xml, text/xml', timeoutMs: 8000 });
    const items = rssItems(xml, 12).map((i) => ({ ...i, published: i.published ? new Date(i.published).toISOString() : null })).filter((i) => i.title);
    return { query: name, items, attribution: 'Google News RSS' };
  },
};
