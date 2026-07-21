import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

// ── CONFIG ──────────────────────────────────────────────────────────────
const FIXTURES_DIR = path.join(process.cwd(), "fixtures");
const DB_PATH = path.join(FIXTURES_DIR, "db.sqlite");
const BUILD_DIR = path.join(FIXTURES_DIR, "build");
const BASE_PORT = Number(process.env.TEST_PORT ?? 3000);

const PREP_CMD = ["bun", "run", "prepare"];
const MIGRATE_CMD = ["bun", "src/scripts/prep.ts"];
const BUILD_CMD = ["bun", "run", "build"];
const START_CMD = ["bun", "run", "start"];

const SERVER_BOOT_TIMEOUT_MS = 20_000;
const SERVER_BOOT_POLL_MS = 250;
const OVERALL_TEST_TIMEOUT_MS = 120_000;
const SWR_POLL_RETRIES = 10;
const SWR_POLL_DELAY_MS = 100;

// ── GLOBAL SETUP & TEARDOWN ─────────────────────────────────────────────

beforeAll(() => {
	rmIfExists(BUILD_DIR);
	rmIfExists(DB_PATH);
	runCmd(PREP_CMD, "prepping");
	runCmd(MIGRATE_CMD, "migrate");
	runCmd(BUILD_CMD, "build");
});

afterAll(() => {
	rmIfExists(BUILD_DIR);
	rmIfExists(DB_PATH);
});

// ── LOW-LEVEL HELPERS ───────────────────────────────────────────────────

function runCmd(cmd: string[], label: string) {
	const result = Bun.spawnSync({
		cmd,
		cwd: FIXTURES_DIR,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`[${label}] command failed (exit ${result.exitCode}): ${cmd.join(" ")}\n` +
				`--- stderr ---\n${result.stderr?.toString()}`,
		);
	}
	return result;
}

async function startAppServer(port: number): Promise<import("bun").Subprocess> {
	const proc = Bun.spawn({
		cmd: START_CMD,
		cwd: FIXTURES_DIR,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PORT: String(port) },
	});

	const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
	const baseUrl = `http://localhost:${port}`;

	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			throw new Error(`Server exited early (code ${proc.exitCode}).`);
		}
		try {
			if ((await fetch(`${baseUrl}/no-isr/page`)).ok) return proc;
		} catch {}
		await Bun.sleep(SERVER_BOOT_POLL_MS);
	}

	proc.kill();
	throw new Error(
		`Server did not become ready within ${SERVER_BOOT_TIMEOUT_MS}ms.`,
	);
}

async function stopAppServer(
	proc: import("bun").Subprocess | null,
	port: number,
) {
	if (!proc || proc.exitCode !== null) return;
	proc.kill();
	await proc.exited;

	let stillUp = true;
	try {
		await fetch(`http://localhost:${port}/no-isr/page`, {
			signal: AbortSignal.timeout(1000),
		});
	} catch {
		stillUp = false;
	}
	expect(stillUp).toBe(false);
}

function rmIfExists(p: string) {
	if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

async function fetchJsonTodos(baseUrl: string, urlPath: string) {
	const res = await fetch(`${baseUrl}${urlPath}`);
	expect(res.ok).toBe(true);
	const body = (await res.json()) as { todos: { id: number; text: string }[] };
	return body.todos;
}

function extractSectionItems(html: string): string[] {
	const sections = html.matchAll(/<section[^>]*>([\s\S]*?)<\/section>/gi);
	const items: string[] = [];
	for (const sectionMatch of sections) {
		if (!sectionMatch[1]) continue;
		const uls = sectionMatch[1].matchAll(/<ul[^>]*>([\s\S]*?)<\/ul>/gi);
		for (const ulMatch of uls) {
			if (!ulMatch[1]) continue;
			const lis = ulMatch[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi);
			for (const liMatch of lis) {
				if (liMatch[1]) items.push(liMatch[1].trim());
			}
		}
	}
	return items;
}

async function fetchPageSections(baseUrl: string, urlPath: string) {
	const res = await fetch(`${baseUrl}${urlPath}`);
	expect(res.ok).toBe(true);
	return extractSectionItems(await res.text());
}

async function createTodo(baseUrl: string, text: string) {
	const res = await fetch(`${baseUrl}/api/todos`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	expect(res.ok).toBe(true);
}

async function assertSwrTransition(
	fetcher: () => Promise<number>,
	expectedStaleCount: number,
	expectedFreshCount: number,
) {
	const staleCount = await fetcher();
	expect(staleCount).toBe(expectedStaleCount);

	let freshCount = staleCount;
	for (let i = 0; i < SWR_POLL_RETRIES; i++) {
		await Bun.sleep(SWR_POLL_DELAY_MS);
		freshCount = await fetcher();
		if (freshCount === expectedFreshCount) break;
	}
	expect(freshCount).toBe(expectedFreshCount);
}

// ── TESTS ───────────────────────────────────────────────────────────────

describe("ISR System", () => {
	let server: import("bun").Subprocess | null = null;
	const port = BASE_PORT;
	const baseUrl = `http://localhost:${port}`;

	beforeAll(async () => {
		server = await startAppServer(port);
	});

	afterAll(async () => {
		await stopAppServer(server, port);
	});

	test("Initial state is empty", async () => {
		for (const p of ["/no-isr/page", "/isr/page", "/isr/layout"]) {
			expect((await fetchPageSections(baseUrl, p)).length).toBe(0);
		}
		for (const p of ["/no-isr/server.json", "/isr/server.json"]) {
			expect((await fetchJsonTodos(baseUrl, p)).length).toBe(0);
		}
	});

	test("Immediate checks remain stale (0s)", async () => {
		await createTodo(baseUrl, "wash the dishes");
		for (const p of ["/no-isr/page", "/isr/page", "/isr/layout"]) {
			expect((await fetchPageSections(baseUrl, p)).length).toBe(0);
		}
	});

	test(
		"ISR Page revalidates after 2s window",
		async () => {
			await Bun.sleep(2000);

			// Unchanged routes
			expect((await fetchPageSections(baseUrl, "/no-isr/page")).length).toBe(0);
			expect(
				(await fetchJsonTodos(baseUrl, "/no-isr/server.json")).length,
			).toBe(0);
			expect((await fetchJsonTodos(baseUrl, "/isr/server.json")).length).toBe(
				0,
			);

			// ISR page transition
			await assertSwrTransition(
				async () => (await fetchPageSections(baseUrl, "/isr/page")).length,
				0,
				1,
			);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"ISR Server JSON revalidates after 4s window",
		async () => {
			await Bun.sleep(2000);

			// Previously updated route
			expect((await fetchPageSections(baseUrl, "/isr/page")).length).toBe(1);

			// ISR server.json transition
			await assertSwrTransition(
				async () => (await fetchJsonTodos(baseUrl, "/isr/server.json")).length,
				0,
				1,
			);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"ISR Layout revalidates after 6s window",
		async () => {
			await Bun.sleep(2000);

			// ISR layout transition
			await assertSwrTransition(
				async () => (await fetchPageSections(baseUrl, "/isr/layout")).length,
				0,
				1,
			);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"Server rebuilds and restarts properly",
		async () => {
			await stopAppServer(server, port);
			server = null;

			runCmd(BUILD_CMD, "build#2");
			server = await startAppServer(port);
			expect(server.exitCode).toBeNull();

			// All data should persist
			expect((await fetchPageSections(baseUrl, "/isr/layout")).length).toBe(1);
		},
		OVERALL_TEST_TIMEOUT_MS,
	);
});

describe("Manual regeneration API & dynamic ISR routes", () => {
	let server: import("bun").Subprocess | null = null;
	const port = BASE_PORT + 2;
	const baseUrl = `http://localhost:${port}`;

	beforeAll(async () => {
		server = await startAppServer(port);
	});

	afterAll(async () => {
		await stopAppServer(server, port);
	});

	async function postRegenerate(paths: string[], removePaths: string[] = []) {
		const res = await fetch(`${baseUrl}/api/regenerate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ paths, removePaths }),
		});
		expect(res.ok).toBe(true);
		return (await res.json()) as {
			regenerated: string[];
			created: string[];
			removed: string[];
			failed: { path: string; reason: string }[];
		};
	}

	test("POST /api/regenerate creates a brand-new prerendered path", async () => {
		await createTodo(baseUrl, "Hello World");
		const result = await postRegenerate(["/isr/hello-world"]);

		expect(result.failed).toEqual([]);
		expect(result.created).toContain("/isr/hello-world");
		expect((await fetch(`${baseUrl}/isr/hello-world`)).ok).toBe(true);
	});

	test("Route id with entries() expands every param set", async () => {
		const result = await postRegenerate(["/isr/todo/[id]"]);
		expect(result.failed).toEqual([]);
		expect([...result.created, ...result.regenerated].length).toBeGreaterThan(
			0,
		);
	});

	test("Non-ISR route is rejected", async () => {
		const result = await postRegenerate(["/no-isr/page"]);
		expect(result.failed[0]?.path).toBe("/no-isr/page");
		expect(result.failed[0]?.reason).toContain("not ISR-enabled");
	});

	test("removePaths successfully deletes paths", async () => {
		const result = await postRegenerate([], ["/isr/hello-world"]);
		expect(result.removed).toContain("/isr/hello-world");
	});
});

describe("Websockets and adapter options", () => {
	let server: import("bun").Subprocess | null = null;
	const port = BASE_PORT + 1;

	beforeAll(async () => {
		server = await startAppServer(port);
	});

	afterAll(async () => {
		await stopAppServer(server, port);
	});

	test("Bun WebSocket handling works on the adapter's default PORT", async () => {
		const ws = new WebSocket(`ws://localhost:${port}/ws`);
		const result = await Promise.race([
			new Promise<string>((resolve, reject) => {
				ws.onopen = () => ws.send("ping");
				ws.onmessage = (e) => {
					if (e.data !== "connection opened") resolve(String(e.data));
				};
				ws.onerror = reject;
			}),
			Bun.sleep(3000).then(() => "timeout"),
		]);

		ws.close();
		expect(result).toBe("ping");
	});

	test("Build folder output layout integrity and artifacts", () => {
		expect(existsSync(path.join(BUILD_DIR, "index.js"))).toBe(true);
		expect(existsSync(path.join(BUILD_DIR, "server", "manifest.js"))).toBe(
			true,
		);
		expect(existsSync(path.join(BUILD_DIR, "server", "hooks.js"))).toBe(true);
	});
});
