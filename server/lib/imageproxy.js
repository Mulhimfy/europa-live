/**
 * Image proxy for webcam frames. Many public traffic cameras only publish
 * plain-http JPEGs that browsers refuse to load on an https page. The proxy
 *   - only fetches hosts on an explicit allow-list (no SSRF surface)
 *   - refuses redirects to non-allow-listed hosts
 *   - enforces a byte cap and a timeout
 *   - only relays image/* and video/* content types
 *   - caches frames briefly so a page full of cameras costs upstream one fetch
 */
import { config } from '../config.js';
import { cached } from './cache.js';
import { createHash } from 'node:crypto';

let allow = new Set();
export function setImageHosts(hosts) { allow = new Set([...hosts, ...config.imgProxy.extraHosts].map((h) => h.toLowerCase())); }
export function imageHostAllowed(host) {
  host = host.toLowerCase();
  if (allow.has(host)) return true;
  for (const h of allow) if (h.startsWith('*.') && host.endsWith(h.slice(1))) return true;
  return false;
}
export function listImageHosts() { return [...allow]; }

export async function proxyImage(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return { status: 400, error: 'bad url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { status: 400, error: 'bad scheme' };
  if (u.username || u.password) return { status: 400, error: 'credentials not allowed' };
  if (!imageHostAllowed(u.hostname)) return { status: 403, error: 'host not allowed' };
  const key = 'img:' + createHash('sha1').update(u.href).digest('base64url');
  try {
    const r = await cached(key, config.imgProxy.ttlMs, () => fetchImage(u), { staleMs: 0 });
    return r;
  } catch (e) {
    return { status: 502, error: e.message };
  }
}

async function fetchImage(u, hops = 0) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(u.href, { redirect: 'manual', signal: ac.signal, headers: { 'user-agent': config.userAgent, accept: 'image/*,video/*;q=0.9,*/*;q=0.5', referer: u.origin + '/' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hops >= 3) return { status: 502, error: 'too many redirects' };
      const next = new URL(res.headers.get('location'), u);
      if (!imageHostAllowed(next.hostname)) return { status: 403, error: 'redirect target not allowed' };
      return fetchImage(next, hops + 1);
    }
    if (!res.ok) return { status: 502, error: 'upstream ' + res.status };
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^(image|video)\//.test(type) && type !== 'application/octet-stream') return { status: 415, error: 'not an image: ' + type };
    const len = +res.headers.get('content-length');
    if (len > config.imgProxy.maxBytes) return { status: 413, error: 'too large' };
    const reader = res.body.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > config.imgProxy.maxBytes) { reader.cancel(); return { status: 413, error: 'too large' }; }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    const sniffed = sniff(body);
    return { status: 200, body, type: sniffed || (type === 'application/octet-stream' ? 'image/jpeg' : type), lastModified: res.headers.get('last-modified') || undefined };
  } finally { clearTimeout(t); }
}

function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (b.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  return null;
}
