import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Builder } from "@sveltejs/kit";
import adapter from "../src/index.ts";

// Exercise the adapter's actual generated entry point in independent Bun workers.
// The fixture server makes hook-visible origins, render failures and data visible.
const root = join(
	import.meta.dir,
	"../fixtures/.svelte-kit",
	`compatibility-${process.pid}`,
);
const workers: import("bun").Subprocess[] = [];
const builds: string[] = [];
const serverSource = `
import { join } from 'node:path';
const stateFile = join(import.meta.dir, '../state.json');
const registry = '@pingpolls/svelte-adapter-bun-isr/registry';
export class Server {
  async init() {
    const hooks = join(import.meta.dir, '../hooks-test.js');
    if (await Bun.file(hooks).exists()) await import(hooks);
  }
  async respond(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/regenerate') {
      const { paths = [], removePaths = [] } = await request.json();
      return Response.json(await globalThis[registry].regenerate(paths, removePaths));
    }
    if (url.pathname === '/control') {
      await Bun.write(stateFile, JSON.stringify(await request.json()));
      return new Response('updated');
    }
    const state = await Bun.file(stateFile).json();
    if (url.hostname === 'custom.example') {
      return new Response(request.method === 'HEAD' ? null : 'custom SSR ' + url.pathname + ' ' + url.origin, { headers: { 'content-type': 'text/plain' } });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('SSR action ' + request.method + ' ' + url.pathname, { status: 201 });
    }
    const data = url.pathname.endsWith('/__data.json');
    const status = url.pathname === '/__404__' || state.unpublished ? 404 : data && state.failData ? 503 : state.failHtml && !data ? 503 : 200;
    if (state.delay) await Bun.sleep(state.delay);
    const rendered = (data ? 'DATA' : 'HTML') + ' v' + state.version + ' ' + url.origin + ' ' + url.pathname;
    const body = data ? JSON.stringify(state.failDataPayload ? { type: 'data', nodes: [{ type: 'error' }] } : state.redirectData ? { type: 'redirect', location: '/login' } : { type: 'data', nodes: [{ type: 'data', data: [rendered] }] }) : rendered;
    return new Response(request.method === 'HEAD' ? null : body, { status, headers: { 'content-type': data ? 'application/json' : 'text/html' } });
  }
}
`;

async function build(options: Parameters<typeof adapter>[0] = {}) {
	const dir = join(root, String(builds.length));
	builds.push(dir);
	mkdirSync(join(dir, "temp"), { recursive: true });
	const builder = {
		config: { paths: { base: "" } },
		routes: [
			{
				id: "/(public)/[document]",
				prerender: "auto",
				config: { revalidate: 3600 },
			},
			{ id: "/(public)", prerender: "auto", config: {} },
			{ id: "/(public)/fixed", prerender: "auto", config: {} },
		],
		log: { minor() {}, warn() {} },
		getBuildDirectory: () => join(dir, "temp"),
		rimraf: (path: string) => rmSync(path, { force: true, recursive: true }),
		writeClient: (dest: string) => {
			mkdirSync(dest, { recursive: true });
			writeFileSync(join(dest, "asset.txt"), "static asset");
			writeFileSync(join(dest, "app.js"), "export const asset = 1;");
		},
		writePrerendered() {},
		writeServer() {},
		generateServerInstance: (dest: string) =>
			writeFileSync(
				dest,
				`const manifest = {
        routes: [
          { id: '/(public)/fixed', pattern: /^\\/fixed$/, page: { leaf: 0 } },
          { id: '/(public)', pattern: /^\\/$/, page: { leaf: 0 } },
          { id: '/(public)/[document]', pattern: /^\\/[^/]+\\/?$/, page: { leaf: 0 } }
        ],
        nodes: [async () => ({ server: { entries: async () => [{ document: 'fresh' }, { document: 'with space' }] } })]
    };`,
			),
	};
	builder.writePrerendered = (dest?: string) => {
		if (!dest) throw new Error("missing destination");
		mkdirSync(join(dest, "doc"), { recursive: true });
		writeFileSync(join(dest, "doc.html"), "HTML cached v0");
		writeFileSync(join(dest, "doc/__data.json"), "DATA cached v0");
		writeFileSync(join(dest, "index.html"), "ROOT cached");
		writeFileSync(join(dest, "static.html"), "STATIC prerendered");
	};
	builder.writeServer = (dest?: string) => {
		if (!dest) throw new Error("missing destination");
		writeFileSync(join(dest, "index.js"), serverSource);
	};
	await adapter({
		out: relative(process.cwd(), dir),
		cluster: false,
		websockets: false,
		...options,
	}).adapt(builder as unknown as Builder);
	await Bun.write(join(dir, "state.json"), JSON.stringify({ version: 1 }));
	return dir;
}

async function start(dir: string, extraEnv: Record<string, string> = {}) {
	const proc = Bun.spawn({
		cmd: [process.execPath, join(dir, "index.js")],
		env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	workers.push(proc);
	const reader = proc.stdout.getReader();
	let output = "";
	const ready = async () => {
		while (true) {
			const { value, done } = await reader.read();
			if (done)
				throw new Error(output + (await new Response(proc.stderr).text()));
			output += new TextDecoder().decode(value);
			const match = output.match(
				/listening on (https?):\/\/127\.0\.0\.1:(\d+)/,
			);
			if (match) return `${match[1]}://127.0.0.1:${match[2]}`;
		}
	};
	return await Promise.race([
		ready(),
		Bun.sleep(10000).then(() => {
			throw new Error(`Runtime boot timed out: ${output}`);
		}),
	]);
}

async function request(
	url: string,
	path: string,
	host = "canonical.example",
	init: RequestInit = {},
) {
	return fetch(url + path, {
		...init,
		headers: {
			"x-forwarded-host": host,
			"x-forwarded-proto": "https",
			...init.headers,
		},
	});
}

async function regenerate(
	url: string,
	paths: string[],
	removePaths: string[] = [],
) {
	const response = await request(url, "/api/regenerate", "canonical.example", {
		method: "POST",
		body: JSON.stringify({ paths, removePaths }),
	});
	expect(response.status).toBe(200);
	return response.json();
}

async function control(url: string, state: Record<string, unknown>) {
	expect(
		(
			await request(url, "/control", "canonical.example", {
				method: "POST",
				body: JSON.stringify(state),
			})
		).status,
	).toBe(200);
}

afterAll(async () => {
	for (const worker of workers) worker.kill();
	await Promise.all(workers.map((worker) => worker.exited));
	rmSync(root, { recursive: true, force: true });
});

describe("ISR option validation", () => {
	test("only exact hostnames and credential-free HTTP(S) origins are accepted", () => {
		for (const host of [
			"*.example.com",
			"https://example.com",
			"example.com:443",
			"example.com/path",
			"a,b",
			"-bad.example",
			"a..b",
			"a b",
		]) {
			expect(() => adapter({ isrHosts: [host] })).toThrow("isrHosts");
		}
		for (const origin of [
			"ftp://example.com",
			"https://user:pass@example.com",
			"https://example.com/path",
			"https://example.com?x",
			"https://example.com#x",
			"https://example.com/a/..",
			"https://example.com\\evil",
		]) {
			expect(() => adapter({ isrOrigin: origin })).toThrow("isrOrigin");
		}
		expect(() =>
			adapter({
				isrHosts: ["CANONICAL.example", "localhost"],
				isrOrigin: "https://canonical.example:8443/",
			}),
		).not.toThrow();
	});
});

describe("generated runtime compatibility", () => {
	let dir: string;
	let first: string;
	let second: string;
	beforeAll(async () => {
		dir = await build({
			precompress: true,
			isrHosts: ["CANONICAL.example"],
			isrOrigin: "https://canonical.example:8443",
		});
		const env = {
			HOST_HEADER: "x-forwarded-host",
			PROTOCOL_HEADER: "x-forwarded-proto",
		};
		first = await start(dir, env);
		second = await start(dir, env);
	});

	test("gates cached root, HTML, data and non-ISR prerenders by effective hostname", async () => {
		for (const [path, content] of [
			["/", "ROOT cached"],
			["/doc", "HTML cached v0"],
			["/doc/__data.json", "DATA cached v0"],
			["/static", "STATIC prerendered"],
		] as const) {
			expect(
				await (await request(first, path, "canonical.example:443")).text(),
			).toBe(content);
			expect(
				await (await request(first, path, "custom.example")).text(),
			).toContain("custom SSR");
		}
		expect(
			await (await request(first, "/absent", "custom.example")).text(),
		).toContain("custom SSR");
		expect((await request(first, "/absent")).status).toBe(404);
		expect(await (await request(first, "/absent")).text()).toContain(
			"https://canonical.example:8443 /__404__",
		);
		expect(
			await (await request(first, "/asset.txt", "custom.example")).text(),
		).toBe("static asset");
	});

	test("POST/PUT/PATCH/DELETE reach SSR for assets, cached and unknown ISR paths", async () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			for (const path of [
				"/doc",
				"/absent",
				"/asset.txt",
				"/doc/__data.json",
			]) {
				const response = await request(first, path, "canonical.example", {
					method,
					body: "action",
				});
				expect(response.status).toBe(201);
				expect(await response.text()).toBe(`SSR action ${method} ${path}`);
			}
		}
		for (const path of ["/doc", "/asset.txt", "/missing-head"]) {
			const response = await request(first, path, "canonical.example", {
				method: "HEAD",
			});
			expect(response.status).toBe(path === "/missing-head" ? 404 : 200);
			expect(await response.text()).toBe("");
			if (path !== "/missing-head") {
				const getResponse = await request(first, path);
				expect(response.headers.get("content-type")).toBe(
					getResponse.headers.get("content-type"),
				);
				expect(response.headers.get("content-length")).toBe(
					getResponse.headers.get("content-length"),
				);
			}
		}
	});

	test("configured proxy headers reject ambiguous values", async () => {
		for (const host of [
			"canonical.example,custom.example",
			"user@canonical.example",
			"canonical.example/path",
		]) {
			expect((await request(first, "/doc", host)).status).toBe(400);
		}
		expect(
			(
				await request(first, "/doc", "canonical.example", {
					headers: { "x-forwarded-proto": "https,http" },
				})
			).status,
		).toBe(400);
	});

	test("regenerates HTML and data at the canonical origin and invalidates peer compression", async () => {
		expect(
			(
				await request(second, "/doc", "canonical.example", {
					headers: { "accept-encoding": "gzip" },
				})
			).headers.get("content-encoding"),
		).toBe("gzip");
		expect(
			(
				await request(second, "/doc/__data.json", "canonical.example", {
					headers: { "accept-encoding": "br" },
				})
			).headers.get("content-encoding"),
		).toBe("br");
		const result = await regenerate(first, ["/doc"]);
		expect(result.failed).toEqual([]);
		expect(result.regenerated).toEqual(["/doc"]);
		for (const url of [first, second]) {
			for (const path of ["/doc", "/doc/__data.json"]) {
				const response = await request(url, path, "canonical.example", {
					headers: { "accept-encoding": "br,gzip,zstd" },
				});
				expect(response.headers.get("content-encoding")).toBeNull();
				expect(await response.text()).toContain(
					`v1 https://canonical.example:8443 ${path}`,
				);
			}
		}
		for (const file of ["doc.html", "doc/__data.json"]) {
			for (const ext of [".br", ".gz", ".zst"])
				expect(
					await Bun.file(join(dir, "prerendered", file + ext)).exists(),
				).toBe(false);
		}
		await control(first, { version: 1, delay: 20 });
		const concurrent = await Promise.all([
			regenerate(first, ["/doc"]),
			regenerate(second, ["/doc"]),
		]);
		for (const result of concurrent) expect(result.failed).toEqual([]);
		expect(await (await request(second, "/doc/__data.json")).text()).toContain(
			"v1 https://canonical.example:8443",
		);
	});

	test("failed HTML or data renders retain both last-known-good files", async () => {
		for (const failure of [
			"failHtml",
			"failData",
			"failDataPayload",
			"redirectData",
		]) {
			await control(first, { version: 2, [failure]: true });
			expect((await regenerate(first, ["/doc"])).failed).toHaveLength(1);
			expect(await (await request(second, "/doc")).text()).toContain("v1");
			expect(
				await (await request(second, "/doc/__data.json")).text(),
			).toContain("v1");
		}
		await control(first, { version: 3 });
	});

	test("a failed disk commit rolls back the HTML/data pair", async () => {
		const blockedVariant = join(dir, "prerendered/doc/__data.json.br");
		mkdirSync(blockedVariant);
		try {
			await control(first, { version: 2 });
			expect((await regenerate(first, ["/doc"])).failed).toHaveLength(1);
			for (const path of ["/doc", "/doc/__data.json"]) {
				expect(await (await request(second, path)).text()).toContain("v1");
			}
		} finally {
			rmSync(blockedVariant, { recursive: true });
		}
	});

	test("route-group entries expand concrete paths discoverable by other workers", async () => {
		// Seed the other worker's negative cache with a failed background render.
		await control(first, { version: 3, failHtml: true });
		expect((await request(second, "/fresh")).status).toBe(404);
		await Bun.sleep(30);
		await control(first, { version: 3 });
		const result = await regenerate(first, [
			"/(public)/[document]",
			"/fixed",
			"/",
		]);
		expect(result.failed).toEqual([]);
		expect([...result.created, ...result.regenerated]).toContain("/fresh");
		expect(result.created).toContain("/with%20space");
		for (const path of [
			"/fresh",
			"/fresh/__data.json",
			"/fixed",
			"/__data.json",
		]) {
			expect(await (await request(second, path)).text()).toContain("v3");
		}
		expect((await regenerate(first, ["/dotted.slug"])).failed).toEqual([]);
		const dotted = await request(second, "/dotted.slug");
		expect(dotted.headers.get("content-type")).toBe("text/html");
		expect(await dotted.text()).toContain("v3");
	});

	test("unpublish removes paired files and prevents stale peer or compressed responses", async () => {
		// Repopulate compressed variants to ensure removal clears all of them too.
		for (const file of ["doc.html", "doc/__data.json"]) {
			for (const ext of [".br", ".gz", ".zst"])
				await Bun.write(
					join(dir, "prerendered", file + ext),
					"stale compressed",
				);
		}
		await control(first, { version: 4, unpublished: true });
		const result = await regenerate(first, [], ["/doc"]);
		expect(result.failed).toEqual([]);
		expect(result.removed).toEqual(["/doc"]);
		for (const url of [first, second]) {
			for (const path of ["/doc", "/doc/__data.json"]) {
				const response = await request(url, path, "canonical.example", {
					headers: { "accept-encoding": "gzip,br,zstd" },
				});
				expect(response.status).toBe(404);
				expect(response.headers.get("content-encoding")).toBeNull();
				expect(await response.text()).not.toContain(" /doc");
			}
		}
		for (const file of ["doc.html", "doc/__data.json"]) {
			for (const ext of ["", ".br", ".gz", ".zst"])
				expect(
					await Bun.file(join(dir, "prerendered", file + ext)).exists(),
				).toBe(false);
		}
	});

	test("rejects filesystem-escaping regeneration/removal paths", async () => {
		const result = await regenerate(
			first,
			["//evil", "/../evil", "/doc?x"],
			["/../../evil"],
		);
		expect(result.failed).toHaveLength(4);
	});
});

test("precompression is off by default", async () => {
	const dir = await build();
	for (const ext of [".br", ".gz", ".zst"]) {
		expect(await Bun.file(join(dir, "client/app.js" + ext)).exists()).toBe(
			false,
		);
		expect(
			await Bun.file(join(dir, "prerendered/doc.html" + ext)).exists(),
		).toBe(false);
	}
	const url = await start(dir);
	const response = await fetch(`${url}/app.js`, {
		headers: { "accept-encoding": "br, gzip, zstd" },
	});
	expect(response.headers.get("content-encoding")).toBeNull();
	expect(response.headers.get("content-type")).toStartWith("text/javascript");
});

test("a precompressed client asset keeps its own content type", async () => {
	const url = await start(await build({ precompress: true }));
	for (const [encoding, expected] of [
		["br", "br"],
		["zstd", "zstd"],
		["gzip", "gzip"],
	]) {
		for (const [path, type] of [
			["/app.js", "text/javascript"],
			["/asset.txt", "text/plain"],
		]) {
			const response = await fetch(`${url}${path}`, {
				headers: { "accept-encoding": encoding },
			});
			expect(response.headers.get("content-encoding")).toBe(expected);
			// Not application/octet-stream or application/gzip from the variant's
			// extension: browsers refuse a module script with those.
			expect(response.headers.get("content-type")).toStartWith(type);
		}
	}
});

test("omitted options preserve all-host interception and the old regeneration origin", async () => {
	const dir = await build({ precompress: false });
	const url = await start(dir);
	expect(await (await request(url, "/doc", "custom.example")).text()).toBe(
		"HTML cached v0",
	);
	// Unconfigured forwarded headers never select the effective origin.
	expect((await request(url, "/absent", "custom.example")).status).toBe(404);
	expect((await regenerate(url, ["/doc"])).failed).toEqual([]);
	expect(await (await request(url, "/doc")).text()).toContain(
		"http://isr-worker /doc",
	);
});

test("an empty allowlist disables all prerender/unknown-ISR interception; prefixed headers reach SSR", async () => {
	const dir = await build({
		isrHosts: [],
		envPrefix: "COMPAT_",
		precompress: false,
	});
	const url = await start(dir, {
		COMPAT_PORT: "0",
		COMPAT_HOST: "127.0.0.1",
		COMPAT_HOST_HEADER: "x-forwarded-host",
		COMPAT_PROTOCOL_HEADER: "x-forwarded-proto",
	});
	for (const path of ["/", "/doc", "/absent", "/static"]) {
		expect(await (await request(url, path, "custom.example")).text()).toBe(
			`custom SSR ${path} https://custom.example`,
		);
		expect(await (await request(url, path)).text()).toContain(
			"HTML v1 https://canonical.example",
		);
	}
	for (const [host, origin] of [
		["custom.example:443", "https://custom.example"],
		["custom.example:80", "https://custom.example:80"],
		["custom.example:8443", "https://custom.example:8443"],
	] as const) {
		expect(await (await request(url, "/doc", host)).text()).toBe(
			`custom SSR /doc ${origin}`,
		);
	}
});

// Stand-in for an app's hooks.server: queue workers behind singleton(), Bun-level gates via intercept().
const hooksSource = `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { intercept, sharedStore, singleton, workerInfo } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};
const log = join(import.meta.dir, 'singletons.log');
await singleton('jobs', () => appendFileSync(log, JSON.stringify(workerInfo()) + '\\n'), {
  dispose: () => appendFileSync(log, 'disposed\\n'),
});
await singleton('jobs', () => appendFileSync(log, 'duplicate\\n'));
const limits = sharedStore('limits');
intercept(
  (request) => {
    const id = request.headers.get('x-id');
    if (id && limits.hit(id, 60) > 5) return new Response('limited', { status: 429 });
  },
  (request) => (new URL(request.url).pathname === '/wp-login.php' ? new Response('honeypot', { status: 451 }) : undefined),
  async (request) => (request.headers.get('x-block') ? new Response('limited', { status: 429 }) : undefined),
);
`;

async function buildWithHooks(options: Parameters<typeof adapter>[0] = {}) {
	const dir = await build({ precompress: false, ...options });
	writeFileSync(join(dir, "hooks-test.js"), hooksSource);
	return dir;
}

function singletonLog(dir: string) {
	const file = join(dir, "singletons.log");
	return existsSync(file)
		? readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
		: [];
}

async function waitFor(check: () => boolean, label: string) {
	const deadline = Date.now() + 10000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
		await Bun.sleep(50);
	}
}

describe("intercept and singleton", () => {
	test("interceptors answer before assets, ISR and SSR; the rest pass through", async () => {
		const dir = await buildWithHooks();
		const url = await start(dir);
		const honeypot = await fetch(`${url}/wp-login.php`);
		expect(honeypot.status).toBe(451);
		expect(await honeypot.text()).toBe("honeypot");
		for (const path of ["/asset.txt", "/doc", "/absent"]) {
			const limited = await fetch(url + path, { headers: { "x-block": "1" } });
			expect(limited.status).toBe(429);
		}
		expect(await (await fetch(`${url}/asset.txt`)).text()).toBe("static asset");
		expect(await (await fetch(`${url}/doc`)).text()).toBe("HTML cached v0");
	});

	test("a standalone server runs each singleton key once and disposes it on SIGTERM", async () => {
		const dir = await buildWithHooks();
		await start(dir);
		const proc = workers.at(-1) as import("bun").Subprocess;
		const [info] = singletonLog(dir);
		expect(JSON.parse(info as string)).toEqual({
			role: "http",
			index: 0,
			count: 1,
			backgroundWorkers: 0,
			standalone: false,
		});
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(0);
		expect(singletonLog(dir)).toEqual([info as string, "disposed"]);
	});

	test("the cluster runs singletons once, in the background worker, never in HTTP workers", async () => {
		const dir = await buildWithHooks({ cluster: true });
		const url = await start(dir, { CPUS: "3", BACKGROUND_WORKERS: "1" });
		await waitFor(() => singletonLog(dir).length > 0, "background singleton");
		// Every HTTP worker has booted (and evaluated hooks) by the time all answer.
		await Promise.all(
			Array.from({ length: 30 }, () => fetch(`${url}/wp-login.php`)),
		);
		await Bun.sleep(200);
		const entries = singletonLog(dir);
		expect(entries).toHaveLength(1);
		expect(JSON.parse(entries[0] as string)).toMatchObject({
			role: "background",
			index: 0,
			count: 1,
			backgroundWorkers: 1,
		});
		// Shutdown reaches the background process' dispose hook too.
		const supervisor = workers.at(-1) as import("bun").Subprocess;
		supervisor.kill("SIGTERM");
		await supervisor.exited;
		await waitFor(
			() => singletonLog(dir).includes("disposed"),
			"background dispose",
		);
	});

	test("without background workers the cluster uses HTTP worker 0 only", async () => {
		const dir = await buildWithHooks({ cluster: true });
		const url = await start(dir, { CPUS: "3" });
		await Promise.all(
			Array.from({ length: 30 }, () => fetch(`${url}/wp-login.php`)),
		);
		await waitFor(() => singletonLog(dir).length > 0, "http singleton");
		await Bun.sleep(200);
		const entries = singletonLog(dir);
		expect(entries).toHaveLength(1);
		expect(JSON.parse(entries[0] as string)).toMatchObject({
			role: "http",
			index: 0,
			count: 3,
		});
	});
});

describe("sharedStore", () => {
	test("counters are shared by every worker of the cluster", async () => {
		const dir = await buildWithHooks({ cluster: true });
		const url = await start(dir, { CPUS: "3" });
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			// No keep-alive: connections spread across the three reuseport workers.
			const res = await fetch(`${url}/doc`, {
				keepalive: false,
				headers: { "x-id": "client-1", connection: "close" },
			});
			statuses.push(res.status);
		}
		expect(statuses.filter((status) => status === 200)).toHaveLength(5);
		expect(statuses.filter((status) => status === 429)).toHaveLength(7);
		// Another key has its own window.
		const other = await fetch(`${url}/doc`, {
			headers: { "x-id": "client-2" },
		});
		expect(other.status).toBe(200);
	});
});

describe("TLS", () => {
	/** A self-signed certificate followed by its key, as one PEM string. */
	function originPem(dir: string) {
		const cert = join(dir, "cert.pem");
		const key = join(dir, "key.pem");
		const openssl = Bun.spawnSync([
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-subj",
			"/CN=127.0.0.1",
			"-days",
			"1",
			"-keyout",
			key,
			"-out",
			cert,
		]);
		expect(openssl.exitCode).toBe(0);
		return {
			cert: readFileSync(cert, "utf8"),
			pem: readFileSync(cert, "utf8") + readFileSync(key, "utf8"),
		};
	}

	test("serves HTTPS from the PEM in TLS_ORIGIN_CERT, multi-line or with \\n escapes", async () => {
		const dir = await build({ precompress: false });
		const { pem } = originPem(dir);
		for (const value of [pem, pem.replaceAll("\n", "\\n")]) {
			const url = await start(dir, { TLS_ORIGIN_CERT: value });
			expect(url.startsWith("https://")).toBe(true);
			const response = await fetch(`${url}/doc`, {
				tls: { rejectUnauthorized: false },
			});
			expect(await response.text()).toBe("HTML cached v0");
		}
	});

	test("refuses to start when TLS_ORIGIN_CERT has no private key", async () => {
		const dir = await build({ precompress: false });
		const proc = Bun.spawn({
			cmd: [process.execPath, join(dir, "index.js")],
			env: {
				...process.env,
				PORT: "0",
				HOST: "127.0.0.1",
				TLS_ORIGIN_CERT: originPem(dir).cert,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await proc.exited).not.toBe(0);
		expect(await new Response(proc.stderr).text()).toContain("TLS_ORIGIN_CERT");
	});
});

describe("compress", () => {
	const ssr = (url: string, encoding: string) =>
		fetch(`${url}/page`, {
			decompress: false,
			headers: {
				"x-forwarded-host": "custom.example",
				"x-forwarded-proto": "https",
				"accept-encoding": encoding,
			},
		});

	test("is off by default: SSR responses are sent as-is", async () => {
		const url = await start(await build({ precompress: false, isrHosts: [] }), {
			HOST_HEADER: "x-forwarded-host",
			PROTOCOL_HEADER: "x-forwarded-proto",
		});
		const res = await ssr(url, "zstd, gzip");
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(await res.text()).toBe("custom SSR /page https://custom.example");
	});

	test("compresses SSR responses with zstd, then gzip, honoring q=0", async () => {
		const url = await start(
			await build({ precompress: false, compress: true, isrHosts: [] }),
			{
				HOST_HEADER: "x-forwarded-host",
				PROTOCOL_HEADER: "x-forwarded-proto",
			},
		);
		for (const [header, expected] of [
			["gzip, zstd", "zstd"],
			["gzip, deflate, br", "gzip"],
			["zstd;q=0, gzip", "gzip"],
			["br", null],
			["identity", null],
		] as const) {
			const res = await ssr(url, header);
			expect(res.headers.get("content-encoding")).toBe(expected);
			if (expected)
				expect(res.headers.get("vary")).toContain("Accept-Encoding");
			const bytes = new Uint8Array(await res.arrayBuffer());
			const body =
				expected === "zstd"
					? Bun.zstdDecompressSync(bytes)
					: expected === "gzip"
						? Bun.gunzipSync(bytes)
						: bytes;
			expect(new TextDecoder().decode(body)).toBe(
				"custom SSR /page https://custom.example",
			);
		}
		// Static assets keep their own (precompressed) path and are not recompressed.
		const asset = await fetch(`${url}/asset.txt`, {
			headers: { "accept-encoding": "identity" },
		});
		expect(asset.headers.get("content-encoding")).toBeNull();
	});
});
