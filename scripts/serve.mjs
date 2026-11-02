// Tiny static server (no deps, no npx) for widget/ and dashboard/. Usage: node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const ROOT = resolve(import.meta.dirname, '..'), PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ALLOWED = ['widget', 'dashboard', 'lib']; // never serve .git, .env, target/, etc.
const ONECLICK = process.env.ONECLICK_BASE || 'https://1click.chaindefuser.com/v0';
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
// Same-origin proxy for 1Click dry quotes (1Click sends no CORS headers). Only POST /api/1click/quote is forwarded.
export async function proxyQuote(req, res, fetchImpl = fetch) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/api/1click/quote') { res.writeHead(404, cors); return res.end('not found'); }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 16384) { res.writeHead(413, cors); return res.end('too large'); } chunks.push(c); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { res.writeHead(400, cors); return res.end('bad json'); }
  if (body.dry !== true) { res.writeHead(400, cors); return res.end('only dry quotes are proxied'); }
  const json = { ...cors, 'content-type': 'application/json' };
  try {
    const r = await fetchImpl(`${ONECLICK}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    if (!r.ok && (r.status >= 500 || /<html|<!DOCTYPE/i.test(t))) { res.writeHead(502, json); return res.end(JSON.stringify({ error: `1Click unavailable (HTTP ${r.status})` })); }
    res.writeHead(r.status, { ...cors, 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(t);
  } catch (e) { res.writeHead(502, json); res.end(JSON.stringify({ error: `1Click unreachable: ${e.message}` })); }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer(async (req, res) => {
    let abs;
    try { abs = resolvePath(req.url); } catch { abs = undefined; }
    if (req.url.startsWith('/api/1click/')) return proxyQuote(req, res);
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
