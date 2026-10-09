// Static file server plus a cached proxy for the road flood feeds.
// Longdo Traffic sends CORS headers, but POPNIX Flood (Bangkok road sensors) does not,
// and both ask heavy users to cache rather than have every browser call them.
// No dependencies: `node server.mjs` (PORT defaults to 8080).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const TTL = 60 * 1000;

// Local path -> upstream URL. Only these are proxied.
const API_ROUTES = {
  // Nationwide traffic events (floods reported by the Department of Highways and iTIC users).
  '/api/thai-roads': 'https://event.longdo.com/feed/json',
  // Bangkok road and tunnel flood sensors (BMA Drainage and Sewerage Department via POPNIX Flood open API).
  '/api/roads': 'https://flood.pop.in.th/api_roads.php',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const cache = new Map(); // url -> { at, body, pending }

function cached(url) {
  const hit = cache.get(url);
  if (hit?.body && Date.now() - hit.at < TTL) return Promise.resolve({ body: hit.body, cache: 'HIT' });
  if (hit?.pending) return hit.pending;

  const pending = (async () => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'roadflood' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const body = Buffer.from(await r.arrayBuffer());
      cache.set(url, { at: Date.now(), body });
      return { body, cache: 'MISS' };
    } catch (err) {
      // Serve the last good copy if we have one, so a flaky upstream doesn't blank the page.
      if (hit?.body) { cache.set(url, { at: hit.at, body: hit.body }); return { body: hit.body, cache: 'STALE' }; }
      cache.delete(url);
      throw err;
    }
  })();
  cache.set(url, { ...hit, pending });
  return pending;
}

async function serveStatic(pathname, res) {
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (!file.startsWith(ROOT + '/') || /(^|\/)\.|server\.mjs$|package\.json$/.test(file.slice(ROOT.length))) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const st = await stat(file);
    if (st.isDirectory()) { res.writeHead(301, { Location: pathname + '/' }).end(); return; }
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const upstream = API_ROUTES[url.pathname];
  if (upstream) {
    try {
      const r = await cached(upstream);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Cache': r.cache });
      res.end(r.body);
    } catch (err) {
      console.error(new Date().toISOString(), url.pathname, err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'upstream unavailable' }));
    }
    return;
  }
  await serveStatic(url.pathname, res);
}).listen(PORT, () => {
  console.log(`Road flood checker on http://localhost:${PORT}`);
});
