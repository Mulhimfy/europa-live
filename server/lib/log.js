/** Minimal structured JSON logger (pino-compatible line format, zero deps). */
import { config } from '../config.js';
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const threshold = LEVELS[config.logLevel] ?? 30;
const out = process.stdout;
function write(level, obj, msg) {
  if (LEVELS[level] < threshold) return;
  const rec = { level: LEVELS[level], time: Date.now(), pid: process.pid, ...(typeof obj === 'string' ? { msg: obj } : obj) };
  if (msg) rec.msg = msg;
  if (rec.err instanceof Error) rec.err = { message: rec.err.message, code: rec.err.code, stack: level === 'error' ? rec.err.stack : undefined };
  out.write(JSON.stringify(rec) + '\n');
}
export const log = Object.fromEntries(Object.keys(LEVELS).map((l) => [l, (o, m) => write(l, o, m)]));
