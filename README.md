# @pingpolls/svelte-adapter-bun-isr

A SvelteKit adapter for Bun that supports:

- Bun server output
- Static client asset serving
- Prerendered page serving
- Optional precompression at build time
- Incremental Static Regeneration style revalidation for prerendered routes
- Optional `hooks.server` websocket export bundling

## What this adapter does

This adapter builds a Bun-hosted SvelteKit app with a generated `build/` output that contains:

- `client/` for client assets
- `prerendered/` for prerendered pages
- `server/` for the SvelteKit server bundle and manifest
- `index.js` as the Bun entry point

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

In `svelte.config.js`:

```js
import adapter from '@pingpolls/svelte-adapter-bun-isr';

export default {
  kit: {
    adapter: adapter({
      out: 'build',
      serveAssets: true,
      precompress: true,
      envPrefix: '',
      idleTimeout: 10,
      websockets: true
    })
  }
};
```

Then build and run:

```bash
bun run build
bun run build/index.js
```

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

### `idleTimeout`
Default idle timeout in seconds for `Bun.serve`.

Runtime env still wins if the prefixed `IDLE_TIMEOUT` is set.

Default: `10`

### `websockets`
Bundle `src/hooks.server.ts` or `src/hooks.server.js` when it exports `websocket`, then wire it into `Bun.serve`.

Default: `true`

## ISR route config

Use SvelteKit's route config in `+page.server.ts`, `+page.ts`, or layout equivalents.

Example:

```ts
import type { Config } from '@pingpolls/svelte-adapter-bun-isr';

export const prerender = 'auto';
export const config: Config = {
  revalidate: 5
};
```

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
  index.js
```

## Caveats

- ISR cache is memory-only
- ISR depends on prerendered routes being kept in the SSR manifest
- `prerender = 'auto'` is required for ISR routes
- precompressed variants are best effort for `zst`
- if `serveAssets` is disabled, static asset serving is expected elsewhere

## Development notes

This adapter uses:

- Node.js file system and path helpers
- Bun build APIs
- SvelteKit adapter APIs
- generated manifest metadata for prerendered paths and ISR revalidate mapping

## License

Add the appropriate project license here.
