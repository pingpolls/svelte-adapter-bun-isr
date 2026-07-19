# PROMPT.md — svelte-adapter-bun-isr

> **Project:** `svelte-adapter-bun-isr`
> **Goal:** Build a custom SvelteKit adapter that uses Bun as the runtime/build engine and manually implements Incremental Static Regeneration (ISR), replicating the behavior of the official `@sveltejs/adapter-vercel` ISR feature.
> **Target Harness:** Claude Code / Cursor / Pi Agent (agentic coding harness)
> **Package Manager / Runtime:** Bun (`bun` / `bunx`) — do NOT use npm or node.

---

## 0. Environment Setup & Conventions

- All package management, scripts, and tests run via `bun`/`bunx`.
- TypeScript is the default language for all source files.
- Use the `bun` skill for any Bun-specific API questions (SQLite, `Bun.serve`, `bun:test`).
- Use the `svelte-code-writer` and `svelte-core-bestpractices` skills when authoring `.svelte` files.
- Use the `module-architecture-svelte` skill to keep the adapter, server, and fixtures cleanly separated.
- Use the `tdd` skill as the workflow backbone for the test spec in Task 7.
- Use `biome-developer` conventions for formatting (run `bunx biome check` if a biome config exists; otherwise default to `bunx prettier --check` or `bun fmt`).

**Before any coding**, inspect the current repo:
```bash
ls -la
cat package.json
cat svelte.config.js   # or .ts
cat tsconfig.json
cat README.md          # if present
```
Note the existing library skeleton so new files follow the established structure (e.g. `src/`, `index.js`/`.ts` entry, `package.json` `exports` field).

---

## Task 1 — Scaffold a SvelteKit Project in `fixtures/`

**Scope:** Create a minimal but real SvelteKit application inside `fixtures/` that will be used as the integration test target for the adapter.

**Steps:**
1. Create `fixtures/` at the repo root (if missing).
2. Inside `fixtures/`, create a SvelteKit project skeleton manually (avoid interactive `npm create`, since we use Bun):
   - `fixtures/package.json` with `dev`, `build`, `preview` scripts and deps: `svelte`, `svelte-check`, `@sveltejs/kit`, `@sveltejs/vite-plugin-svelte`, `vite`, `typescript`, and a local reference to the adapter (`"svelte-adapter-bun-isr": "file:.."` or a workspace link).
   - `fixtures/svelte.config.js` that imports the custom adapter:
     ```js
     import adapter from 'svelte-adapter-bun-isr';
     export default {
       kit: { adapter: adapter() }
     };
     ```
   - `fixtures/vite.config.ts` using `@sveltejs/kit/vite`.
   - `fixtures/tsconfig.json` extending `./.svelte-kit/tsconfig.json`.
   - `fixtures/src/app.html` (standard SvelteKit template with `%sveltekit.head%` / `%sveltekit.body%`).
3. Install deps with `bun install` inside `fixtures/`.

**Verification:**
```bash
cd fixtures && bun install
bunx svelte-kit sync   # generates .svelte-kit
ls .svelte-kit         # should list generated tsconfig, types, etc.
```
✅ `bun install` succeeds with no peer-dependency errors.
✅ `.svelte-kit/` is generated.

---

## Task 2 — Implement the Custom SvelteKit Adapter (Bun build engine)

**Scope:** Implement the adapter entry point (referenced by `fixtures/svelte.config.js`) that builds the SvelteKit app into a Bun-servable output (e.g. `.svelte-kit` output or a custom `build/` dir) and wires up ISR.

**Steps:**
1. Locate/define the adapter entry at the repo root (e.g. `src/index.ts` or `index.js` per `package.json` `exports`/`main`).
2. Implement the SvelteKit `Adapter` interface:
   - `name: 'svelte-adapter-bun-isr'`
   - `async adapt({ build, files, utils, prerendered, server, routes })`
   - Copy the SvelteKit build output (`build/`, `prerendered/`, `server/`) into a Bun-servable layout.
   - Emit a Bun server entry (e.g. `.svelte-kit/bun-server.js` or `build/server.js`) that:
     - Uses `Bun.serve` to handle requests.
     - Serves prerendered static pages directly.
     - For routes flagged with ISR, caches the rendered response and revalidates after `revalidate` seconds.
3. Read route ISR config from `routes`/`server` manifest — specifically `export const revalidate` and `export const prerender` from `+page.ts` files.
4. Export a default factory function `adapter(options?)` returning the adapter object.

**Verification:**
```bash
bun run build         # from repo root, if a build script exists
bunx tsc --noEmit     # type-check the adapter
```
✅ Adapter file type-checks with no errors.
✅ Adapter is importable: `bun -e "import a from './src/index.ts'; console.log(typeof a)"` (or `.js` per entry).

---

## Task 3 — Define the Two Routes: `/with-isr` and `/without-isr`

**Scope:** Create the two demo pages inside `fixtures/src/routes/`.

**Steps:**
1. Create `fixtures/src/routes/with-isr/+page.ts`:
   ```ts
   export const prerender = true;
   export const revalidate = 5;
   ```
   And `fixtures/src/routes/with-isr/+page.svelte` that renders a todo list (fetched from SQLite).
2. Create `fixtures/src/routes/without-isr/+page.ts`:
   ```ts
   export const prerender = true;
   ```
   And `fixtures/src/routes/without-isr/+page.svelte` rendering the same todo list.
3. Both pages load todos from the shared SQLite DB (`fixture.sqlite`) via a `+page.server.ts` `load` function or an API route.
4. Optional: a shared component `fixtures/src/lib/TodoList.svelte` to avoid duplication.

**Verification:**
```bash
cd fixtures && bunx svelte-kit sync && bunx svelte-check
```
✅ `svelte-check` passes with no errors.
✅ Both routes exist in the generated manifest.

---

## Task 4 — Wire SQLite (`fixture.sqlite`) for a Todo List

**Scope:** Integrate Bun's native SQLite (`bun:sqlite`) to back a simple todo list, simulating dynamic data behind ISR.

**Steps:**
1. Create `fixtures/src/lib/db.ts` using `bun:sqlite`:
   ```ts
   import { Database } from 'bun:sqlite';
   export const db = new Database('fixture.sqlite', { create: true });
   db.run('CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, text TEXT)');
   export function addTodo(text: string) { db.run('INSERT INTO todos (text) VALUES (?)', [text]); }
   export function getTodos() { return db.query('SELECT * FROM todos').all(); }
   export function clearTodos() { db.run('DELETE FROM todos'); }
   ```
2. Expose:
   - A `+page.server.ts` `load` returning `getTodos()` for both routes.
   - An API/action route (e.g. `fixtures/src/routes/api/todos/+server.ts`) with a `POST` handler calling `addTodo` (used by the test to add 3 items).
3. Ensure `fixture.sqlite` is created relative to the running server cwd.

**Verification:**
```bash
cd fixtures && bun -e "import {addTodo,getTodos,clearTodos} from './src/lib/db.ts'; clearTodos(); addTodo('a'); console.log(getTodos()); clearTodos();"
```
✅ Prints one todo, then empty after clear.
✅ No `bun:sqlite` import errors.

---

## Task 5 — Implement ISR Caching & Revalidation Logic in the Server

**Scope:** In the Bun server entry emitted by the adapter, implement the ISR cache so that `/with-isr` revalidates after 5s while `/without-isr` stays frozen at prerender time.

**Steps:**
1. In the server entry, maintain an in-memory `Map<route, { html, timestamp }>`.
2. On request to a prerendered+ISR route:
   - If no cache entry OR `Date.now() - timestamp > revalidate * 1000`, render fresh (call SvelteKit `render`/`server.render`) and store.
   - Otherwise serve cached HTML.
3. On request to a prerender-only route:
   - Always serve the prerendered static HTML (never re-render).
4. Make `revalidate` per-route configurable, sourced from the route manifest.

**Verification:**
```bash
# Manual smoke (after Task 6 build):
cd fixtures && bun run build && bun .svelte-kit/bun-server.js &
curl -s localhost:3000/with-isr | grep -c 'todo'   # initial
curl -s -X POST localhost:3000/api/todos -d '{"text":"x"}' -H 'content-type: application/json'
sleep 6
curl -s localhost:3000/with-isr | grep -c 'todo'   # should reflect new item
curl -s localhost:3000/without-isr | grep -c 'todo' # should remain initial
kill %1
```
✅ `/with-isr` updates after revalidate window; `/without-isr` does not.

---

## Task 6 — Configure Routes & Adapter for ISR Build

**Scope:** Ensure `svelte.config.js` + adapter options correctly produce an ISR-capable build, and document the config.

**Steps:**
1. Confirm `fixtures/svelte.config.js` uses the custom adapter with any ISR options (e.g. `adapter({ port: 3000 })`).
2. Add `prerender` entries if needed in `fixtures/src/routes/+layout.ts`:
   ```ts
   export const prerender = true;
   ```
3. Verify the build output contains both a static prerendered `without-isr` HTML and a server-rendered `with-isr` handler wired to the ISR cache.
4. Add a short `fixtures/README.md` (only if requested; otherwise skip per repo conventions) describing how to run.

**Verification:**
```bash
cd fixtures && rm -rf build .svelte-kit/output && bun run build
ls build               # or .svelte-kit output dir
grep -rl "revalidate" build/  # ISR config present
```
✅ Build completes without errors.
✅ Output includes both route handlers and prerendered files.

---

## Task 7 — Write the Comprehensive `bun test` Spec

**Scope:** Create `fixtures/test/isr.test.ts` (or `*.spec.ts`) covering the full ISR lifecycle described in the goals.

**Test flow (use `bun test` + `Bun.spawn` for server lifecycle):**
1. **Build success:** Run `bun run build` (or call adapter programmatically); assert exit 0 and output exists.
2. **Start server:** Spawn `bun .svelte-kit/bun-server.js` (or equivalent). Wait for port.
3. **Initial empty check:** `GET /with-isr` and `/without-isr` → assert todo list empty (0 items).
4. **Add 3 items:** `POST /api/todos` three times with distinct texts.
5. **Immediate re-check:** `GET` both pages → assert still 0 items (cache not yet expired; the spec says "Verification of both pages being empty (at initial state check)").
6. **Wait 10s:** `await new Promise(r => setTimeout(r, 10000))` (exceeding `revalidate=5`).
7. **ISR hit:** `GET /with-isr` → assert 3 items present.
8. **Prerender cache:** `GET /without-isr` → assert 0 items (frozen prerender).
9. **Stop server:** Kill the spawned process; assert port closed.
10. **Rebuild & verify:** Run `bun run build` again, restart server, `GET /with-isr` → assert 3 items persist from SQLite.
11. **Cleanup:** `clearTodos()`, delete `fixture.sqlite`, remove `build/`/`.svelte-kit/output` dirs.

**Verification:**
```bash
cd fixtures && bun test
```
✅ All test cases pass sequentially in one run.
✅ No leftover `fixture.sqlite` or build artifacts after cleanup (assert in test).

---

## Task 8 — Final Project Cleanup & Consistency

**Scope:** Ensure the whole repo is consistent, formatted, and the adapter is correctly published/linked.

**Steps:**
1. Run `bunx biome check .` (or `bun fmt`) from repo root; fix issues.
2. Ensure root `package.json` `exports`/`main` point to the adapter entry.
3. Ensure `fixtures/package.json` references the adapter so `bun install` links it.
4. Re-run full test suite once more to confirm green.

**Verification:**
```bash
bunx biome check .
cd fixtures && bun test
```
✅ Lint clean.
✅ Tests green end-to-end.

---

## Final Verification Checklist

- [ ] `fixtures/` contains a complete SvelteKit project (package.json, svelte.config.js, vite.config.ts, src/).
- [ ] Root adapter builds SvelteKit output via Bun and emits a `Bun.serve` server entry.
- [ ] Routes `/with-isr` (`prerender=true`, `revalidate=5`) and `/without-isr` (`prerender=true`) exist.
- [ ] `fixture.sqlite` backed by `bun:sqlite` supports add/get/clear todos.
- [ ] ISR logic: `/with-isr` revalidates after 5s; `/without-isr` stays at prerender snapshot.
- [ ] `bun test` spec covers: build, start, initial empty, add 3, immediate empty, wait 10s, ISR shows 3, prerender shows 0, stop, rebuild shows 3, cleanup.
- [ ] All tests pass with `bun test`.
- [ ] Build artifacts and SQLite records are cleaned up after tests.
- [ ] Repo passes lint/format check.
- [ ] Adapter is correctly imported by `fixtures/svelte.config.js` and type-checks.

If every box is checked, the project is complete and ready for use.