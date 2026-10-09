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

// Route planner backends (public FOSSGIS Valhalla and Komoot Photon, both on OpenStreetMap data).
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const PHOTON = 'https://photon.komoot.io/api/?limit=5&bbox=97.3,5.6,105.7,20.5&q=';
const GEO_TTL = 10 * 60 * 1000;
const MAX_BODY = 64 * 1024;

const cache = new Map(); // url -> { at, body, pending }

function cached(url, ttl = TTL) {
  const hit = cache.get(url);
  if (hit?.body && Date.now() - hit.at < ttl) return Promise.resolve({ body: hit.body, cache: 'HIT' });
  if (hit?.pending) return hit.pending;

  const pending = (async () => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'roadflood' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const body = Buffer.from(await r.arrayBuffer());
      cache.set(url, { at: Date.now(), body });
      if (cache.size > 2000) cache.delete(cache.keys().next().value); // geocode keys are unbounded
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

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error('too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', fail);
  });
}

// Forward a route request, keeping only the options the page uses.
async function proxyRoute(req, res) {
  let q;
  try { q = JSON.parse(await readBody(req)); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'bad request' }));
    return;
  }
  const locs = Array.isArray(q.locations) ? q.locations.slice(0, 2) : [];
  if (locs.length !== 2 || !locs.every((l) => Number.isFinite(l?.lat) && Number.isFinite(l?.lon))) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'need two locations' }));
    return;
  }
  const body = { locations: locs.map((l) => ({ lat: l.lat, lon: l.lon })), costing: 'auto', units: 'kilometers', directions_type: 'none' };
  if (Array.isArray(q.exclude_polygons)) body.exclude_polygons = q.exclude_polygons.slice(0, 20);
  else if (Number.isInteger(q.alternates)) body.alternates = Math.min(3, Math.max(0, q.alternates));
  try {
    const r = await fetch(VALHALLA, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'roadflood' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    // Pass Valhalla's own answer through, including "no path" errors the page explains to the user.
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error(new Date().toISOString(), '/api/route', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'route service unavailable' }));
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/route' && req.method === 'POST') {
    await proxyRoute(req, res);
    return;
  }
  if (url.pathname === '/api/geocode') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) { res.writeHead(400).end(); return; }
    try {
      const r = await cached(PHOTON + encodeURIComponent(q), GEO_TTL);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600', 'X-Cache': r.cache });
      res.end(r.body);
    } catch (err) {
      console.error(new Date().toISOString(), '/api/geocode', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'geocoder unavailable' }));
    }
    return;
  }
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
