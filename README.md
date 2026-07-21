# SvelteKit Bun Adapter ISR

A production-ready [SvelteKit](https://kit.svelte.dev) adapter for [Bun](https://bun.sh) with built-in Incremental Static Regeneration (ISR), native multi-core clustering, and precompression — no reverse proxy or edge platform required.

[![npm version](https://img.shields.io/npm/v/@pingpolls/svelte-adapter-bun-isr)](https://www.npmjs.com/package/@pingpolls/svelte-adapter-bun-isr)
[![license](https://img.shields.io/npm/l/@pingpolls/svelte-adapter-bun-isr)](https://github.com/pingpolls/svelte-adapter-bun-isr/blob/main/LICENSE)

- **Bun-native server output** — no Node.js required at runtime
- **ISR** for any prerendered route, page or endpoint (`.html`, `.json`, `.csv`, whatever it renders) — static-file speed with background revalidation, no rebuild needed
- **Multi-core clustering** via Bun's native `reusePort` — scales across every CPU core out of the box
- **Static asset + prerendered page serving** straight from Bun, with optional `.gz`/`.br`/`.zst` precompression
- **WebSocket support** via `hooks.server` export bundling

## Install

```bash
bun add @pingpolls/svelte-adapter-bun-isr
```

## Quick start

`svelte.config.js`:

```ts
import adapter from '@pingpolls/svelte-adapter-bun-isr';

export default {
  kit: {
    adapter: adapter(), // all options below are optional, these are the defaults
  },
};
```

```bash
bun run build
bun run build/index.js
```

`build/index.js` is always the right entry point — it's either the server itself (`cluster: false`) or a supervisor spawning one worker per core in front of it (`cluster: true`, the default).

### Options

| Option | Default | Does |
|---|---|---|
| `out` | `'build'` | Output directory |
| `serveAssets` | `true` | Serve client assets + prerendered pages from Bun. Set `false` if a CDN/proxy does this instead |
| `precompress` | `true` | Emit `.gz`/`.br`/`.zst` variants at build time, negotiated via `Accept-Encoding` |
| `envPrefix` | `''` | Prefix for runtime env vars (`HOST`, `PORT`, `SOCKET_PATH`, `IDLE_TIMEOUT`, `CPUS`, `BUN_BINARY`) |
| `idleTimeout` | `10` | Default `Bun.serve` idle timeout in seconds (runtime env wins if set) |
| `websockets` | `true` | Bundle `hooks.server`'s `websocket` export into `Bun.serve` |
| `cluster` | `true` | Spawn one worker per CPU core behind `SO_REUSEPORT`. Set `false` if something else already manages process count (PM2, k8s HPA, fly.io) — running both multiplies your worker count |

## Features by example

### ISR on a page

```ts
// src/routes/isr/page/+page.server.ts
import type { Config } from '@pingpolls/svelte-adapter-bun-isr';

export const prerender = 'auto'; // required — see "prerender: auto vs true" below
export const config: Config = { revalidate: 15 }; // seconds
```

The page is served straight from the prerendered file on every request. Once it's older than 15s, the *next* request still gets the current file immediately, and a fresh render happens in the background and overwrites it for the request after that (stale-while-revalidate).

### ISR on an endpoint (any content type)

```ts
// src/routes/isr/server.json/+server.ts
import { json } from '@sveltejs/kit';
import type { Config } from '@pingpolls/svelte-adapter-bun-isr';

export const prerender = 'auto';
export const config: Config = { revalidate: 30 };

export const GET = async () => json({ todos: await getTodos() });
```

Works identically for `+server.ts` endpoints — CSV, JSON, plain text, whatever `Content-Type` your handler sets is what gets served back on every subsequent request, not just `text/html`.

### Dynamic ISR routes

```ts
// src/routes/isr/[slug]/+page.server.ts
import type { Config } from '@pingpolls/svelte-adapter-bun-isr';

export const prerender = 'auto';
export const config: Config = { revalidate: 60 };
export const entries = async () => (await getSlugs()).map((slug) => ({ slug }));
```

`entries()` is what SvelteKit itself already uses to know which params to prerender at build time — this adapter reuses it for manual regeneration too (see below).

### Manual regeneration

```ts
// src/routes/api/regenerate/+server.ts
import { json } from '@sveltejs/kit';
import { regenerate } from '@pingpolls/svelte-adapter-bun-isr';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  const { paths = [], removePaths = [] } = await request.json();
  return json(await regenerate(paths, removePaths));
};
```

```ts
import { regenerate, type RegenerateResult } from '@pingpolls/svelte-adapter-bun-isr';

// concrete paths
const result: RegenerateResult = await regenerate(['/isr/page', '/isr/server.json'], ['/isr/stale-item']);

// a dynamic route's id instead of a concrete path expands every entries() param set
await regenerate(['/isr/[slug]']);
```

`regenerate()` only works from inside a request while the built server is actually running (it throws otherwise). `RegenerateResult`:

```ts
interface RegenerateResult {
  regenerated: string[]; // existing paths re-rendered in place
  created: string[];     // brand-new paths written for the first time
  removed: string[];     // paths deleted (from removePaths)
  failed: { path: string; reason: string }[];
}
```

### WebSockets

```ts
// src/hooks.server.ts
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
  const { request } = event;
  const isUpgrade =
    request.headers.get('connection')?.toLowerCase().includes('upgrade') &&
    request.headers.get('upgrade')?.toLowerCase() === 'websocket';

  if (isUpgrade && new URL(request.url).pathname === '/ws') {
    const upgraded = event.platform?.server?.upgrade(event.platform?.request);
    if (upgraded) return new Response(null, { status: 101 });
  }

  return resolve(event);
};

export const websocket: Bun.WebSocketHandler<undefined> = {
  open(ws) { ws.send('connected'); },
  message(ws, message) { ws.send(message); }, // echo
};
```

Or upgrade per-route from a `+server.ts` with `platform.server.upgrade(platform.request)` instead of doing it globally in `hooks.server.ts` — either way works, since only the dynamic-SSR fallback ever reaches `platform.server`/`platform.request`.

Types:

```ts
// src/app.d.ts
declare global {
  namespace App {
    interface Platform {
      server: Bun.Server;
      request: Request;
    }
  }
}
export {};
```

Bun's pub/sub works as usual — `ws.subscribe('room')` / `ws.publish(...)`, or `event.platform.server.publish('room', data)` from any hook or `+server.ts`.

## `prerender: 'auto'` vs `true`

Use `'auto'`, not `true`, on any route you want ISR on. `true` strips the route from SvelteKit's SSR manifest entirely, and this adapter regenerates content by calling into that same SSR manifest at runtime — a route that isn't in it can't be regenerated. With `prerender = true`, `revalidate` is silently a no-op.

## How requests are resolved

1. Static client assets
2. Prerendered/ISR files — the in-memory index (built at boot, updated on every regenerate/remove) maps the path straight to its file on disk; file *bytes* are still read fresh from disk per request, only the lookup is O(1) in memory. A background regeneration is kicked off first if the file is older than its `revalidate` window
3. A path under an ISR-enabled route that has no prerendered file yet
4. Everything else — normal SvelteKit SSR

### Where this differs from stock SvelteKit

- **Step 3 is the one real difference.** A path that matches an ISR-enabled route but has never been rendered (e.g. a fresh dynamic slug not covered by `entries()` at build time, and not yet regenerated on demand) gets a **404 immediately**, with rendering kicked off in the background for the *next* request — it does not block the current request on a live SSR render the way an ordinary SvelteKit dynamic route would. Call `regenerate()` (or wait for the request-after-next) once you know the path exists.
- **Steps 1–3 use their own route matcher**, not SvelteKit's router, purely to decide "is this path governed by an ISR route." It mirrors SvelteKit's own specificity rules (static segments > matched params > plain params > rest params), so the outcome never disagrees with SvelteKit — it only exists to make that decision without going through full SSR. Step 4 hands off to SvelteKit's real router unchanged.

## File layout

```text
build/
  client/
  prerendered/
  server/
    manifest.js
    index.js
    hooks.js   # only when a websocket export is bundled
    chunks/ entries/ nodes/ .vite/
  app.js       # only when cluster is enabled — the actual server
  index.js     # supervisor when cluster is enabled, otherwise the server
```

## Caveats

- The prerendered-path index is per-process; under `cluster: true` each worker rebuilds it independently at boot, but they all read/write the same files on disk, so staleness is briefly worker-local at worst
- `prerender = 'auto'` is required for ISR — see above
- `.zst` precompression is best-effort (skipped if unsupported by the running Bun build)
- Manual `regenerate()` on a dynamic route id needs that route's `entries()` export — without it, the call no-ops for that id rather than erroring
- `cluster: true` plus an external process manager both managing worker count will multiply concurrency — use one or the other

## Benchmarked performance

Load-tested with `wrk` (15s, 12 threads, 512 connections) against `svelte-adapter-bun` on identical hardware.

![Throughput comparison: svelte-adapter-bun vs @pingpolls/svelte-adapter-bun-isr](https://raw.githubusercontent.com/pingpolls/svelte-adapter-bun-isr/refs/heads/main/benchmark/throughput.webp)

![Latency comparison: svelte-adapter-bun vs @pingpolls/svelte-adapter-bun-isr](https://raw.githubusercontent.com/pingpolls/svelte-adapter-bun-isr/refs/heads/main/benchmark/latency.webp)

| Mode | svelte-adapter-bun | this adapter | Improvement |
|---|---|---|---|
| SSR, no caching | 7,516 req/s · 67.08ms avg | 32,451 req/s · 15.72ms avg | 4.3x throughput, 4.3x lower latency |
| SSG, prerendered | 64,208 req/s · 7.84ms avg | 300,057 req/s · 1.69ms avg | 4.7x throughput, 4.6x lower latency |
| ISR, prerendered + revalidation | — | 299,767 req/s · 1.69ms avg | matches static prerender speed |

> The SSR gap comes almost entirely from built-in clustering, not raw per-core speed — single-core SSR throughput between the two adapters is comparable. `cluster: true` (default) spawns one worker per CPU core via `reusePort` automatically; pin the count with the `CPUS` env var if needed.

## Contributing

See [GitHub](https://github.com/pingpolls/svelte-adapter-bun-isr).

## License

MIT
