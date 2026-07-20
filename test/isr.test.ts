import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUILD_DIR = join(FIXTURES, "build");
const DB_PATH = join(FIXTURES, "fixture.sqlite");

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;

let server: Subprocess | null = null;

// ---------- helpers ----------

async function build(): Promise<void> {
	const proc = spawn(["bunx", "vite", "build"], {
		cwd: FIXTURES,
		stdio: ["inherit", "pipe", "pipe"],
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Build failed: ${stderr}`);
	}
}

async function startServer(): Promise<Subprocess> {
	const entry = join(BUILD_DIR, "index.js");
	if (!existsSync(entry)) {
		throw new Error(`Missing build entry: ${entry}`);
	}

	const proc = spawn(["bun", entry], {
		cwd: FIXTURES,
		env: { ...process.env, PORT: String(PORT) },
		stdio: ["inherit", "pipe", "pipe"],
	});

	// wait for server boot
	await new Promise((r) => setTimeout(r, 2000));
	return proc;
}

function stopServer() {
	if (server) {
		server.kill();
		server = null;
	}
}

async function getTodos() {
	const res = await fetch(`${BASE}/api/todos`);
	expect(res.status).toBe(200);
	return await res.json();
}

async function addTodo(text: string) {
	const res = await fetch(`${BASE}/api/todos`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	expect(res.status).toBe(200);
}

async function expectTodosCount(count: number) {
	const todos = await getTodos();
	expect(todos.length).toBe(count);
	return todos;
}

// ---------- lifecycle ----------

afterEach(() => {
	stopServer();
});

// ---------- main test ----------

test("full ISR flow", async () => {
	// 1. build
	await build();
	expect(existsSync(BUILD_DIR)).toBe(true);

	// 2. start server
	server = await startServer();

	// 3. both pages should have empty todo
	await expectTodosCount(0);

	// 4. add 3 todos
	await addTodo("todo 1");
	await addTodo("todo 2");
	await addTodo("todo 3");

	const todosAfterInsert = await expectTodosCount(3);
	expect(todosAfterInsert.map((t: any) => t.text)).toEqual([
		"todo 1",
		"todo 2",
		"todo 3",
	]);

	// 5. ISR behavior check immediately
	const withISR_1 = await fetch(`${BASE}/with-isr`).then((r) => r.text());
	const withoutISR_1 = await fetch(`${BASE}/without-isr`).then((r) => r.text());

	expect(withISR_1).toContain("0"); // still cached
	expect(withoutISR_1).toContain("0"); // static

	// 6. wait 10s for ISR revalidate
	await new Promise((r) => setTimeout(r, 10000));

	const withISR_2 = await fetch(`${BASE}/with-isr`).then((r) => r.text());
	const withoutISR_2 = await fetch(`${BASE}/without-isr`).then((r) => r.text());

	expect(withISR_2).toContain("3"); // updated
	expect(withoutISR_2).toContain("0"); // still static

	// 7. stop server
	stopServer();

	// ensure stopped
	let failed = false;
	try {
		await fetch(`${BASE}`);
	} catch {
		failed = true;
	}
	expect(failed).toBe(true);

	// 8. rebuild
	await build();

	// 9. restart
	server = await startServer();

	// 10. both pages should now show 3 (fresh build snapshot)
	const withISR_3 = await fetch(`${BASE}/with-isr`).then((r) => r.text());
	const withoutISR_3 = await fetch(`${BASE}/without-isr`).then((r) => r.text());

	expect(withISR_3).toContain("3");
	expect(withoutISR_3).toContain("3");

	// 11. cleanup
	stopServer();

	if (existsSync(BUILD_DIR)) {
		rmSync(BUILD_DIR, { recursive: true, force: true });
	}

	if (existsSync(DB_PATH)) {
		rmSync(DB_PATH, { force: true });
	}
});
