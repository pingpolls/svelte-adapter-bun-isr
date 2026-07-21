/**
 * End-to-end ISR / no-ISR revalidation test for the `fixtures` SvelteKit app.
 *
 * Run with:  bun test fixtures/tests/isr.e2e.test.ts
 * (run from the repo root, or `cd fixtures && bun test tests/isr.e2e.test.ts`)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ISR SEMANTICS: stale-while-revalidate, not interval-based background
 * regeneration. There is no worker ticking on a timer — freshness is only
 * checked when a request actually hits an ISR-configured path:
 *
 *   - age <= revalidate  -> serve cached HTML, nothing else happens.
 *   - age >  revalidate  -> serve the CURRENT (stale) cached/build-time HTML
 *                           immediately, and fire an unawaited background
 *                           regeneration. The refreshed content is only
 *                           observable on a SUBSEQUENT request, once that
 *                           background regen resolves.
 *
 * Practical effect on this test: once a revalidate window has elapsed, the
 * *first* request after that point is expected to still return the stale
 * value (it's also the request that triggers the regen), and a *follow-up*
 * request is expected to return the fresh value. See `assertSwrTransition`
 * below — every assertion that crosses a route's revalidate window uses it
 * instead of a single fetch+expect.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * ASSUMPTIONS (the fixtures/package.json + route files were not inspectable
 * from this environment — they were empty/not present). Adjust the CONFIG
 * block below if any of these don't match the real project:
 *
 *   - `package.json` has a `"build"` script that runs the SvelteKit build
 *     (adapter-node output written to `fixtures/build/`).
 *   - `package.json` has a `"start"` script that boots the built server
 *     (e.g. `bun run build/index.js`), reading `PORT` from env, defaulting
 *     to 3000 if `PORT` isn't set.
 *   - The initial DB migration is performed by running
 *     `src/scripts/prep.ts` directly with bun (creates the sqlite schema,
 *     no seed rows).
 *   - `/no-isr/server.json` exists as the no-isr counterpart of `/isr/server.json`
 *     (the dir listing only showed `/isr/server.json/+server.ts`, but the test
 *     spec explicitly checks `/no-isr/server.json`, so it's assumed to exist
 *     with the same JSON contract).
 *   - The todos table backing every route is shared/global (not scoped
 *     per-route) — a single POST to /api/todos is expected to eventually
 *     surface everywhere, just at different revalidation cadences.
 *   - `/no-isr/*` routes are prerendered WITHOUT a `revalidate` config
 *     (frozen at build time, only change after a rebuild) — that's why
 *     they're expected to stay at 0 for the entire lifetime of the first
 *     server process, regardless of ISR window checks.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

// ── CONFIG ──────────────────────────────────────────────────────────────
const FIXTURES_DIR = path.join(process.cwd(), "fixtures");
const DB_PATH = path.join(FIXTURES_DIR, "db.sqlite");
const BUILD_DIR = path.join(FIXTURES_DIR, "build");
const PORT = Number(process.env.TEST_PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;

const PREP_CMD = ["bun", "run", "prepare"];
const MIGRATE_CMD = ["bun", "src/scripts/prep.ts"];
const BUILD_CMD = ["bun", "run", "build"];
const START_CMD = ["bun", "run", "start"];

const SERVER_BOOT_TIMEOUT_MS = 20_000;
const SERVER_BOOT_POLL_MS = 250;
const OVERALL_TEST_TIMEOUT_MS = 120_000;

// SWR background-regen polling defaults. Regeneration is just an in-process
// server.respond() call against sqlite, so it's normally sub-50ms — this
// budget is generous headroom, not an expected wait time.
const SWR_POLL_RETRIES = 10;
const SWR_POLL_DELAY_MS = 100;

// ── LOW-LEVEL HELPERS ───────────────────────────────────────────────────

/** Run a command synchronously in the fixtures dir; throws on non-zero exit. */
function runCmd(cmd: string[], label: string) {
	const result = Bun.spawnSync({
		cmd,
		cwd: FIXTURES_DIR,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});

	const stdout = result.stdout?.toString() ?? "";
	const stderr = result.stderr?.toString() ?? "";

	if (result.exitCode !== 0) {
		throw new Error(
			`[${label}] command failed (exit ${result.exitCode}): ${cmd.join(" ")}\n` +
				`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
		);
	}

	return { stdout, stderr, exitCode: result.exitCode };
}

/**
 * Spawns `bun run start` as a detached background process so it doesn't
 * block the test runner, then polls the server until it responds.
 */
async function startServer(): Promise<import("bun").Subprocess> {
	const proc = Bun.spawn({
		cmd: START_CMD,
		cwd: FIXTURES_DIR,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PORT: String(PORT) },
	});

	const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
	let lastError: unknown;

	while (Date.now() < deadline) {
		// If the process already exited, the server failed to boot — bail early.
		if (proc.exitCode !== null) {
			const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
			throw new Error(
				`Server process exited early (code ${proc.exitCode}) before becoming ready.\n${stderr}`,
			);
		}

		try {
			const res = await fetch(`${BASE_URL}/no-isr/page`);
			if (res.ok) return proc;
		} catch (err) {
			lastError = err;
		}

		await Bun.sleep(SERVER_BOOT_POLL_MS);
	}

	proc.kill();
	throw new Error(
		`Server did not become ready within ${SERVER_BOOT_TIMEOUT_MS}ms. Last error: ${String(lastError)}`,
	);
}

/** Kills the server process and verifies the port is no longer accepting connections. */
async function stopServerAndVerify(proc: import("bun").Subprocess) {
	proc.kill();
	await proc.exited;

	// The process object reports it's done...
	expect(proc.exitCode === null ? proc.signalCode !== null : true).toBe(true);

	// ...and the port itself should now refuse connections.
	let stillUp = true;
	try {
		await fetch(`${BASE_URL}/no-isr/page`, {
			signal: AbortSignal.timeout(1000),
		});
	} catch {
		stillUp = false;
	}
	expect(stillUp).toBe(false);
}

async function fetchJsonTodos(
	urlPath: string,
): Promise<{ id: number; text: string }[]> {
	const res = await fetch(`${BASE_URL}${urlPath}`);
	expect(res.ok).toBe(true);
	const body = (await res.json()) as { todos: { id: number; text: string }[] };
	expect(Array.isArray(body.todos)).toBe(true);
	return body.todos;
}

/** Extracts the <li> text contents from a named <section id="..."> in raw HTML. */
function extractSectionItems(html: string): string[] {
	const sections = html.matchAll(/<section[^>]*>([\s\S]*?)<\/section>/gi);
	const items: string[] = [];

	for (const sectionMatch of sections) {
		const sectionContent = sectionMatch[1];
		if (!sectionContent) continue; // Safety check

		const uls = sectionContent.matchAll(/<ul[^>]*>([\s\S]*?)<\/ul>/gi);

		for (const ulMatch of uls) {
			const ulContent = ulMatch[1];
			if (!ulContent) continue; // Safety check

			const lis = ulContent.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi);
			for (const liMatch of lis) {
				const liContent = liMatch[1];
				if (liContent) {
					// Safety check
					items.push(liContent.trim());
				}
			}
		}
	}

	return items;
}

async function fetchPageSections(urlPath: string) {
	const res = await fetch(`${BASE_URL}${urlPath}`);
	expect(res.ok).toBe(true);
	const html = await res.text();
	return extractSectionItems(html);
}

async function createTodo(text: string) {
	const res = await fetch(`${BASE_URL}/api/todos`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	expect(res.ok).toBe(true);
}

function rmIfExists(p: string) {
	if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

/**
 * Asserts the stale-while-revalidate transition for a single ISR route.
 *
 * The FIRST call to `fetcher()` is expected to still return
 * `expectedStaleCount` — under SWR, crossing the revalidate window doesn't
 * refresh content synchronously, it only *triggers* a background
 * regeneration. This first call is that trigger.
 *
 * Then it polls `fetcher()` a few more times (short delay between each)
 * until it sees `expectedFreshCount`, which is what a request AFTER the
 * background regen resolves should return. Fails if it never arrives
 * within the retry budget.
 */
async function assertSwrTransition(
	fetcher: () => Promise<number>,
	expectedStaleCount: number,
	expectedFreshCount: number,
	opts: { retries?: number; delayMs?: number } = {},
) {
	const { retries = SWR_POLL_RETRIES, delayMs = SWR_POLL_DELAY_MS } = opts;

	// First request: still the pre-revalidate snapshot. Also the request
	// that fires the background regeneration.
	const staleCount = await fetcher();
	expect(staleCount).toBe(expectedStaleCount);

	// Poll subsequent requests until the background regen lands (or we
	// exhaust the retry budget — in which case the final assertion fails
	// with the last-seen count, which is the useful failure signal).
	let freshCount = staleCount;
	for (let i = 0; i < retries; i++) {
		await Bun.sleep(delayMs);
		freshCount = await fetcher();
		if (freshCount === expectedFreshCount) break;
	}
	expect(freshCount).toBe(expectedFreshCount);
}

// ── TEST ────────────────────────────────────────────────────────────────

describe("ISR System", () => {
	let server: import("bun").Subprocess | null = null;

	afterAll(async () => {
		// Safety net: make sure nothing is left running / lying around even if
		// an assertion failed partway through the sequence below.
		if (server && server.exitCode === null) {
			server.kill();
			await server.exited;
		}
		rmIfExists(BUILD_DIR);
		rmIfExists(DB_PATH);
	});

	test(
		"Migrate the initial schema, then build the SvelteKit project",
		async () => {
			runCmd(PREP_CMD, "prepping");
			runCmd(MIGRATE_CMD, "migrate");
			const build1 = runCmd(BUILD_CMD, "build#1");
			expect(build1.exitCode).toBe(0);
			expect(existsSync(BUILD_DIR)).toBe(true);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Start `bun run start` in the background and confirm it boots.",
		async () => {
			server = await startServer();
			expect(server.exitCode).toBeNull();
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Everything should start out empty.",
		async () => {
			for (const p of ["/no-isr/page", "/isr/page", "/isr/layout"]) {
				const list = await fetchPageSections(p);
				expect(list.length).toBe(0);
			}
			for (const p of ["/no-isr/server.json", "/isr/server.json"]) {
				expect((await fetchJsonTodos(p)).length).toBe(0);
			}
		},
		OVERALL_TEST_TIMEOUT_MS,
	);
	test(
		"Immediately after creation, nothing should reflect it yet.",
		async () => {
			await createTodo("wash the dishes");

			// No route's revalidate window has elapsed yet (t=0), so nothing
			// is triggered — every fetch here is a plain "still stale" check,
			// not an SWR transition.
			for (const p of ["/no-isr/page", "/isr/page", "/isr/layout"]) {
				const list = await fetchPageSections(p);
				expect(list.length).toBe(0);
			}
			for (const p of ["/no-isr/server.json", "/isr/server.json"]) {
				expect((await fetchJsonTodos(p)).length).toBe(0);
			}
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Wait 2s (isr/page's 2s revalidate window should now have elapsed)",
		async () => {
			await Bun.sleep(2 * 1000);

			// Windows that haven't elapsed yet: still fully stale. Nothing
			// gets triggered by these fetches, so a single check is enough.
			for (const p of [
				"/no-isr/page",
				"/no-isr/server.json",
				"/isr/server.json",
				"/isr/layout",
			]) {
				const count = p.includes("server")
					? (await fetchJsonTodos(p)).length
					: (await fetchPageSections(p)).length;
				expect(count).toBe(0);
			}

			// isr/page's 2s window HAS elapsed: first hit returns the stale
			// (empty) snapshot and kicks off a background regen; a follow-up
			// hit should pick up the now-fresh content.
			await assertSwrTransition(
				async () => (await fetchPageSections("/isr/page")).length,
				0,
				1,
			);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Wait 2 more seconds (t=4s: isr/server.json's 4s window elapses).",
		async () => {
			await Bun.sleep(2 * 1000);

			for (const p of ["/no-isr/page", "/no-isr/server.json", "/isr/layout"]) {
				const count = p.includes("server")
					? (await fetchJsonTodos(p)).length
					: (await fetchPageSections(p)).length;
				expect(count).toBe(0);
			}

			// isr/page was already revalidated in the previous step — its own
			// 2s window may or may not have re-elapsed by now, but the data
			// hasn't changed since, so a plain fetch is sufficient here.
			{
				const list = await fetchPageSections("/isr/page");
				expect(list.length).toBe(1);
			}

			// isr/server.json's 4s window HAS elapsed: same stale-then-fresh dance.
			await assertSwrTransition(
				async () => (await fetchJsonTodos("/isr/server.json")).length,
				0,
				1,
			);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Wait 2 more seconds (t=6s: isr layout's 6s window elapses)",
		async () => {
			await Bun.sleep(2 * 1000);

			for (const p of ["/no-isr/page", "/no-isr/server.json"]) {
				const count =
					p === "/no-isr/page"
						? (await fetchPageSections(p)).length
						: (await fetchJsonTodos(p)).length;
				expect(count).toBe(0);
			}

			// Already revalidated in earlier steps — plain fetches, no SWR
			// transition expected here.
			{
				const list = await fetchPageSections("/isr/page");
				expect(list.length).toBe(1);
			}
			expect((await fetchJsonTodos("/isr/server.json")).length).toBe(1);

			// isr/layout's 6s window HAS elapsed.
			await assertSwrTransition(
				async () => (await fetchPageSections("/isr/layout")).length,
				0,
				1,
			);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Stop the server and verify it's actually down.Rebuild the project and confirm the build succeeds.",
		async () => {
			if (server) {
				await stopServerAndVerify(server);
				server = null;
			}
			const build2 = runCmd(BUILD_CMD, "build#2");
			expect(build2.exitCode).toBe(0);
			expect(existsSync(BUILD_DIR)).toBe(true);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Restart server succeed after new build.",
		async () => {
			server = await startServer();
			expect(server.exitCode).toBeNull();
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"All page should have todo.",
		async () => {
			for (const p of ["/no-isr/page", "/isr/page", "/isr/layout"]) {
				const list = await fetchPageSections(p);
				expect(list.length).toBe(1);
			}
			for (const p of ["/no-isr/server.json", "/isr/server.json"]) {
				expect((await fetchJsonTodos(p)).length).toBe(1);
			}
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Cleanup server",
		async () => {
			if (server) {
				await stopServerAndVerify(server);
				expect(server.exitCode).not.toBeNull();
				server = null;
			}
			rmIfExists(BUILD_DIR);
			rmIfExists(DB_PATH);
			expect(existsSync(BUILD_DIR)).toBe(false);
			expect(existsSync(DB_PATH)).toBe(false);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);
});

describe("Websockets, and adapter options", () => {
	let featServer: import("bun").Subprocess | null = null;
	const FEAT_PORT = PORT + 1; // Use a distinct port to avoid conflicts

	afterEach(async () => {
		if (featServer && featServer.exitCode === null) {
			featServer.kill();
			await featServer.exited;
			featServer = null;
		}
	});

	test(
		"Migrate the initial schema, then build the SvelteKit project",
		async () => {
			runCmd(PREP_CMD, "prepping");
			runCmd(MIGRATE_CMD, "migrate");
			const build1 = runCmd(BUILD_CMD, "build#3");
			expect(build1.exitCode).toBe(0);
			expect(existsSync(BUILD_DIR)).toBe(true);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Verify Bun WebSocket handling on the adapter's default PORT binding",
		async () => {
			// Adapter default is envPrefix: '' (see README usage block), so the
			// generated server reads plain PORT — no prefix guessing needed.
			featServer = Bun.spawn({
				cmd: START_CMD,
				cwd: FIXTURES_DIR,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, PORT: String(FEAT_PORT) },
			});

			// Poll until the server becomes responsive
			let isReady = false;
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				try {
					const res = await fetch(`http://localhost:${FEAT_PORT}/no-isr/page`);
					if (res.ok) {
						isReady = true;
						break;
					}
				} catch {
					// Server not ready yet
				}
				await Bun.sleep(250);
			}

			expect(isReady).toBe(true);

			// hooks.server.ts upgrades on /ws (see README example) — hits the
			// dynamic-SSR fallback path, which is the only branch that gets
			// `platform.server` / `platform.request` injected.
			const wsUrl = `ws://localhost:${FEAT_PORT}/ws`;
			const ws = new WebSocket(wsUrl);

			const wsResponsePromise = new Promise<string>((resolve, reject) => {
				ws.onopen = () => {
					ws.send("ping");
				};
				ws.onmessage = (event) => {
					if (event.data !== "connection opened") {
						resolve(String(event.data));
					}
				};
				ws.onerror = (err) => {
					reject(err);
				};
			});

			const result = await Promise.race([
				wsResponsePromise,
				Bun.sleep(3000).then(() => "timeout"),
			]);

			ws.close();

			expect(result).not.toBe("timeout");
			// Echo handler per the README example
			expect(result).toBe("ping");
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test("Verify build folder output layout integrity and artifacts", () => {
		expect(existsSync(BUILD_DIR)).toBe(true);
		expect(existsSync(path.join(BUILD_DIR, "index.js"))).toBe(true);
		expect(existsSync(path.join(BUILD_DIR, "server"))).toBe(true);
		expect(existsSync(path.join(BUILD_DIR, "server", "manifest.js"))).toBe(
			true,
		);

		// hooks.js should exist iff hooks.server.ts exports `websocket` and the
		// adapter's websockets option is enabled (default true).
		expect(existsSync(path.join(BUILD_DIR, "server", "hooks.js"))).toBe(true);
	});

	test(
		"Cleanup server",
		async () => {
			if (featServer) {
				await stopServerAndVerify(featServer);
				expect(featServer.exitCode).not.toBeNull();
				featServer = null;
			}
			rmIfExists(BUILD_DIR);
			rmIfExists(DB_PATH);
			expect(existsSync(BUILD_DIR)).toBe(false);
			expect(existsSync(DB_PATH)).toBe(false);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);
});
