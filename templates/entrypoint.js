import { Server } from './server/index.js';
import { manifest as svelteManifest } from './server/manifest.js';
import isrRoutes from './isr-manifest.json' with { type: 'json' };

const REVALIDATE_TOKEN = process.env.REVALIDATE_TOKEN ?? null;
const ORIGIN = process.env.ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`;

const server = new Server(svelteManifest);
await server.init({ env: process.env });

const cache = new Map();

function fillParams(routeId, params) {
  return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`[${k}]`, v), routeId);
}

async function renderAndCache(pathname) {
  const req = new Request(new URL(pathname, ORIGIN));
  const res = await server.respond(req, { platform: {} });
  const body = await res.text();
  cache.set(pathname, {
    body,
    status: res.status,
    headers: Object.fromEntries(res.headers),
    cachedAt: Date.now(),
  });
}

async function resolvePaths(route) {
  if (!route.hasEntries) return [route.routeId];
  const mod = await import(`./server/entries/${route.routeId}.js`);
  const entryList = await mod.entries();
  return entryList.map((params) => fillParams(route.routeId, params));
}

// warm cache + schedule proactive rebuilds
for (const route of isrRoutes) {
  const paths = await resolvePaths(route);
  for (const p of paths) {
    await renderAndCache(p);
    const jitter = Math.random() * 5000;
    setInterval(() => renderAndCache(p), route.revalidate * 1000 + jitter);
  }
}

Bun.serve({
  port: process.env.PORT ?? 3000,
  hostname: process.env.HOST ?? '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/__isr/revalidate' && req.method === 'POST') {
      if (!REVALIDATE_TOKEN || req.headers.get('x-revalidate-token') !== REVALIDATE_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      const target = url.searchParams.get('path');
      if (!target) return new Response('Missing ?path=', { status: 400 });
      await renderAndCache(target);
      return new Response('OK');
    }

    const cached = req.method === 'GET' ? cache.get(url.pathname) : undefined;
    if (cached) {
      return new Response(cached.body, { status: cached.status, headers: cached.headers });
    }

    return server.respond(req, { platform: {} });
  },
});

console.log(`[svelte-adapter-bun-isr] listening on ${ORIGIN}`);