import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUILD_DIR = join(FIXTURES, "build");
const PORT = 3000;
const BASE = `http://localhost:${PORT}`;

let server: Subprocess | null = null;

async function build(): Promise<void> {
	const proc = spawn(["bunx", "vite", "build"], {
		cwd: FIXTURES,
		stdio: ["inherit", "pipe", "pipe"],
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`Build failed with code ${exitCode}: ${stderr}`);
	}
}

async function startServer(): Promise<Subprocess> {
	const serverPath = join(BUILD_DIR, "index.js");
	if (!existsSync(serverPath)) {
		throw new Error(`Server entry point not found: ${serverPath}`);
	}
	const proc = spawn(["bun", serverPath], {
		cwd: FIXTURES,
		stdio: ["inherit", "pipe", "pipe"],
		env: { ...process.env, PORT: String(PORT) },
	});
	await new Promise((resolve) => setTimeout(resolve, 2000));
	return proc;
}

function stopServer() {
	if (server) {
		server.kill();
		server = null;
	}
}

afterEach(() => {
	stopServer();
});

test("build produces output", async () => {
	await build();
	expect(existsSync(BUILD_DIR)).toBe(true);
	expect(existsSync(join(BUILD_DIR, "index.js"))).toBe(true);
});

test("ISR: dynamic page returns 200 with content", async () => {
	await build();
	server = await startServer();

	const res = await fetch(`${BASE}/with-isr`);
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toContain("with-isr");
	expect(body).toContain("Revalidates every 5s");
});

test("static page returns prerendered content", async () => {
	await build();
	server = await startServer();

	const res = await fetch(`${BASE}/without-isr`);
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toContain("without-isr");
	expect(body).toContain("Static Prerender");
});

test("unknown route returns 404", async () => {
	await build();
	server = await startServer();

	const res = await fetch(`${BASE}/nonexistent-page`);
	expect(res.status).toBe(404);
});
