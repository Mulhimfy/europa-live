/** Sliding-window rate limiter keyed by client IP (memory-bounded, self-cleaning). */
export class RateLimiter {
  constructor({ max, windowMs, maxKeys = 50_000 }) { this.max = max; this.windowMs = windowMs; this.maxKeys = maxKeys; this.buckets = new Map(); this.lastSweep = Date.now(); }
  /** @returns {{ok:boolean, remaining:number, resetMs:number}} */
  hit(key, cost = 1) {
    const now = Date.now();
    if (now - this.lastSweep > this.windowMs || this.buckets.size > this.maxKeys) this.sweep(now);
    let b = this.buckets.get(key);
    if (!b || now - b.start >= this.windowMs) { b = { start: now, prev: b ? b.count : 0, count: 0 }; this.buckets.set(key, b); }
    // Sliding-window approximation: weight the previous window by its remaining overlap.
    const elapsed = (now - b.start) / this.windowMs;
    const est = b.prev * (1 - elapsed) + b.count + cost;
    if (est > this.max) return { ok: false, remaining: 0, resetMs: this.windowMs - (now - b.start) };
    b.count += cost;
    return { ok: true, remaining: Math.max(0, Math.floor(this.max - est)), resetMs: this.windowMs - (now - b.start) };
  }
  sweep(now) {
    for (const [k, b] of this.buckets) if (now - b.start > this.windowMs * 2) this.buckets.delete(k);
    if (this.buckets.size > this.maxKeys) { // hard cap: drop oldest half
      let i = 0; for (const k of this.buckets.keys()) { if (i++ > this.maxKeys / 2) break; this.buckets.delete(k); }
    }
    this.lastSweep = now;
  }
}
