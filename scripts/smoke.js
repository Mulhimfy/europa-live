#!/usr/bin/env node
/** End-to-end smoke test against a running instance (needs network). Usage: BASE=http://localhost:8080 node scripts/smoke.js */
const base = process.env.BASE || 'http://localhost:8080';
const places = [['Rome', 41.8902, 12.4922], ['Helsinki', 60.17, 24.94], ['London', 51.507, -0.127], ['Madrid', 40.4168, -3.7038], ['Reykjavik', 64.1466, -21.9426]];
let failed = 0;
for (const [name, lat, lon] of places) {
  const t0 = Date.now();
  const r = await fetch(`${base}/api/live.json?lat=${lat}&lon=${lon}`);
  const j = await r.json();
  const ok = Object.values(j.results || {}).filter((x) => x.ok).length;
  const total = Object.keys(j.results || {}).length;
  const cams = j.results?.cams?.data?.count ?? '-';
  console.log(`${name.padEnd(10)} ${r.status} ${String(Date.now() - t0).padStart(6)} ms  providers ${ok}/${total}  cams ${cams}`);
  if (r.status !== 200 || ok < total - 2) failed++;
}
process.exit(failed ? 1 : 0);
