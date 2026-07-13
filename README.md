# @pingpolls/svelte-adapter-bun-isr

A SvelteKit adapter that wraps Bun's native server (`Bun.serve`) and provides Incremental Static Regeneration (ISR) support driven by a per-route `revalidate` export.

## Installation

Install the adapter via npm:

```bash
bun add -D @pingpolls/svelte-adapter-bun-isr
```

## Configuration

Use the adapter in your `svelte.config.js` or equivalent configuration file:

```javascript
// svelte.config.js
import adapter from '@pingpolls/svelte-adapter-bun-isr';

export default {
  kit: {
    adapter: adapter({
      out: 'build',
      revalidateToken: process.env.REVALIDATE_TOKEN, // Optional: enables POST /__isr/revalidate
      // precompress: true, // Optional: Enable compression
    }),
  },
};
```

### Options
* `out` (string, optional): Directory where the server bundle will be output (default: `'build'`).
* `revalidateToken` (string, optional): A token used to guard the on-demand revalidation endpoint (`x-revalidate-token` header).

## Features

### Incremental Static Regeneration (ISR)
Define a `revalidate` constant in your SvelteKit route files (`+page.server.ts`, etc.). This value specifies how long (in seconds) the page content should be cached before a proactive re-render is triggered.

```ts
// src/routes/blog/[slug]/+page.server.ts
export const prerender = true;
export const revalidate = 900; // Cache for 15 minutes
```

The adapter automatically scans your routes, collects these `revalidate` values, and schedules a background task in the generated entrypoint to proactively re-render pages before the cache expires.

### On-Demand Revalidation
You can manually force a re-render of an ISR route at any time using the dedicated endpoint:

**POST** `/__isr/revalidate?path=/blog/foo`
*   **Success:** 200 OK
*   **Unauthorized:** 401 (if `x-revalidate-token` is missing or incorrect)

## v1 Limitations

*   **Single-Process Cache:** The cache is held in memory and is only valid for the lifetime of the running process. It does not support multi-instance or multi-server deployments.
*   **Path-Only Caching:** Cache keys are based solely on the URL pathname. Query parameters do not result in separate cache entries.

## Usage

Run your application using the generated entrypoint:

```bash
REVALIDATE_TOKEN=your-secret bun run build/index.js
```