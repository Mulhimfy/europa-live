/** Tiny Prometheus-style metrics registry (counters + histograms), zero deps. */
const counters = new Map();
const hists = new Map();
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 16];
const lk = (labels) => Object.entries(labels || {}).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).sort().join(',');

export const metrics = {
  inc(name, labels, n = 1) { const k = name + '{' + lk(labels) + '}'; counters.set(k, (counters.get(k) || 0) + n); },
  observe(name, labels, seconds) {
    const k = name + '|' + lk(labels);
    let h = hists.get(k);
    if (!h) { h = { name, labels: lk(labels), buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 }; hists.set(k, h); }
    h.sum += seconds; h.count++;
    for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) h.buckets[i]++;
  },
  render(extra = {}) {
    const lines = [];
    for (const [k, v] of counters) lines.push(`${k} ${v}`);
    for (const h of hists.values()) {
      const l = h.labels ? h.labels + ',' : '';
      BUCKETS.forEach((b, i) => lines.push(`${h.name}_bucket{${l}le="${b}"} ${h.buckets[i]}`));
      lines.push(`${h.name}_bucket{${l}le="+Inf"} ${h.count}`);
      lines.push(`${h.name}_sum{${h.labels}} ${h.sum}`);
      lines.push(`${h.name}_count{${h.labels}} ${h.count}`);
    }
    for (const [k, v] of Object.entries(extra)) lines.push(`${k} ${v}`);
    const m = process.memoryUsage();
    lines.push(`process_resident_memory_bytes ${m.rss}`, `process_heap_used_bytes ${m.heapUsed}`, `process_uptime_seconds ${process.uptime().toFixed(0)}`);
    return lines.join('\n') + '\n';
  },
  snapshot() { return { counters: Object.fromEntries(counters) }; },
};
