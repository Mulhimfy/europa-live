/**
 * Static file server: whole public/ tree is read into memory at boot (it is
 * small), pre-compressed with brotli + gzip, served with strong ETags and
 * long-lived immutable caching for hashed vendor assets. No filesystem access
 * happens per request, so path traversal is impossible by construction.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.map': 'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.webmanifest', '.map']);

export function loadStatic(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      const ext = extname(name).toLowerCase();
      const body = readFileSync(p);
      const etag = '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"';
      const entry = { body, etag, type: TYPES[ext] || 'application/octet-stream', size: body.length, immutable: p.includes('/vendor/') };
      if (COMPRESSIBLE.has(ext) && body.length > 512) {
        entry.br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 10 } });
        entry.gz = gzipSync(body, { level: 9 });
      }
      files.set('/' + relative(root, p).split('\\').join('/'), entry);
    }
  };
  walk(root);
  return files;
}

export function serveStatic(files, req, res, pathname) {
  if (pathname.endsWith('/')) pathname += 'index.html';
  const f = files.get(pathname);
  if (!f) return false;
  const headers = {
    'content-type': f.type,
    etag: f.etag,
    vary: 'accept-encoding',
    'cache-control': f.immutable ? 'public, max-age=31536000, immutable' : (pathname.endsWith('.html') ? 'no-cache' : 'public, max-age=300, stale-while-revalidate=86400'),
  };
  if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); res.end(); return true; }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = f.body;
  if (f.br && /\bbr\b/.test(ae)) { body = f.br; headers['content-encoding'] = 'br'; }
  else if (f.gz && /\bgzip\b/.test(ae)) { body = f.gz; headers['content-encoding'] = 'gzip'; }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
