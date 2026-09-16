/**
 * Central configuration. Everything comes from the environment so the same
 * image runs unchanged in dev, CI, Docker and behind a load balancer.
 * Secrets (API keys) never leave this process; they are only used server-side.
 */
const env = process.env;
const int = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v, d = []) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

export const config = Object.freeze({
  env: env.NODE_ENV || 'production',
  port: int(env.PORT, 8080),
  host: env.HOST || '0.0.0.0',
  /** Number of worker processes. 0 = single process (default), "auto" = one per CPU. */
  workers: env.WEB_CONCURRENCY === 'auto' ? 'auto' : int(env.WEB_CONCURRENCY, 0),
  trustProxy: bool(env.TRUST_PROXY, false),
  publicUrl: env.PUBLIC_URL || '',
  userAgent: env.UPSTREAM_USER_AGENT || 'EuropaLive/1.0 (+https://github.com/Mulhimfy/europa-live; open-source live Europe explorer)',
  logLevel: env.LOG_LEVEL || 'info',

  // ---- limits & safety ---------------------------------------------------
  rateLimit: {
    /** Requests per window per client IP for /api and /img. */
    max: int(env.RATE_LIMIT_MAX, 240),
    windowMs: int(env.RATE_LIMIT_WINDOW_MS, 60_000),
    /** Separate, stricter budget for the image proxy (bytes are expensive). */
    imgMax: int(env.RATE_LIMIT_IMG_MAX, 600),
  },
  upstream: {
    timeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 9_000),
    retries: int(env.UPSTREAM_RETRIES, 1),
    /** Max concurrent in-flight requests per upstream host (protects them and us). */
    perHostConcurrency: int(env.UPSTREAM_PER_HOST, 8),
    breakerFailures: int(env.BREAKER_FAILURES, 5),
    breakerCooldownMs: int(env.BREAKER_COOLDOWN_MS, 30_000),
  },
  cache: {
    maxEntries: int(env.CACHE_MAX_ENTRIES, 5_000),
    /** Coordinates are snapped to a grid (metres) so nearby clicks share cache. */
    snapMetres: int(env.CACHE_SNAP_METRES, 150),
  },
  imgProxy: {
    maxBytes: int(env.IMG_PROXY_MAX_BYTES, 8 * 1024 * 1024),
    ttlMs: int(env.IMG_PROXY_TTL_MS, 20_000),
    /** Extra hosts (comma separated) allowed through the proxy, in addition to provider hosts. */
    extraHosts: list(env.IMG_PROXY_EXTRA_HOSTS),
  },
  /** Aggregate deadline for the streaming /api/live endpoint. */
  liveDeadlineMs: int(env.LIVE_DEADLINE_MS, 30_000),

  // ---- optional provider credentials (all features degrade gracefully) ----
  keys: {
    windy: env.WINDY_WEBCAMS_KEY || '',
    youtube: env.YOUTUBE_API_KEY || '',
    mapillary: env.MAPILLARY_TOKEN || '',
    firms: env.NASA_FIRMS_KEY || '',
    aisstream: env.AISSTREAM_KEY || '',
    openskyUser: env.OPENSKY_USER || '',
    openskyPass: env.OPENSKY_PASS || '',
    trafikverket: env.TRAFIKVERKET_KEY || '',
    openaq: env.OPENAQ_KEY || '',
    tomtom: env.TOMTOM_KEY || '',
  },
});

/** Europe's bounding box (generous: includes Iceland, Svalbard, Canaries, Cyprus, Caucasus). */
export const EUROPE_BBOX = Object.freeze({ minLat: 27.5, maxLat: 82, minLon: -32, maxLon: 60 });
