# SvelteKit Bun Adapter ISR 

A SvelteKit adapter for Bun that supports:

- Bun server output
- Static client asset serving
- Prerendered page serving
- Optional precompression at build time
- Incremental Static Regeneration style revalidation for prerendered routes
- Optional `hooks.server` websocket export bundling
- Optional multi-core process clustering via bun's native `reusePort`

## What this adapter does

This adapter builds a Bun-hosted SvelteKit app with a generated `build/` output that contains:

- `client/` for client assets
- `prerendered/` for prerendered pages
- `server/` for the SvelteKit server bundle and manifest
- `app.js` as the actual Bun server (present when `cluster` is enabled)
- `index.js` as the Bun entry point — either the server directly (`cluster: false`), or a supervisor that spawns `app.js` across worker processes (`cluster: true`, the default)

At runtime, the generated server:

1. Serves client assets directly from Bun when enabled
2. Serves prerendered pages directly from Bun when enabled
3. Falls back to dynamic SSR for everything else
4. Keeps a small in-memory ISR cache for routes configured with `revalidate`

## Installation

```bash
bun add @pingpolls/svelte-adapter-bun-isr
```

## Usage

In `vite.config.ts`

```ts
import adapter from '@pingpolls/svelte-adapter-bun-isr';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({
        out: 'build',
        serveAssets: true,
        precompress: true,
        envPrefix: '',
        idleTimeout: 10,
        websockets: true,
        cluster: true
      }),
		}),
	],
});
```

or in `svelte.config.ts`:

```ts
import adapter from '@pingpolls/svelte-adapter-bun-isr';

export default {
  kit: {
    adapter: adapter({
      out: 'build',
      serveAssets: true,
      precompress: true,
      envPrefix: '',
      idleTimeout: 10,
      websockets: true,
      cluster: true
    })
  }
};
```

Then build and run:

```bash
bun run build
bun run build/index.js
```

`build/index.js` is always the right entry point regardless of `cluster` — it's either the server itself or the supervisor in front of it.

## Adapter options

### `out`
Output directory for generated files.

Default: `build`

### `serveAssets`
Serve client assets and prerendered pages from Bun.

Set this to `false` if a reverse proxy or CDN serves those files instead.

Default: `true`

### `precompress`
Generate compressed variants of assets during build.

Creates:

- `.gz`
- `.br`
- `.zst` when available in the Bun runtime

Default: `true`

### `envPrefix`
Prefix for runtime environment variables read by the generated Bun server.

Supported runtime variables:

- `HOST`
- `PORT`
- `SOCKET_PATH`
- `IDLE_TIMEOUT`

When `cluster` is enabled, the supervisor (`index.js`) also reads two runtime variables under the same prefix:

- `CPUS`
- `BUN_BINARY`

See the `cluster` option below for what they control.

Default: `''`

Example:

```js
adapter({
  envPrefix: 'APP_'
});
```

Then the runtime server reads:

- `APP_HOST`
- `APP_PORT`
- `APP_SOCKET_PATH`
- `APP_IDLE_TIMEOUT`
- `APP_CPUS`
- `APP_BUN_BINARY`

### `idleTimeout`
Default idle timeout in seconds for `Bun.serve`.

Runtime env still wins if the prefixed `IDLE_TIMEOUT` is set.

Default: `10`

### `cluster`
Emit a `build/index.js` supervisor that spawns `build/app.js` across multiple worker processes, each binding the same port with `reusePort: true` (`SO_REUSEPORT`) so the kernel load-balances connections across processes/cores.

Worker count and binary are resolved at runtime, not at build time:

- **Worker count** — `${envPrefix}CPUS` env var if set (must be a positive integer), otherwise `navigator.hardwareConcurrency`, otherwise `os.cpus().length`, otherwise `1`. Resolved on the machine that runs the server, not the machine that built it, so a CI build with fewer cores than production still scales correctly.
- **Bun binary** — `${envPrefix}BUN_BINARY` env var if set (path or a name resolved via `PATH`), otherwise `process.execPath` (the exact binary the supervisor is currently running under).

If a worker crashes, the supervisor respawns it automatically. `SIGINT`/`SIGTERM` sent to the supervisor are forwarded to all workers for a clean shutdown.

Set this to `false` if something else already manages process count — PM2 `-i max`, k8s replicas/HPA, fly.io machines-per-core, etc. With `cluster: false`, `build/index.js` is the server directly (no `app.js`, no spawning), the same as running a single worker. Running the supervisor *and* an external process manager at the same time multiplies your worker count by both — pick one.

Default: `true`

### WebSockets

Bun WebSockets are wired up through two pieces:

1. an `export const websocket` in `src/hooks.server.ts` — this is the
   `Bun.WebSocketHandler` (`open`/`message`/`close`/`drain`) passed straight
   into `Bun.serve`. The adapter detects and bundles this export at build
   time (set `websockets: false` to skip it for plain HTTP apps).
2. a call to `event.platform.server.upgrade(event.platform.request)` at the
   point you want to upgrade the connection — either globally in `handle`,
   or per-route in a `+server.ts`. This is the actual trigger; without it
   the request just resolves as a normal HTTP response.

#### Global upgrade via `hooks.server.ts`

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
  open(ws) {
    ws.send('connected');
  },
  message(ws, message) {
    ws.send(message); // echo
  },
};
```

#### Per-route upgrade via `+server.ts`

```ts
// src/routes/ws/+server.ts
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ platform }) => {
  const upgraded = platform?.server?.upgrade(platform?.request);
  return upgraded ? new Response(null, { status: 101 }) : new Response('Upgrade failed', { status: 500 });
};
```

Either pattern works because ISR/static-asset requests never reach `server.respond()` — only the dynamic-SSR fallback (step 4 in "Runtime serving order") does, and that's exactly where `platform.server`/`platform.request` are injected.

#### Types

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

Bun's pub/sub API works the same way as everywhere else — `ws.subscribe('room')` / `ws.publish(...)` inside the `websocket` handlers, or `event.platform.server.publish('room', data)` from any hook or `+server.ts`.

### Important

`revalidate` only applies to prerendered routes.

Use `export const prerender = 'auto'`, not `true`.

Why:

- `true` fully removes the route from the SSR manifest
- the adapter uses `server.respond()` at runtime to regenerate HTML
- if the route is stripped from the manifest, runtime regeneration cannot match it

If you use `prerender = true`, the adapter warns and ISR becomes a no-op for that route.

## How ISR works

For each prerendered path with a positive `revalidate` value:

- the adapter records the path in `manifest.js`
- the generated Bun server starts an interval timer
- when the timer fires, the server calls `server.respond()` for that route
- successful HTML responses are cached in memory
- later requests return the cached HTML instead of the build-time file

Notes:

- the cache is in-memory only
- cache contents reset on process restart
- stale build-time content still works as fallback
- under `cluster: true`, each worker process keeps its own independent ISR cache — this is harmless (worst case is duplicated regeneration work across workers) but worth knowing if you need revalidation timing to line up exactly across cores

## Precompression behavior

When `precompress` is enabled, the adapter scans:

- client assets
- prerendered output

It skips files that are already compressed or are not worth recompressing, including:

- `.gz`
- `.br`
- `.zst`
- images
- fonts
- media archives

Compression variants are negotiated at runtime using `Accept-Encoding`.

## Runtime serving order

The generated Bun server resolves requests in this order:

1. Static client assets
2. ISR cached HTML
3. Prerendered pages
4. Dynamic SSR

## Websocket support

If `websockets` is enabled and `src/hooks.server.ts` or `src/hooks.server.js` exports `websocket`, the adapter bundles that export and passes it to `Bun.serve`.

Example:

```ts
export const websocket = {
  async message(ws, message) {
    ws.send(message);
  }
};
```

## File layout produced by the adapter

```text
build/
  client/
  prerendered/
  server/
    manifest.js
    index.js
    hooks.js   # only when websocket export is bundled
    chunks/
    entries/
    nodes/
    .vite/
  app.js       # only when cluster is enabled — the actual server
  index.js     # supervisor when cluster is enabled, otherwise the server
```

## Caveats

- ISR cache is memory-only, and per-process under `cluster: true`
- ISR depends on prerendered routes being kept in the SSR manifest
- `prerender = 'auto'` is required for ISR routes
- precompressed variants are best effort for `zst`
- if `serveAssets` is disabled, static asset serving is expected elsewhere
- `cluster: true` and an external process manager both managing worker count will multiply concurrency — use one or the other

## Development notes

This adapter uses:

- Node.js file system and path helpers
- Bun build APIs
- Bun's process spawning APIs for clustering
- SvelteKit adapter APIs
- generated manifest metadata for prerendered paths and ISR revalidate mapping

## Contributing

See our [Github](https://github.com/pingpolls/svelte-adapter-bun-isr)

## License

MIT
