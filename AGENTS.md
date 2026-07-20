# AGENTS.md

## Project overview

This repository contains a SvelteKit adapter for Bun with ISR-style revalidation, asset serving, precompression, and optional websocket wiring.

## What this code does

- Builds a Bun-compatible SvelteKit server bundle
- Copies client assets and prerendered pages into the output directory
- Optionally precompresses assets with gzip, brotli, and best-effort zstd
- Generates a manifest containing prerendered paths and ISR revalidate values
- Creates a Bun entry point that serves:
  - static client assets
  - ISR-cached HTML
  - prerendered HTML
  - dynamic SSR fallback
- Optionally bundles `hooks.server`'s `websocket` export

## Important behavior

- ISR only works for prerendered routes
- Routes must use `export const prerender = 'auto'`
- `export const prerender = true` strips the route from the SSR manifest and breaks runtime regeneration
- ISR cache is in-memory only and resets on restart
- `serveAssets` can be disabled when a CDN or reverse proxy handles static files
- `websockets` should be disabled if the app does not use a `websocket` export

## Files to pay attention to

- `adapter.ts` or the main adapter entry file
- generated `manifest.js`
- generated Bun entry point
- route files that define `config.revalidate`
- any `src/hooks.server.ts` or `src/hooks.server.js` websocket export

## Safe edit checklist

Before changing behavior, verify:

- output directory structure still matches the generated runtime imports
- prerendered route paths are still collected correctly
- route config merges still resolve to the final `revalidate` value
- compression negotiation still prefers brotli, then zstd, then gzip
- asset serving still works when `base` is configured
- websocket bundling still excludes SvelteKit internal virtual modules
- runtime imports still match the generated file names

## Testing ideas

- Build a sample SvelteKit app with prerendered and non-prerendered routes
- Verify a prerendered route with `revalidate` gets cached and updated
- Verify a route with `prerender = true` logs the ISR warning
- Verify static assets are served from the Bun runtime
- Verify compressed variants are selected when `Accept-Encoding` allows them
- Verify websocket bundling works only when an export exists
- Verify the adapter still works when `serveAssets` is disabled

## Implementation notes

- The adapter uses `builder.routes` to resolve merged route config
- The adapter writes a temporary build directory before copying files into the final output
- The runtime Bun server uses `server.respond()` for SSR and ISR regeneration
- Compression is done at build time so runtime serving stays simple

## Style guidance

- Keep route handling deterministic
- Prefer explicit file checks before copying or reading
- Keep runtime imports aligned with generated filenames
- Preserve compatibility with Bun APIs used here
- Avoid breaking changes to the generated `build/` structure unless necessary

## When editing

If you change any of these, update the README too:

- adapter options
- runtime environment variables
- generated output structure
- ISR behavior
- websocket support
- compression behavior

## Notes for maintainers

This project is intended to stay easy to reason about from a single file adapter implementation. Keep changes small, well documented, and reflected in both the runtime behavior and the README.
