# SvelteKit Bun Adapter ISR

A production-ready [SvelteKit](https://kit.svelte.dev) adapter for [Bun](https://bun.sh) with built-in Incremental Static Regeneration (ISR), native multi-core clustering, and precompression — no reverse proxy or edge platform required.

[![npm version](https://img.shields.io/npm/v/@pingpolls/svelte-adapter-bun-isr)](https://www.npmjs.com/package/@pingpolls/svelte-adapter-bun-isr)
[![license](https://img.shields.io/npm/l/@pingpolls/svelte-adapter-bun-isr)](https://github.com/pingpolls/svelte-adapter-bun-isr/blob/main/LICENSE)

- **Bun-native server output** — no Node.js required at runtime
- **ISR** for any prerendered route, page or endpoint (`.html`, `.json`, `.csv`, whatever it renders) — static-file speed with background revalidation, no rebuild needed
- **Multi-core clustering** via Bun's native `reusePort` — scales across every CPU core out of the box
- **Static asset + prerendered page serving** straight from Bun, with optional `.gz`/`.br`/`.zst` precompression (off by default)
- **WebSocket support** via `hooks.server`'s `websocket` export
- **Native TLS** from a single `TLS_ORIGIN_CERT` secret (e.g. a Cloudflare Origin Certificate)
- **Bun-level interceptors and cluster-wide singletons** — gate requests (honeypots, rate limits) before SvelteKit runs, and start queue workers once per cluster instead of once per core

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
| `precompress` | `false` | Emit `.gz`/`.br`/`.zst` variants at build time, negotiated via `Accept-Encoding` |
| `envPrefix` | `''` | Prefix for runtime env vars (see [Runtime environment](#runtime-environment)) |
| `idleTimeout` | `10` | Default `Bun.serve` idle timeout in seconds (runtime env wins if set) |
| `compress` | `false` | Compress dynamic (SSR) responses at runtime with zstd, then gzip, per `Accept-Encoding`. Leave off when a CDN/proxy (Cloudflare, nginx) already compresses. See [Compression](#compression) |
| `websockets` | `true` | Bundle `hooks.server`'s `websocket` export into `Bun.serve` |
| `cluster` | `true` | Spawn one worker per CPU core behind `SO_REUSEPORT`. Set `false` if something else already manages process count (PM2, k8s HPA, fly.io) — running both multiplies your worker count |
| `isrHosts` | omitted | Exact, case-insensitive DNS hostname allowlist for **all** prerendered files and unknown-ISR interception. Omitted allows every host (backward compatible); `[]` disables both interceptions. No schemes, ports, wildcards, or paths; request ports are ignored |
| `isrOrigin` | `'http://isr-worker'` | HTTP(S) origin used by HTML/data regeneration and fallback-404 rendering. An optional trailing `/` is accepted; credentials, other paths, queries, and fragments are rejected at build time |

### Compression

Two independent switches:

- `precompress` (build time, default **off**): `.br`/`.zst`/`.gz` variants of client assets and prerendered pages, picked per request with brotli > zstd > gzip, each served with the original file's `Content-Type`. Costs no CPU at runtime. Leave it off when a CDN or reverse proxy in front compresses.
- `compress` (runtime, default **off**): compresses dynamic SSR responses on the fly. Turn it on only when nothing in front of Bun compresses (a CDN or reverse proxy normally does, and compressing twice just wastes CPU).

Runtime compression prefers zstd, then gzip (brotli at its default quality costs roughly 10x the CPU per response, so it stays build-time only), honors `q=0`, and streams the body instead of buffering it. It is skipped for non-200 responses, bodies already encoded, `Cache-Control: no-transform`, bodies under 1 KB when `Content-Length` is set, `text/event-stream`, and any response without an explicit compressible `Content-Type` (`text/*`, JSON, JavaScript, XML/SVG). It adds `Vary: Accept-Encoding` and weakens strong `ETag`s.

### Runtime environment

All names take `envPrefix` if configured. An empty, blank or quoted-empty value (`""` or `''`, a common placeholder in secret stores that cannot hold an empty value) is the same as unset.

| Variable | Default | Does |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Listen address |
| `SOCKET_PATH` | unset | Listen on a unix socket instead of `HOST`/`PORT` |
| `HOST_HEADER` / `PROTOCOL_HEADER` | unset | Trusted proxy headers (see below) |
| `IDLE_TIMEOUT` | `idleTimeout` option | `Bun.serve` idle timeout, seconds |
| `TLS_ORIGIN_CERT` | unset | PEM **contents** (certificate + private key in one value); set it to serve HTTPS (see [TLS](#tls)) |
| `CPUS` | core count | HTTP worker count (`cluster: true`) |
| `BACKGROUND_WORKERS` | `0` | Extra non-HTTP processes for `singleton()` (see [Singletons](#singletons-queue-workers-once-per-cluster)) |
| `WORKER_ROLE` | `http` | `background` makes a process skip `Bun.serve` and only host singletons. Set by the supervisor; set it yourself only with `cluster: false` |
| `SHARED_STORE_PATH` | auto | SQLite file behind `sharedStore()`; the supervisor sets it (see [`sharedStore`](#sharedstorename)) |
| `SHUTDOWN_TIMEOUT` | `10` | Seconds a SIGTERM/SIGINT waits for singleton `dispose()` hooks before exiting |
| `BUN_BINARY` | current Bun | Binary the supervisor spawns workers with |

`WORKER_INDEX` and `WORKER_COUNT` are set by the supervisor for each worker.

### Canonical publications with custom-domain SSR

```ts
adapter({
  isrHosts: ['pingpolls.com', 'www.pingpolls.com'],
  isrOrigin: 'https://pingpolls.com',
});
```

Only allowlisted hostnames can serve prerendered publications or receive the adapter's unknown-ISR 404. Other hosts go through `server.respond()` so SvelteKit hooks and rerouting can resolve custom-domain forms at the same paths, including `/`. Shared client assets remain available on every host. Only `GET` and `HEAD` are intercepted; actions and other methods always reach SvelteKit. `HEAD` has the same cache status/headers as `GET`, with no body.

Behind a trusted reverse proxy, set `HOST_HEADER=x-forwarded-host` and `PROTOCOL_HEADER=x-forwarded-proto` (with `envPrefix` if configured). The adapter uses these explicitly configured headers for both hostname gating and SvelteKit's request URL. Without configuration, forwarded headers are ignored. Missing headers fall back to the incoming URL; malformed or multi-value configured headers return HTTP 400. Configure the proxy to overwrite these headers with a single authority (`hostname[:port]`) and `http` or `https`. Use an `isrOrigin` on the canonical host so regeneration runs the canonical application hooks.

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

### Short-lived cache for dynamic (SSR) routes

For a hot route that must stay dynamic (`prerender = false`) but can tolerate a few seconds of staleness, opt in per route:

```ts
// src/routes/news/+page.server.ts
import type { Config } from '@pingpolls/svelte-adapter-bun-isr';

export const prerender = false;
export const config: Config = { ssrCache: 5 }; // seconds; or { ttl: 5, ignoreCookies: ['_ga'] }
```

Nothing is cached unless a route sets `ssrCache`. A cached response is replayed from memory (about 211k req/s in the fixture, against about 42k for a live render) and carries `x-ssr-cache: HIT` (`MISS` on the render that filled it).

What keeps it safe between visitors:

- **Only anonymous `GET`s.** A request with an `Authorization` header, any `Cookie`, or a `Range`/conditional header (`If-None-Match`, `If-Modified-Since`, …) is never served from or stored in the cache, whatever the cookie is called. `HEAD`, `POST` and the rest always render.
- **`ignoreCookies` is an explicit, per-route opt-out.** Cookies you list (analytics, consent banners) don't force a bypass; any other cookie still does. Only list cookies that cannot change what the route renders.
- **The key is the full URL** (scheme, host, path and query) **plus the request headers the render depends on.** Those are learned, not declared: while a route renders, the adapter records every header it reads through `event.request.headers` (or `event.platform.request`), including your own hooks and load functions, and adds each one's value to the key, together with any header named in the response's `Vary`. A route that reads `x-tenant` without sending `Vary` is still split per tenant. A header first read on a later render joins the key from then on. Reading the client address (`getClientAddress()`) or enumerating the headers (`entries()`, `keys()`, iteration, `forEach`) means the output can depend on anything, so such a route is rendered every time. `Vary: *` is never cached. `Accept-Encoding` is handled separately, so entries are stored uncompressed and `compress` still applies on replay. SvelteKit itself reads `Accept`, so entries are also split per distinct `Accept` value.
- **Only plain responses are stored:** status 200, no `Set-Cookie`, no `Cache-Control: private | no-store | no-cache`, not already encoded, not `text/event-stream`, body at most 512 KB. Anything else is rendered every time (the verdict is remembered for the TTL, so the route stops paying for the attempt).
- **Concurrent misses share one render**, so a burst after expiry costs a single render per worker, not one per request.

Multi-worker behaviour: the cache is **per worker process**. With `cluster: true` every worker keeps its own copy, nothing is shared, and staleness is bounded by the TTL; N workers render at most N times per TTL per key. It is memory-only (512 entries, 64 MB per worker, oldest evicted first) and resets on restart. What it cannot see: state read outside the request's headers, such as `platform.server.requestIP()`, a database, the clock or another service. Use a short TTL for that kind of output, or don't opt in. It has no effect on prerendered or `revalidate` routes.

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

Page regeneration refreshes both HTML and its paired SvelteKit `__data.json`; endpoints remain single-file renders. Both page renders must succeed before either cached response is replaced. Failed HTTP responses, data load errors, redirects, malformed data, and response-body failures preserve last-known-good content. `removePaths` deletes the page/data pair and all `.br`/`.gz`/`.zst` variants. Route IDs with groups (for example `/(public)/[document]`) expand `entries()` without including the groups in public URLs; parameter values are URL-encoded.

Workers check shared file metadata on every prerendered lookup, discover files created by peers even after a negative lookup, and recheck compressed variants rather than retaining stale file references. Per-path filesystem locks serialize regeneration and removal across workers; file replacements use atomic renames. Runtime locks and response MIME metadata live in `prerendered/.isr/`, which is excluded from public serving. This adds filesystem I/O to cache hits in exchange for cross-worker freshness. Unknown-path retry throttling remains bounded; a newly created file bypasses that throttle on the next lookup.

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

### TLS

`TLS_ORIGIN_CERT` holds the PEM itself, not a file path: the certificate followed by its private key. For a Cloudflare Origin Certificate, paste the "Origin Certificate" block and then the "Private Key" block into one secret:

```bash
TLS_ORIGIN_CERT="$(cat origin-cert.pem origin-key.pem)" bun build/index.js
```

```
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

Real newlines and literal `\n` escapes both work, so single-line secret stores and `.env` files are fine. A value without both a `CERTIFICATE` and a `PRIVATE KEY` block fails startup with an error naming the variable. Cloudflare shows the private key only once when the certificate is created; if it is lost, create a new certificate.

The variable is read once at startup and then deleted from the process environment before SvelteKit loads, so `$env/dynamic/private` and app code never see the key. With `cluster: true` the supervisor passes it on to each worker, which reads and deletes it the same way. Certificate rotation needs a restart. Works with `SOCKET_PATH` too.

### Intercept requests before SvelteKit

`intercept()` registers Bun-level handlers from `hooks.server`. They run first on every request to the HTTP workers — before static assets, ISR files, proxy header parsing, and SvelteKit's `handle` — so a blocked request never builds a `RequestEvent`, runs a hook, or touches your database. Return a `Response` to answer immediately, or nothing to let the request through; handlers run in order and the first `Response` wins.

```ts
// src/hooks.server.ts
import { intercept, sharedStore } from '@pingpolls/svelte-adapter-bun-isr';

const TRAPS = new Set(['/wp-login.php', '/.env', '/xmlrpc.php']);
const bans = sharedStore('bans');
const limits = sharedStore('limits');

intercept(
  (request, server) => {
    const ip = server.requestIP(request)?.address ?? '';
    if (bans.has(ip)) return new Response(null, { status: 451 });
    if (TRAPS.has(new URL(request.url).pathname)) {
      bans.set(ip, true, 24 * 3600); // banned on every worker, for a day
      return new Response(null, { status: 451 });
    }
  },
  (request, server) => {
    const ip = server.requestIP(request)?.address ?? '';
    if (limits.hit(ip, 60) > 300) return new Response('Too Many Requests', { status: 429 });
  },
);
```

- Synchronous handlers stay synchronous; nothing is awaited unless a handler returns a promise.
- Module-scope state is **per process** (the kernel spreads a client's connections over every worker, so a `Map` limit is effectively `limit × CPUS`). Use `sharedStore()` for anything that must be global; see below.
- Behind a proxy, `server.requestIP()` is the proxy; read the client IP from your proxy's header instead.
- Calling `intercept()` again replaces the chain. Interceptors run only in the built Bun server, not under `vite dev`/`vite preview`.

#### `sharedStore(name?)`

A key/value store shared by every process of the deployment, built on `bun:sqlite` (no dependency). Writes are atomic across processes, entries expire, and a restart starts empty.

| Method | Does |
|---|---|
| `hit(key, windowSeconds)` | Atomic fixed-window counter; returns the new count. The window starts at the first hit |
| `get(key)` / `has(key)` | JSON value / existence; expired entries read as missing |
| `set(key, value, ttlSeconds?)` | Store a JSON value; no TTL means it never expires |
| `delete(key)` / `sweep()` | Remove one key / expired rows now (a jittered sweep also runs every minute) |

`name` isolates key spaces. How it is shared: the supervisor creates one SQLite file in WAL mode inside a private, random-named directory (mode `0700`, in `/dev/shm` when present, otherwise the OS temp dir) so other local users can't read or alter it, prepares it before any worker starts, passes its path as `SHARED_STORE_PATH`, and deletes the directory on exit. Background processes share it too. With `cluster: false` the store is private to the process; set `SHARED_STORE_PATH` yourself (same value on every process, writable by all) to share across separately managed processes, and note that a path you provide is never deleted.

Each call is one synchronous prepared statement, a few microseconds on `/dev/shm`. Writers queue on SQLite's lock (waits up to 5 s), so it fits per-request counters and ban lists; for millions of writes per second or a store shared across machines, use Redis. For the very hottest checks, keep a small per-process `Map` in front (e.g. the IPs already known banned) and fall back to the store on a miss.

### Singletons: queue workers once per cluster

Top-level code in `hooks.server` (and Kit's `init` hook) runs once **per process**, not per request — but with `cluster: true` that is once per core, so 4 queue consumers × 3 workers = 12 consumers. `singleton()` runs a factory only in the processes you pick, at most once per process, keyed so that HMR re-evaluation or a second import returns the first result.

```ts
// src/hooks.server.ts
import { building } from '$app/environment';
import { singleton } from '@pingpolls/svelte-adapter-bun-isr';
import { initQueues, startWorker } from '$lib/server/jobs';

if (!building) {
  await singleton(
    'redis-workers',
    async () => {
      await initQueues();
      return startWorker();
    },
    { workers: 1, dispose: (worker) => worker.close() },
  );
}
```

Where it runs:

| Deployment | `singleton()` runs in |
|---|---|
| `BACKGROUND_WORKERS=0` (default) | HTTP workers `0 … workers-1` |
| `BACKGROUND_WORKERS=N` | background processes `0 … workers-1` only; HTTP workers skip it and resolve `undefined` |
| `role: 'http'` option | HTTP workers, even when background processes exist |
| `vite dev` / prerendering | always (once per key) — keep the `building` guard |

`BACKGROUND_WORKERS=1 bun build/index.js` has the supervisor spawn one extra process from the same build that loads your hooks but never binds a port or receives HTTP traffic, so job processing can't add latency to requests and requests can't starve jobs. Background processes are respawned on crash like HTTP workers, and `regenerate()` works from them. With `cluster: false` (PM2, k8s), run a separate deployment with `WORKER_ROLE=background`, and set `BACKGROUND_WORKERS` to that count on **every** process so the HTTP side skips its singletons.

On SIGTERM/SIGINT a process stops accepting connections, awaits each started singleton's `dispose(value)` (bounded by `SHUTDOWN_TIMEOUT`), then exits. A factory that throws is dropped from the cache, so a later call can retry. `workerInfo()` returns `{ role, index, count, backgroundWorkers, standalone }` for anything else that needs to know where it runs.

## `prerender: 'auto'` vs `true`

Use `'auto'`, not `true`, on any route you want ISR on. `true` strips the route from SvelteKit's SSR manifest entirely, and this adapter regenerates content by calling into that same SSR manifest at runtime — a route that isn't in it can't be regenerated. With `prerender = true`, `revalidate` is silently a no-op.

## How requests are resolved

0. `intercept()` handlers, if any
1. Static client assets
2. Prerendered/ISR files — only for paths that can have one (no matched route, an ISR route, or a build-time prerendered path); plain SSR routes skip the disk probes. The per-worker index is checked against shared disk on each lookup. A background page-and-data regeneration is kicked off if the file is older than its `revalidate` window
3. A path under an ISR-enabled route that has no prerendered file yet
4. Everything else — normal SvelteKit SSR, through the `ssrCache` micro-cache when the route opted in

Step 0 applies to every method. Steps 1–3 apply only to `GET`/`HEAD`. Steps 2–3 additionally require an allowed hostname when `isrHosts` is configured.

### Where this differs from stock SvelteKit

- **Step 3 is the one real difference.** A path that matches an ISR-enabled route but has never been rendered (e.g. a fresh dynamic slug not covered by `entries()` at build time, and not yet regenerated on demand) gets a **404 immediately**, with rendering kicked off in the background for the *next* request — it does not block the current request on a live SSR render the way an ordinary SvelteKit dynamic route would. Call `regenerate()` (or wait for the request-after-next) once you know the path exists.
- **Missing paths never touch SSR or your database.** The 404 page is held in memory, so a miss costs a couple of `stat` calls plus a memory copy. The same applies to `prerender = true` dynamic routes (e.g. `/no-isr/[slug]`): they are fully static, so a param that wasn't prerendered at build time gets the same instant 404 and is never discovered at runtime.
- **Steps 2–3 use their own route matcher**, not SvelteKit's router, purely to decide "is this path governed by an ISR route." It orders static segments before matched params, plain params, and rest params. Step 4 hands off to SvelteKit's real router, including application rerouting and parameter matcher validation.

## File layout

```text
build/
  client/
  prerendered/
  server/
    manifest.js
    index.js
    hooks.js   # only when a websocket export can't be read from Kit's entries/hooks.server.js
    chunks/ entries/ nodes/ .vite/
  app.js       # only when cluster is enabled — the actual server
  index.js     # supervisor when cluster is enabled, otherwise the server
```

## Caveats

- Cluster workers must share the same writable `prerendered/` directory; file lookup checks and per-path locks coordinate its cache. Separate deployments with separate filesystems need their own regeneration calls
- `prerender = 'auto'` is required for ISR — see above
- `.zst` precompression is best-effort (skipped if unsupported by the running Bun build)
- Manual `regenerate()` on a dynamic route id needs that route's `entries()` export — an empty/missing export is reported in `failed`
- `cluster: true` plus an external process manager both managing worker count will multiply concurrency — use one or the other
- Plain in-memory interceptor state is per process; use `sharedStore()` for anything that must be cluster-wide

## Benchmarked performance

Reproduce with `bun run stress` (needs `wrk`): it builds `fixtures/`, starts the server, and runs SSR (live, trivial load, and `ssrCache`), SSG, ISR, static-asset, honeypot and shared rate-limit scenarios in turn, then prints a table. Defaults are 60 s per scenario, 2 workers, 4 threads, 512 connections; override with `STRESS_DURATION`, `STRESS_CPUS`, `STRESS_THREADS`, `STRESS_CONNECTIONS`, `STRESS_PORT`, `STRESS_SKIP_BUILD=1`. `STRESS_CPUS` is the number of Bun server workers; wrk is sized separately.

Latest run (2 workers, 4 wrk threads, 512 connections):

| Scenario | Req/s | Avg latency | p99 | Errors |
|---|---|---|---|---|
| SSR, no caching | 42,211 | 12.12ms | 15.25ms | 0 |
| SSR, trivial load | 45,607 | 11.22ms | 14.06ms | 0 |
| SSR, `ssrCache` (2s) | 210,814 | 2.42ms | 3.93ms | 0 |
| SSG, prerendered | 145,805 | 3.51ms | 5.28ms | 0 |
| ISR, prerender = auto | 140,564 | 3.64ms | 5.79ms | 0 |
| Static asset | 173,708 | 2.95ms | 4.75ms | 0 |
| Interceptor, honeypot (451) | 326,418 | 1.56ms | 2.81ms | 0 |
| Interceptor, shared rate limit | 79,611 | 51.00ms | 830.70ms | 0 |

Notes:

- "SSR, trivial load" has no database query or logging, so it shows what SvelteKit's own render costs. A profile of it is dominated by SvelteKit (`render_response`, the etag hash, `devalue` serialization, `Headers`/`Response` construction), not by the adapter. Uncached SSR scales with workers, not with adapter tweaks.
- `ssrCache` is opt-in per route and is replayed from memory, which is why it beats even the ISR file path. See [Short-lived cache for dynamic (SSR) routes](#short-lived-cache-for-dynamic-ssr-routes).
- The shared rate limit writes to one SQLite file on every request, so it is bound by the write lock and does not scale with more workers. Its tail latency comes from that contention.

## Comparison with `svelte-adapter-bun`

An older, separate run:

Load-tested with `wrk` (5m, 4 threads, 512 connections) against `svelte-adapter-bun` on:

- Intel i7-13700H (Only 2 CPU utilized for the test)
- 16 GB of RAM

![Throughput comparison: svelte-adapter-bun vs @pingpolls/svelte-adapter-bun-isr](https://raw.githubusercontent.com/pingpolls/svelte-adapter-bun-isr/refs/heads/main/benchmark/throughput-v107.webp)

| Mode | svelte-adapter-bun | this adapter | Improvement |
|---|---|---|---|
| SSR, no caching | 8,975 req/s · 57.04ms avg | 14,587 req/s · 35.10ms avg | 1.6x throughput, 1.6x lower latency |
| SSG, prerendered | 70,627 req/s · 7.25ms avg | 137,339 req/s · 3.73ms avg | 1.9x throughput, 1.9x lower latency |
| ISR, prerender = auto | — | 137,362 req/s · 3.73ms avg | matches static prerender speed |

> The SSR gap comes almost entirely from built-in clustering, not raw per-core speed. Pinned to 1 CPU, this adapter does 8,419 req/s · 60.14ms avg — essentially the same as svelte-adapter-bun's 8,975 req/s on the same single-core setup. The 1.6x SSR gap above only shows up at 2 CPUs, where `cluster: true` (default) spawns one worker per core via Bun's `reusePort` and throughput scales accordingly; pin the count with the `CPUS` env var if needed.

## Contributing

See [GitHub](https://github.com/pingpolls/svelte-adapter-bun-isr).

## License

MIT
