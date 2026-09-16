/**
 * In-memory LRU cache with TTL, stale-while-revalidate and in-flight request
 * coalescing. Every cacheable upstream call goes through `cached()`, so a burst
 * of identical requests results in a single upstream fetch.
 *
 * The store is pluggable: `setStore()` accepts any object implementing
 * get/set/delete (e.g. a Redis adapter) for multi-node deployments; the LRU is
 * still used as an L1 in front of it.
 */
import { metrics } from './metrics.js';

class LRU {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v === undefined) return undefined; this.map.delete(k); this.map.set(k, v); return v; }
  set(k, v) { if (this.map.has(k)) this.map.delete(k); this.map.set(k, v); if (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
  delete(k) { this.map.delete(k); }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

let l1 = new LRU(5000);
let l2 = null; // optional external store {get(key)->Promise<entry|undefined>, set(key, entry, ttlMs), delete(key)}
const inflight = new Map();

export function configureCache({ maxEntries } = {}) { if (maxEntries) l1 = new LRU(maxEntries); }
export function setStore(store) { l2 = store; }
export function cacheStats() { return { l1Size: l1.size, inflight: inflight.size, l2: !!l2 }; }
export function clearCache() { l1.clear(); inflight.clear(); }

async function read(key) {
  const hit = l1.get(key);
  if (hit) return hit;
  if (l2) { const v = await l2.get(key).catch(() => undefined); if (v) { l1.set(key, v); return v; } }
  return undefined;
}
async function write(key, entry) {
  l1.set(key, entry);
  if (l2) await l2.set(key, entry, entry.staleAt - Date.now()).catch(() => {});
}

/**
 * @param {string} key
 * @param {number} ttlMs fresh lifetime
 * @param {() => Promise<any>} fn producer
 * @param {{staleMs?: number}} opts extra lifetime during which stale data is
 *        served immediately while a background refresh runs.
 */
export async function cached(key, ttlMs, fn, { staleMs = ttlMs * 4 } = {}) {
  const now = Date.now();
  const entry = await read(key);
  if (entry) {
    if (entry.freshUntil > now) { metrics.inc('cache_hits_total', { kind: 'fresh' }); return entry.value; }
    if (entry.staleAt > now) {
      metrics.inc('cache_hits_total', { kind: 'stale' });
      if (!inflight.has(key)) revalidate(key, ttlMs, staleMs, fn); // fire & forget
      return entry.value;
    }
  }
  metrics.inc('cache_misses_total');
  return revalidate(key, ttlMs, staleMs, fn);
}

function revalidate(key, ttlMs, staleMs, fn) {
  let p = inflight.get(key);
  if (p) return p;
  p = (async () => {
    try {
      const value = await fn();
      const now = Date.now();
      await write(key, { value, freshUntil: now + ttlMs, staleAt: now + ttlMs + staleMs, at: now });
      return value;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

/** Peek without triggering a fetch (used to expose data age to the client). */
export async function peek(key) { return read(key); }
