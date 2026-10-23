import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import path from "node:path";

// ── CONFIG ──────────────────────────────────────────────────────────────
const FIXTURES_DIR = path.join(process.cwd(), "fixtures");
const DB_PATH = path.join(FIXTURES_DIR, "db.sqlite");
const BUILD_DIR = path.join(FIXTURES_DIR, "build");
const BASE_PORT = Number(process.env.TEST_PORT ?? 3000);

const PREP_CMD = ["bun", "run", "--bun", "prepare"];
const MIGRATE_CMD = ["bun", "src/scripts/prep.ts"];
const BUILD_CMD = ["bun", "run", "--bun", "build"];
const START_CMD = ["bun", "run", "--bun", "start"];

const SERVER_BOOT_TIMEOUT_MS = 20_000;
const SERVER_BOOT_POLL_MS = 250;
const OVERALL_TEST_TIMEOUT_MS = 120_000;
const SWR_POLL_RETRIES = 10;
const SWR_POLL_DELAY_MS = 100;

// ── GLOBAL SETUP & TEARDOWN ─────────────────────────────────────────────

beforeAll(async () => {
	await rmIfExists(BUILD_DIR);
	await rmIfExists(DB_PATH);
	runCmd(PREP_CMD, "prepping");
	runCmd(MIGRATE_CMD, "migrate");
	runCmd(BUILD_CMD, "build");
}, OVERALL_TEST_TIMEOUT_MS);

afterAll(async () => {
	await rmIfExists(BUILD_DIR);
	await rmIfExists(DB_PATH);
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

async function rmIfExists(p: string) {
	const file = Bun.file(p);
	if (await file.exists()) await file.unlink();
	// if (existsSync(p)) rmSync(p, { recursive: true, force: true });
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

async function setPrerenderedAge(urlPath: string, seconds: number) {
	const filename = urlPath.endsWith(".json") ? urlPath : `${urlPath}.html`;
	const timestamp = new Date(Date.now() - seconds * 1000);
	await utimes(
		path.join(BUILD_DIR, "prerendered", filename),
		timestamp,
		timestamp,
	);
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
		// Hold initial snapshots fresh until each test explicitly expires its route.
		// Build/startup time otherwise consumes the short revalidation windows.
		for (const urlPath of ["/isr/page", "/isr/server.json", "/isr/layout"]) {
			await setPrerenderedAge(urlPath, -3600);
		}
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
			await setPrerenderedAge("/isr/page", 2.1);

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
			const dataResponse = await fetch(`${baseUrl}/isr/page/__data.json`);
			expect(dataResponse.status).toBe(200);
			expect(await dataResponse.text()).toContain("wash the dishes");
		},
		OVERALL_TEST_TIMEOUT_MS,
	);

	test(
		"ISR Server JSON revalidates after 4s window",
		async () => {
			await setPrerenderedAge("/isr/server.json", 4.1);

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
			await setPrerenderedAge("/isr/layout", 6.1);

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
		// POST /api/todos already created the slug page; the explicit call refreshes it.
		expect([...result.created, ...result.regenerated]).toContain(
			"/isr/hello-world",
		);
		expect((await fetch(`${baseUrl}/isr/hello-world`)).ok).toBe(true);
		const dataResponse = await fetch(`${baseUrl}/isr/hello-world/__data.json`);
		expect(dataResponse.status).toBe(200);
		expect(await dataResponse.text()).toContain("Hello World");
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
		expect(
			await Bun.file(
				path.join(BUILD_DIR, "prerendered/isr/hello-world.html"),
			).exists(),
		).toBe(false);
		expect(
			await Bun.file(
				path.join(BUILD_DIR, "prerendered/isr/hello-world/__data.json"),
			).exists(),
		).toBe(false);
	});
});

describe("SSR, static and ISR slug behavior", () => {
	let server: import("bun").Subprocess | null = null;
	const port = BASE_PORT + 3;
	const baseUrl = `http://localhost:${port}`;

	beforeAll(async () => {
		server = await startAppServer(port);
	});

	afterAll(async () => {
		await stopAppServer(server, port);
	});

	test("SSR page (prerender = false) renders live on every request", async () => {
		const before = await fetchPageSections(baseUrl, "/ssr/page");
		await createTodo(baseUrl, "ssr todo");
		const after = await fetchPageSections(baseUrl, "/ssr/page");
		expect(after.length).toBe(before.length + 1);

		const stamp = async () =>
			(await (await fetch(`${baseUrl}/ssr/page`)).text()).match(
				/data-testid="rendered-at"[^>]*>(\d+)</,
			)?.[1];
		const first = await stamp();
		await Bun.sleep(5);
		expect(await stamp()).not.toBe(first);
	});

	test("unknown /isr/[slug] and /no-isr/[slug] are plain 404s", async () => {
		for (const p of ["/isr/nope", "/no-isr/nope"]) {
			const res = await fetch(`${baseUrl}${p}`);
			expect(res.status).toBe(404);
			expect(res.headers.get("content-type")).toContain("text/html");
			await res.text();
		}
	});

	test("adding a todo makes /isr/[slug] appear but /no-isr/[slug] stays 404", async () => {
		await createTodo(baseUrl, "Brand New Todo");

		let isr = await fetch(`${baseUrl}/isr/brand-new-todo`);
		for (let i = 0; i < SWR_POLL_RETRIES && isr.status !== 200; i++) {
			await Bun.sleep(SWR_POLL_DELAY_MS);
			isr = await fetch(`${baseUrl}/isr/brand-new-todo`);
		}
		expect(isr.status).toBe(200);
		expect(await isr.text()).toContain("brand-new-todo");

		const staticRes = await fetch(`${baseUrl}/no-isr/brand-new-todo`);
		expect(staticRes.status).toBe(404);
		await Bun.sleep(500);
		expect((await fetch(`${baseUrl}/no-isr/brand-new-todo`)).status).toBe(404);
	});

	test("404 for missing prerendered slugs is served without regeneration or SSR", async () => {
		const started = performance.now();
		for (let i = 0; i < 200; i++) {
			const res = await fetch(`${baseUrl}/no-isr/missing-${i}`);
			expect(res.status).toBe(404);
			await res.arrayBuffer();
		}
		// Generous bound (~25ms/request): a DB-backed SSR round-trip per miss would blow past it.
		expect(performance.now() - started).toBeLessThan(5000);
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

	test("Build folder output layout integrity and artifacts", async () => {
		expect(await Bun.file(path.join(BUILD_DIR, "index.js")).exists()).toBe(
			true,
		);
		expect(
			await Bun.file(path.join(BUILD_DIR, "server", "manifest.js")).exists(),
		).toBe(true);
		expect(
			await Bun.file(path.join(BUILD_DIR, "server", "hooks.js")).exists(),
		).toBe(true);
	});
});
