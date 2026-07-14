# @pingpolls/svelte-adapter-bun-isr

A SvelteKit adapter designed for Bun environments that provides built-in Incremental Static Regeneration (ISR) support.

## Installation

```bash
bun add -D @pingpolls/svelte-adapter-bun-isr
```

## Usage

Add the adapter to your `svelte.config.js`:

```javascript
import adapter from '@pingpolls/svelte-adapter-bun-isr';

export default {
  kit: {
    adapter: adapter({
      out: 'build',
      revalidateToken: process.env.REVALIDATE_TOKEN, // Enables POST /__isr/revalidate
    }),
  },
};
```

## Features

*   **Automatic ISR Support:** Define `export const revalidate = <seconds>` in your SvelteKit routes (`+page.server.ts`). The adapter automatically schedules proactive re-renders for these routes.
*   **On-Demand Revalidation:** You can manually trigger a rebuild for a specific path using a POST request to `/__isr/revalidate?path=/your/route` (requires a valid `x-revalidate-token` header).
*   **Warm-on-Boot:** All ISR-eligible paths are rendered and cached once when the Bun server starts.

## Configuration Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `out` | `string` | `'build'` | The output directory for the generated SvelteKit files. |
| `revalidateToken` | `string` | `undefined` | A token required to authenticate on-demand revalidation requests. |
| `precompress` | `boolean` | `false` | Enables pre-compression of static assets. |

## ISR Convention

To enable ISR on a route, export `revalidate` in your `+page.server.ts` or `+layout.server.ts` files:

```ts
// src/routes/blog/[slug]/+page.server.ts
export const revalidate = 900; // Rebuild every 900 seconds (15 minutes)
```

## V1 Limitations

*   **Single-Process Cache:** The current implementation uses an in-memory `Map` for caching. Cache coordination across multiple running processes or instances is not supported.
*   **Path-Only Caching:** The cache keys are based solely on the pathname. Queries parameters in the URL are ignored for caching purposes.

## Development

```bash
bun run build && bun test
```