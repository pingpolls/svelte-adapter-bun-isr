# GENTASK.md — Project Handover

Created At 2026-07-19T18:30:00Z
Updated At 2026-07-19T20:45:00Z

## Project Overview
This project is `@pingpolls/svelte-adapter-bun-isr`, a custom SvelteKit adapter for Bun that implements Incremental Static Regeneration (ISR) for specific routes. It follows patterns from `@sveltejs/adapter-node` and `sv-adapter-bun`.

## Current State
**Functional.** The adapter builds, runs, and passes all 4 tests. It is ready for npm publishing via `bun run release`.

### What Works
- SvelteKit `adapt()` step: copies client assets, prerendered pages, server code, generates manifest + ISR server entry point
- Runtime ISR caching: reads `config.revalidate` from route modules, caches HTML responses for the specified duration
- Static prerendered pages served directly from disk
- Client assets served with immutable cache headers for `/immutable/` paths
- Bun.serve() with proper `server.init()` and `server.respond()` platform integration
- npm package build: `bun build` bundles to `dist/index.js` + `dist/index.d.ts`

### Test Results
```
bun test — 4 pass, 0 fail
```
- `build produces output` — verifies `bunx vite build` succeeds and `build/index.js` exists
- `ISR: dynamic page returns 200 with content` — fetches `/with-isr`, checks 200 + HTML content
- `static page returns prerendered content` — fetches `/without-isr`, checks 200 + HTML content
- `unknown route returns 404` — fetches `/nonexistent-page`, checks 404

## Architecture

### Adapter (`src/index.ts`)
The adapter implements the SvelteKit `Builder` API:
1. `adapt(builder)` — orchestrates the build output
2. Copies client/prerendered assets via `builder.writeClient()` / `builder.writePrerendered()`
3. Writes server code to temp dir, generates route manifest with `builder.generateManifest()`
4. Generates runtime `index.js` that:
   - Creates `new Server(manifest)` and calls `server.init({ env, read })`
   - Implements ISR cache (`Map<pathname, {html, timestamp, revalidate}>`)
   - Serves static assets, prerendered pages, then falls through to `server.respond()`
   - Caches 200 responses from routes with `config.revalidate` set

### Fixtures (`fixtures/`)
A minimal SvelteKit project used for testing:
- `vite.config.ts` — imports adapter from `../src/index.ts`, configures sveltekit + tailwind
- `src/lib/server/db.ts` — SQLite via `bun:sqlite` (server-only, `$lib/server/` convention)
- `src/routes/with-isr/+page.server.ts` — dynamic route with `config: { revalidate: 5 }`, loads todos from DB
- `src/routes/without-isr/+page.ts` — static prerendered route with `prerender = true`
- `src/routes/api/todos/+server.ts` — API endpoint for CRUD operations

### Key SvelteKit Constraints
- `revalidate` is NOT a valid top-level export in `+page.server.ts` — must go inside `export const config = { revalidate: N }`
- `$lib/server/` imports are server-only and excluded from client builds
- `prerender = true` pages cannot use `$lib/server/` imports (not available during prerender)
- `sveltekit()` Vite plugin returns `Promise<Plugin[]>` — requires `as PluginOption` cast when root and fixtures have different Vite versions

## Issues / Known Limitations
1. **Vite type mismatch** — Root and fixtures have different Vite versions. `sveltekit()` return type requires `as PluginOption` cast in `fixtures/vite.config.ts:19`.
2. **ISR detection relies on manifest internals** — `getRevalidateForPath()` accesses `manifest._.routes` and `manifest._.nodes[]` which are internal SvelteKit structures. May break on SvelteKit major version bumps.
3. **Single-process ISR cache** — The `Map`-based cache is in-memory only. Multiple Bun workers or restarts lose state.

## Package Configuration
```json
{
  "name": "@pingpolls/svelte-adapter-bun-isr",
  "version": "0.1.0",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "peerDependencies": { "@sveltejs/kit": ">=2.0.0" },
  "scripts": {
    "build": "rm -rf dist && bun build ./src/index.ts --outdir ./dist --target bun --minify && bun x tsc --project tsconfig.build.json",
    "test": "bun test",
    "release": "bun run build && bun test && bunx --bun npm publish --access public"
  }
}
```

## Available Skills
`biome-developer`, `brand-guidelines`, `bun`, `customize-opencode`, `doc-coauthoring`, `find-skills`, `gentask`, `kysely`, `module-architecture-svelte`, `postgres-pro`, `shadcn-svelte`, `skill-creator`, `svelte-code-writer`, `svelte-core-bestpractices`, `tailwind-design-system`, `taos-tailwind4`, `tdd`, `template-skill`, `tiptap`, `typescript-advanced-types`, `typescript-expert`, `wrangler`.

---

## Instructions for the AI Model

You are receiving this GENTASK.md from a user who wants you to generate a PROMPT.md for an agentic coding harness (Claude Code, Cursor, etc.). Follow these steps:

1. **Read GENTASK.md carefully.** Understand the project state, issues, and goals.
2. **Generate PROMPT.md.** Once you have all the information you need, create a comprehensive, task-by-task PROMPT.md that the user can copy-paste into their agentic harness. Each task should be:
   - Clearly scoped and actionable
   - Include verification steps (commands to run, checks to perform)
   - Reference specific files and code locations
   - Follow the project's existing conventions and patterns
3. **Include a verification checklist** at the end of PROMPT.md so the user can confirm each task was completed correctly.

Please confirm these goals, issues, and the available skills list are accurate before proceeding. The next step is to generate PROMPT.md based on these details.
