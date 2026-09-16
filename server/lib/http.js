/**
 * Upstream HTTP client used by every provider.
 *  - hard timeout per request (AbortController)
 *  - bounded retries with jittered backoff (idempotent GETs only)
 *  - per-host concurrency limiter so one slow upstream can't hog sockets
 *  - per-host circuit breaker: after N consecutive failures the host is
 *    skipped for a cooldown, so a dead upstream costs ~0ms instead of a timeout
 *  - metrics for every call (latency histogram, status counters)
 *  - fixed, allow-listed destinations only: user input never forms a hostname
 */
import { config } from '../config.js';
import { metrics } from './metrics.js';
import { log } from './log.js';

const hosts = new Map(); // host -> { active, queue:[], failures, openUntil }
function state(host) {
  let s = hosts.get(host);
  if (!s) { s = { active: 0, queue: [], failures: 0, openUntil: 0, lastError: null, lastOk: 0 }; hosts.set(host, s); }
  return s;
}
function acquire(s, limit) {
  if (s.active < limit) { s.active++; return Promise.resolve(); }
  return new Promise((resolve) => s.queue.push(resolve)).then(() => { s.active++; });
}
function release(s) { s.active--; const next = s.queue.shift(); if (next) next(); }

export class UpstreamError extends Error {
  constructor(message, { status, host, code } = {}) { super(message); this.name = 'UpstreamError'; this.status = status; this.host = host; this.code = code; }
}

/** Snapshot of upstream health for /api/status. */
export function upstreamHealth() {
  const now = Date.now();
  return Object.fromEntries([...hosts].map(([h, s]) => [h, {
    active: s.active, queued: s.queue.length, failures: s.failures,
    circuit: s.openUntil > now ? 'open' : 'closed', lastError: s.lastError, lastOk: s.lastOk || null,
  }]));
}

/**
 * @param {string} url
 * @param {object} opts { method, headers, timeoutMs, retries, as: 'json'|'text'|'buffer'|'response', body, maxBytes }
 */
export async function upstream(url, opts = {}) {
  const u = new URL(url);
  const host = u.host;
  const s = state(host);
  const now = Date.now();
  if (s.openUntil > now) {
    metrics.inc('upstream_requests_total', { host, result: 'circuit_open' });
    throw new UpstreamError(`circuit open for ${host}`, { host, code: 'ECIRCUIT' });
  }
  const timeoutMs = opts.timeoutMs ?? config.upstream.timeoutMs;
  const retries = opts.method && opts.method !== 'GET' && opts.method !== 'HEAD' ? 0 : (opts.retries ?? config.upstream.retries);
  const limit = opts.concurrency ?? config.upstream.perHostConcurrency;
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    await acquire(s, limit);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = process.hrtime.bigint();
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: { 'user-agent': config.userAgent, accept: opts.accept || 'application/json, text/plain, */*', ...(opts.headers || {}) },
        body: opts.body,
        signal: ac.signal,
        redirect: opts.redirect || 'follow',
      });
      const dt = Number(process.hrtime.bigint() - t0) / 1e9;
      metrics.observe('upstream_latency_seconds', { host }, dt);
      metrics.inc('upstream_requests_total', { host, result: String(res.status) });
      if (!res.ok && (opts.okStatuses ? !opts.okStatuses.includes(res.status) : true)) {
        const body = await res.text().catch(() => '');
        const retriable = res.status >= 500 || res.status === 429;
        const err = new UpstreamError(`${host} responded ${res.status}: ${body.slice(0, 160)}`, { status: res.status, host });
        if (retriable) throw err;
        // 4xx is a caller problem, not a host outage: don't trip the breaker.
        s.lastOk = Date.now();
        clearTimeout(timer); release(s);
        throw err;
      }
      s.failures = 0; s.lastOk = Date.now(); s.lastError = null;
      const as = opts.as || 'json';
      let out;
      if (as === 'response') out = res;
      else if (as === 'json') out = await res.json();
      else if (as === 'text') out = await res.text();
      else if (as === 'buffer') {
        const len = +res.headers.get('content-length');
        if (opts.maxBytes && len > opts.maxBytes) throw new UpstreamError('upstream body too large', { host, code: 'ETOOLARGE' });
        const buf = Buffer.from(await res.arrayBuffer());
        if (opts.maxBytes && buf.length > opts.maxBytes) throw new UpstreamError('upstream body too large', { host, code: 'ETOOLARGE' });
        out = { buffer: buf, headers: res.headers, status: res.status };
      }
      clearTimeout(timer); release(s);
      return out;
    } catch (err) {
      clearTimeout(timer); release(s);
      lastErr = err;
      if (err instanceof UpstreamError && err.status && err.status < 500 && err.status !== 429) throw err;
      const isAbort = err.name === 'AbortError';
      metrics.inc('upstream_requests_total', { host, result: isAbort ? 'timeout' : 'error' });
      s.failures++; s.lastError = (isAbort ? 'timeout' : err.message).slice(0, 200);
      if (s.failures >= config.upstream.breakerFailures) {
        s.openUntil = Date.now() + config.upstream.breakerCooldownMs;
        s.failures = 0;
        log.warn({ host, cooldownMs: config.upstream.breakerCooldownMs }, 'circuit opened');
      }
      attempt++;
      if (attempt <= retries) await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));
    }
  }
  throw lastErr instanceof UpstreamError ? lastErr : new UpstreamError(String(lastErr?.message || lastErr), { host, code: lastErr?.name === 'AbortError' ? 'ETIMEDOUT' : lastErr?.code });
}

/** Race several equivalent sources; first fulfilled wins, all failures -> throws. */
export function firstOf(promiseFactories) {
  return Promise.any(promiseFactories.map((f) => f()));
}
