/** Process bootstrap: optional multi-process cluster, HTTP server, graceful shutdown, cache warming. */
import http from 'node:http';
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { config } from './config.js';
import { log } from './lib/log.js';
import { configureCache } from './lib/cache.js';

const workers = config.workers === 'auto' ? availableParallelism() : config.workers;
if (workers > 1 && cluster.isPrimary) {
  log.info({ workers }, 'starting cluster');
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (w, code) => { if (!shuttingDown) { log.warn({ pid: w.process.pid, code }, 'worker died, restarting'); cluster.fork(); } });
  let shuttingDown = false;
  const stop = () => { shuttingDown = true; for (const w of Object.values(cluster.workers)) w.process.kill('SIGTERM'); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} else {
  configureCache({ maxEntries: config.cache.maxEntries });
  const { handle } = await import('./app.js');
  const server = http.createServer({ keepAliveTimeout: 65_000, headersTimeout: 70_000, requestTimeout: 120_000, maxHeaderSize: 16 * 1024 }, (req, res) => { handle(req, res); });
  server.listen(config.port, config.host, () => log.info({ port: config.port, host: config.host, env: config.env, pid: process.pid, node: process.version }, 'europa live listening'));

  // Warm the slow, shared caches so the first click is as fast as the hundredth.
  import('./providers/satellite.js').then((m) => { m.eumetsatLatest().catch(() => {}); m.gibsLatest().catch(() => {}); });
  import('./providers/radar.js').then((m) => m.rainviewerFrames().catch(() => {}));
  import('./providers/ships.js').then((m) => m.ensureAis());

  const shutdown = (sig) => {
    log.info({ sig }, 'shutting down');
    server.close(() => process.exit(0));
    import('./providers/ships.js').then((m) => m.stopAis());
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => { log.fatal({ err }, 'uncaught exception'); process.exit(1); });
}
