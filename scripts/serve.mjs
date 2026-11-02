// Tiny static server (no deps, no npx) for widget/ and dashboard/. Usage: node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const ROOT = resolve(import.meta.dirname, '..'), PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ALLOWED = ['widget', 'dashboard', 'lib']; // never serve .git, .env, target/, etc.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
export function resolvePath(urlPath) {
  let p = decodeURIComponent(new URL(urlPath, 'http://x').pathname);
  if (p === '/') return null;
  if (p.endsWith('/')) p += 'index.html';
  const abs = resolve(ROOT, '.' + p);
  const top = abs.slice(ROOT.length + 1).split(sep)[0];
  if (!abs.startsWith(ROOT + sep) || !ALLOWED.includes(top) || abs.split(sep).some((s) => s.startsWith('.'))) return undefined;
  return abs;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer(async (req, res) => {
    let abs;
    try { abs = resolvePath(req.url); } catch { abs = undefined; }
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (abs === null) { res.writeHead(302, { location: '/widget/demo.html' }); return res.end(); }
    if (!abs) { res.writeHead(403); return res.end('forbidden'); }
    try {
      const body = await readFile(abs);
      res.writeHead(200, { 'content-type': TYPES[extname(abs)] || 'application/octet-stream', 'access-control-allow-origin': '*' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  }).on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`Port ${PORT} is already in use. Pick another one: pnpm serve 8081 (or PORT=8081 pnpm serve)`);
    process.exit(1);
  }).listen(PORT, () => console.log(`ShowUp static server: http://localhost:${PORT}/widget/demo.html  http://localhost:${PORT}/dashboard/`));
}
