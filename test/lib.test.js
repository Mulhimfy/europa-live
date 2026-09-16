import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cached, peek, clearCache, cacheStats } from '../server/lib/cache.js';
import { RateLimiter } from '../server/lib/ratelimit.js';
import { rssItems } from '../server/lib/xml.js';
import { setImageHosts, imageHostAllowed, proxyImage } from '../server/lib/imageproxy.js';
import { metrics } from '../server/lib/metrics.js';

test('cache: coalesces concurrent calls and serves fresh hits', async () => {
  clearCache();
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { n: calls }; };
  const [a, b, c] = await Promise.all([cached('k1', 1000, fn), cached('k1', 1000, fn), cached('k1', 1000, fn)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.deepEqual(await cached('k1', 1000, fn), { n: 1 });
  assert.ok((await peek('k1')).freshUntil > Date.now());
  assert.ok(cacheStats().l1Size >= 1);
});
test('cache: stale-while-revalidate returns the stale value and refreshes in the background', async () => {
  clearCache();
  let calls = 0;
  const fn = async () => ({ n: ++calls });
  await cached('k2', 10, fn, { staleMs: 10_000 });
  await new Promise((r) => setTimeout(r, 25));
  const stale = await cached('k2', 10, fn, { staleMs: 10_000 });
  assert.equal(stale.n, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await cached('k2', 10, fn, { staleMs: 10_000 })).n, 2);
});
test('cache: errors are not cached', async () => {
  clearCache();
  let calls = 0;
  const fn = async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok'; };
  await assert.rejects(cached('k3', 1000, fn));
  assert.equal(await cached('k3', 1000, fn), 'ok');
});
test('rate limiter: allows up to max, then blocks, keys are independent', () => {
  const rl = new RateLimiter({ max: 3, windowMs: 50 });
  assert.equal(rl.hit('ip').ok, true);
  assert.equal(rl.hit('ip').ok, true);
  assert.equal(rl.hit('ip').ok, true);
  const blocked = rl.hit('ip');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.resetMs > 0);
  assert.equal(rl.hit('other').ok, true);
});
test('rss: extracts items and decodes entities and CDATA', () => {
  const xml = '<rss><channel><item><title><![CDATA[Fire &amp; smoke near <b>Rome</b>]]></title><link>https://x/1</link><pubDate>Tue, 15 Sep 2026 10:00:00 GMT</pubDate><source url="https://s">Source A</source></item><item><title>Second</title><link>https://x/2</link></item></channel></rss>';
  const items = rssItems(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Fire & smoke near Rome');
  assert.equal(items[0].link, 'https://x/1');
  assert.equal(items[0].source, 'Source A');
  assert.equal(rssItems('<rss/>').length, 0);
});
test('image proxy: strict host allow-list, no credentials, no bad schemes', async () => {
  setImageHosts(['weathercam.digitraffic.fi', '*.example.org']);
  assert.equal(imageHostAllowed('weathercam.digitraffic.fi'), true);
  assert.equal(imageHostAllowed('WEATHERCAM.DIGITRAFFIC.FI'), true);
  assert.equal(imageHostAllowed('cdn.example.org'), true);
  assert.equal(imageHostAllowed('example.org'), false);
  assert.equal(imageHostAllowed('evil.com'), false);
  assert.equal((await proxyImage('https://evil.com/x.jpg')).status, 403);
  assert.equal((await proxyImage('ftp://weathercam.digitraffic.fi/x.jpg')).status, 400);
  assert.equal((await proxyImage('https://user:pw@weathercam.digitraffic.fi/x.jpg')).status, 400);
  assert.equal((await proxyImage('not a url')).status, 400);
  assert.equal((await proxyImage('https://169.254.169.254/latest/meta-data')).status, 403);
});
test('metrics render Prometheus text', () => {
  metrics.inc('test_total', { a: 'b' });
  metrics.observe('test_seconds', {}, 0.3);
  const t = metrics.render();
  assert.match(t, /test_total\{a="b"\} \d+/);
  assert.match(t, /test_seconds_bucket\{le="0.5"\} \d+/);
  assert.match(t, /process_uptime_seconds/);
});
