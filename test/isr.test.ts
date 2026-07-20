// isr.test.ts
import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const FIXTURE_DIR = process.env.FIXTURE_DIR ?? join(process.cwd(), "fixtures");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

const PREP_CMD = ["bun", "run", "prepare"];
const BUILD_CMD = ["bun", "run", "build"];
const START_CMD = ["bun", "run", "start"];
const MIGRATE_CMD = ["bun", "./src/scripts/prep.ts"];

const PAGE_PATHS = [
	"/no-isr/page",
	"/no-isr/server",
	"/isr/page",
	"/isr/server",
] as const;

type Todo = { id: number; text: string };
type TodosResponse = { todos: Todo[] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCommand(cmd: string[], cwd: string) {
	const proc = Bun.spawnSync({
		cmd,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	if (proc.exitCode !== 0) {
		const stdout = new TextDecoder().decode(proc.stdout);
		const stderr = new TextDecoder().decode(proc.stderr);
		throw new Error(
			[
				`Command failed: ${cmd.join(" ")}`,
				`cwd: ${cwd}`,
				`exitCode: ${proc.exitCode}`,
				stdout ? `stdout:\n${stdout}` : "",
				stderr ? `stderr:\n${stderr}` : "",
			]
				.filter(Boolean)
				.join("\n\n"),
		);
	}

	return proc;
}

async function cleanupFixtureArtifacts() {
	await rm(join(FIXTURE_DIR, "build"), { recursive: true, force: true });
	await rm(join(FIXTURE_DIR, "dist"), { recursive: true, force: true });

	await rm(join(FIXTURE_DIR, "db.sqlite"), { force: true });
	await rm(join(FIXTURE_DIR, "db.sqlite-wal"), { force: true });
	await rm(join(FIXTURE_DIR, "db.sqlite-shm"), { force: true });
}

async function waitForServerUp(url: string, timeoutMs = 30_000) {
	const started = Date.now();
	let lastError: unknown = null;

	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(url, { cache: "no-store" });
			if (res.ok) return;
			lastError = new Error(`Unexpected status ${res.status}`);
		} catch (error) {
			lastError = error;
		}

		await sleep(250);
	}

	throw new Error(`Server did not become ready: ${String(lastError)}`);
}

async function waitForServerDown(url: string, timeoutMs = 10_000) {
	const started = Date.now();

	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(url, { cache: "no-store" });
			if (!res.ok) return;
		} catch {
			return;
		}

		await sleep(250);
	}

	throw new Error("Server did not stop in time");
}

async function fetchText(pathname: string) {
	const res = await fetch(new URL(pathname, BASE_URL), {
		cache: "no-store",
		headers: { accept: "text/html" },
	});

	expect(res.ok).toBe(true);
	return await res.text();
}

async function fetchTodos(pathname: string) {
	const res = await fetch(new URL(pathname, BASE_URL), {
		cache: "no-store",
		headers: { accept: "application/json" },
	});

	expect(res.ok).toBe(true);

	const data = (await res.json()) as TodosResponse;
	expect(Array.isArray(data.todos)).toBe(true);
	return data.todos;
}

async function createTodo(text: string) {
	const res = await fetch(new URL("/api/todos", BASE_URL), {
		method: "POST",
		cache: "no-store",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({ text }),
	});

	expect(res.ok).toBe(true);
}

function escapeRegExp(input: string) {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countLisInsideSection(html: string, sectionId: string) {
	const sectionMatch = html.match(
		new RegExp(
			`<section\\s+id="${escapeRegExp(sectionId)}"[^>]*>([\\s\\S]*?)<\\/section>`,
			"i",
		),
	);

	expect(sectionMatch).not.toBeNull();

	const sectionHtml = sectionMatch?.[1] ?? "";
	const ulMatch = sectionHtml.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);

	expect(ulMatch).not.toBeNull();

	const ulHtml = ulMatch?.[1] ?? "";
	const liMatches = ulHtml.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) ?? [];
	return liMatches.length;
}

function assertHtmlTodoState(
	html: string,
	expectedPageCount: number,
	expectedLayoutCount: number,
	expectedText?: string,
) {
	expect(countLisInsideSection(html, "page-todo")).toBe(expectedPageCount);
	expect(countLisInsideSection(html, "layout-todo")).toBe(expectedLayoutCount);

	if (expectedText) {
		expect(html).toContain(expectedText);
	}
}

async function assertPageState(
	pathname: string,
	expectedPageCount: number,
	expectedLayoutCount: number,
	expectedText?: string,
) {
	const html = await fetchText(pathname);
	assertHtmlTodoState(
		html,
		expectedPageCount,
		expectedLayoutCount,
		expectedText,
	);
}

async function assertServerState(
	pathname: string,
	expectedCount: number,
	expectedText?: string,
) {
	const todos = await fetchTodos(pathname);
	expect(todos).toHaveLength(expectedCount);

	if (expectedCount > 0) {
		expect(typeof todos[0]?.id).toBe("number");
		expect(typeof todos[0]?.text).toBe("string");
	}

	if (expectedText) {
		expect(todos.some((todo) => todo.text === expectedText)).toBe(true);
	}
}

test(
	"build, start, ISR timeline, restart, rebuild, and cleanup",
	async () => {
		const todoText = `bun-isr-${Date.now()}`;
		let server: ReturnType<typeof Bun.spawn> | null = null;

		try {
			await runCommand(PREP_CMD, FIXTURE_DIR);
			await runCommand(MIGRATE_CMD, FIXTURE_DIR);
			await runCommand(BUILD_CMD, FIXTURE_DIR);

			server = Bun.spawn({
				cmd: START_CMD,
				cwd: FIXTURE_DIR,
				stdout: "inherit",
				stderr: "inherit",
			});

			await waitForServerUp(BASE_URL);

			for (const path of PAGE_PATHS) {
				if (path.endsWith("/page")) {
					await assertPageState(path, 0, 0);
				} else {
					await assertServerState(path, 0);
				}
			}

			await createTodo(todoText);

			for (const path of PAGE_PATHS) {
				if (path.endsWith("/page")) {
					await assertPageState(path, 0, 0);
				} else {
					await assertServerState(path, 0);
				}
			}

			await sleep(5100);

			await assertPageState("/no-isr/page", 0, 0);
			await assertServerState("/no-isr/server", 0);

			await assertPageState("/isr/page", 1, 0, todoText);
			await assertServerState("/isr/server", 0);

			await sleep(5100);

			await assertPageState("/no-isr/page", 0, 0);
			await assertServerState("/no-isr/server", 0);

			await assertPageState("/isr/page", 1, 0, todoText);
			await assertServerState("/isr/server", 1, todoText);

			await sleep(5100);

			await assertPageState("/no-isr/page", 0, 0);
			await assertServerState("/no-isr/server", 0);

			await assertPageState("/isr/page", 1, 1, todoText);
			await assertServerState("/isr/server", 1, todoText);

			server.kill("SIGTERM");
			await waitForServerDown(BASE_URL);

			server = null;

			await runCommand(BUILD_CMD, FIXTURE_DIR);

			server = Bun.spawn({
				cmd: START_CMD,
				cwd: FIXTURE_DIR,
				stdout: "inherit",
				stderr: "inherit",
			});

			await waitForServerUp(BASE_URL);

			await assertPageState("/no-isr/page", 1, 1, todoText);
			await assertServerState("/no-isr/server", 1, todoText);

			await assertPageState("/isr/page", 1, 1, todoText);
			await assertServerState("/isr/server", 1, todoText);
		} finally {
			if (server) {
				try {
					server.kill("SIGTERM");
				} catch {
					// ignore
				}

				try {
					await waitForServerDown(BASE_URL);
				} catch {
					// ignore
				}
			}

			await cleanupFixtureArtifacts();
		}
	},
	{ timeout: 180_000 },
);
