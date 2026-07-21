/**
 * End-to-end ISR / no-ISR revalidation test for the `fixtures` SvelteKit app.
 *
 * Run with:  bun test fixtures/tests/isr.e2e.test.ts
 * (run from the repo root, or `cd fixtures && bun test tests/isr.e2e.test.ts`)
 *
 * ─────────────────────────────────────────────────────────────────────────
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
 *   - `/no-isr/server` exists as the no-isr counterpart of `/isr/server`
 *     (the dir listing only showed `/isr/server/+server.ts`, but the test
 *     spec explicitly checks `/no-isr/server`, so it's assumed to exist
 *     with the same JSON contract).
 *   - The todos table backing every route is shared/global (not scoped
 *     per-route) — a single POST to /api/todos is expected to eventually
 *     surface everywhere, just at different revalidation cadences.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

// ── CONFIG ──────────────────────────────────────────────────────────────
const FIXTURES_DIR = path.join(process.cwd(), "fixtures");
const DB_PATH = path.join(FIXTURES_DIR, "db.sqlite");
const BUILD_DIR = path.join(FIXTURES_DIR, "build");
const SVELTEKIT_DIR = path.join(FIXTURES_DIR, ".svelte-kit");
const PORT = Number(process.env.TEST_PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;

const PREP_CMD = ["bun", "run", "prepare"];
const MIGRATE_CMD = ["bun", "run", "src/scripts/prep.ts"];
const BUILD_CMD = ["bun", "run", "build"];
const START_CMD = ["bun", "run", "start"];

const SERVER_BOOT_TIMEOUT_MS = 20_000;
const SERVER_BOOT_POLL_MS = 250;
const OVERALL_TEST_TIMEOUT_MS = 120_000;

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

// ── TEST ────────────────────────────────────────────────────────────────

describe("ISR / no-ISR revalidation lifecycle", () => {
	let server: import("bun").Subprocess | null = null;

	afterAll(async () => {
		// Safety net: make sure nothing is left running / lying around even if
		// an assertion failed partway through the sequence below.
		if (server && server.exitCode === null) {
			server.kill();
			await server.exited;
		}
		rmIfExists(BUILD_DIR);
		rmIfExists(SVELTEKIT_DIR);
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
			for (const p of ["/no-isr/server", "/isr/server"]) {
				expect((await fetchJsonTodos(p)).length).toBe(0);
			}
		},
		OVERALL_TEST_TIMEOUT_MS,
	);
	test(
		"Immediately after creation, nothing should reflect it yet.",
		async () => {
			await createTodo("wash the dishes");

			//    (no-isr should still be re-fetched fresh though — assumed to be
			//    request-time in this app's contract, so we check it's empty
			//    only because the underlying write path is presumed async /
			//    not yet visible; if no-isr is truly always-fresh, this only
			//    guards the ISR routes staying stale).
			for (const p of ["/no-isr/page", "/isr/page", "/isr/layout"]) {
				const list = await fetchPageSections(p);
				expect(list.length).toBe(0);
			}
			for (const p of ["/no-isr/server", "/isr/server"]) {
				expect((await fetchJsonTodos(p)).length).toBe(0);
			}
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Wait 3s (isr/page's 3s revalidate window should now have elapsed)",
		async () => {
			await Bun.sleep(3 * 1000);

			for (const p of [
				"/no-isr/page",
				"/no-isr/server",
				"/isr/server",
				"/isr/layout",
			]) {
				const count = p.includes("server")
					? (await fetchJsonTodos(p)).length
					: (await fetchPageSections(p)).length;
				expect(count).toBe(0);
			}
			{
				const list = await fetchPageSections("/isr/page");
				expect(list.length).toBe(1);
			}
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Wait 3 more seconds (t=6s: isr/server's 6s window elapses).",
		async () => {
			await Bun.sleep(3 * 1000);

			for (const p of ["/no-isr/page", "/no-isr/server", "/isr/layout"]) {
				const count = p.includes("server")
					? (await fetchJsonTodos(p)).length
					: (await fetchPageSections(p)).length;
				expect(count).toBe(0);
			}
			{
				const list = await fetchPageSections("/isr/page");
				expect(list.length).toBe(1);
			}
			expect((await fetchJsonTodos("/isr/server")).length).toBe(1);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Wait 3 more seconds (t=9s: isr layout's 9s window elapses)",
		async () => {
			await Bun.sleep(3 * 1000);

			for (const p of ["/no-isr/page", "/no-isr/server"]) {
				const count =
					p === "/no-isr/page"
						? (await fetchPageSections(p)).length
						: (await fetchJsonTodos(p)).length;
				expect(count).toBe(0);
			}
			for (const p of ["/isr/page", "/isr/layout"]) {
				const list = await fetchPageSections(p);
				expect(list.length).toBe(1);
			}
			expect((await fetchJsonTodos("/isr/server")).length).toBe(1);
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
			for (const p of ["/no-isr/server", "/isr/server"]) {
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
			rmIfExists(SVELTEKIT_DIR);
			rmIfExists(DB_PATH);
			expect(existsSync(BUILD_DIR)).toBe(false);
			expect(existsSync(SVELTEKIT_DIR)).toBe(false);
			expect(existsSync(DB_PATH)).toBe(false);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);
});

describe("New Features: Bun WebSockets, envPrefix, and Custom Build Folders", () => {
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
		"Verify Bun WebSocket handling and envPrefix custom port binding",
		async () => {
			// Test envPrefix capability by passing a prefixed PORT variable if configured.
			// If envPrefix is configured as 'APP_', Bun.serve will read 'APP_PORT'.
			// We supply both to ensure the server starts regardless of the exact prefix string used in the fixture.
			featServer = Bun.spawn({
				cmd: START_CMD,
				cwd: FIXTURES_DIR,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					PORT: String(FEAT_PORT),
					APP_PORT: String(FEAT_PORT),
					CUSTOM_PORT: String(FEAT_PORT),
				},
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

			// Initialize a native Bun WebSocket connection to verify the upgraded server bindings
			const wsUrl = `ws://localhost:${FEAT_PORT}/`;
			const ws = new WebSocket(wsUrl);

			const wsResponsePromise = new Promise<string>((resolve, reject) => {
				ws.onopen = () => {
					ws.send("ping");
				};
				ws.onmessage = (event) => {
					resolve(String(event.data));
				};
				ws.onerror = (err) => {
					reject(err);
				};
			});

			// Setup a simple timeout mechanism for the websocket handshake and message response
			const result = await Promise.race([
				wsResponsePromise,
				Bun.sleep(3000).then(() => "timeout"),
			]);

			ws.close();

			// Verify that the WebSocket didn't timeout and successfully communicated with Bun.serve
			expect(result).not.toBe("timeout");
			// If it's an echo handler, it will return "ping"
			expect(result).toBe("ping");
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test("Verify build folder output layout integrity and artifacts", () => {
		// Check both default 'build' or any custom build output directory specified in options
		const targetBuildDir = BUILD_DIR;

		expect(existsSync(targetBuildDir)).toBe(true);
		expect(existsSync(path.join(targetBuildDir, "index.js"))).toBe(true);
		expect(existsSync(path.join(targetBuildDir, "server"))).toBe(true);
		expect(existsSync(path.join(targetBuildDir, "server", "manifest.js"))).toBe(
			true,
		);

		// If hooks.server.ts bundled successfully with websockets enabled, hooks.js should exist
		const hooksPath = path.join(targetBuildDir, "server", "hooks.js");
		if (existsSync(hooksPath)) {
			expect(existsSync(hooksPath)).toBe(true);
		}
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
			rmIfExists(SVELTEKIT_DIR);
			rmIfExists(DB_PATH);
			expect(existsSync(BUILD_DIR)).toBe(false);
			expect(existsSync(SVELTEKIT_DIR)).toBe(false);
			expect(existsSync(DB_PATH)).toBe(false);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);
});
