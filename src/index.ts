import { cpSync, existsSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import type { Adapter, Builder } from "@sveltejs/kit";

/** Options accepted by the adapter factory. */
interface AdapterOptions {
	/** Output directory for the generated server. Default: 'build' */
	out?: string;
	/** Serve client + prerendered assets from Bun (incl. range requests). Default: true */
	serveAssets?: boolean;
	/**
	 * Emit gzip + brotli (+ zstd if available) variants at build time, served per
	 * Accept-Encoding. Off by default: a CDN or reverse proxy in front normally
	 * compresses. Default: false
	 */
	precompress?: boolean;
	/** Prefix applied to runtime env vars (HOST, PORT, ...). Default: '' */
	envPrefix?: string;
	/** Build-time default idle timeout in seconds; runtime env wins. Default: 10 */
	idleTimeout?: number;
	/** Bundle hooks.server's `websocket` export into Bun.serve. Default: true */
	websockets?: boolean;
	/** Spawn one worker per core behind SO_REUSEPORT via a supervisor. If this enabled, adapter will generate two file, `app.js` and `index.js` while the `index.js` file will consist of Bun spawn commands running `app.js` file. Default: true */
	cluster?: boolean;
	/**
	 * Compress dynamic (SSR) responses at runtime with zstd or gzip, per Accept-Encoding.
	 * Leave off when a CDN/reverse proxy (Cloudflare, nginx) compresses. Static assets and
	 * prerendered files are unaffected: they use `precompress`. Default: false
	 */
	compress?: boolean;
	/** Hostnames allowed to serve prerendered/ISR content. Omitted: all hosts; []: none. */
	isrHosts?: string[];
	/** HTTP(S) origin used for ISR renders and the fallback 404. Default: 'http://isr-worker' */
	isrOrigin?: string;
}

/** Options for `config.ssrCache` when more than a bare TTL is needed. */
export interface SsrCacheConfig {
	/** Seconds a rendered response is reused. Must be > 0. */
	ttl: number;
	/**
	 * Cookie names that never influence this route's output (analytics, consent banners).
	 * A request carrying any *other* cookie is never served from, or stored in, the cache.
	 * Default: none, so any `Cookie` header bypasses the cache.
	 */
	ignoreCookies?: string[];
}

/** Per-route config read from `export const config = { revalidate, ssrCache }`. */
export interface Config {
	revalidate?: number;
	/**
	 * Opt in to a short in-memory cache for this dynamic (SSR) route, per worker process.
	 * A number is the TTL in seconds. Only anonymous GET requests are cached; see the README.
	 */
	ssrCache?: number | SsrCacheConfig;
}

/** Result shape returned by the runtime `regenerate()` helper. */
export interface RegenerateResult {
	/** Existing prerendered paths that were re-rendered in place. */
	regenerated: string[];
	/** Paths written for the first time. */
	created: string[];
	/** Paths whose prerendered file (+ compressed variants) were deleted. */
	removed: string[];
	/** Paths that failed, with a reason. */
	failed: { path: string; reason: string }[];
}

/** Which kind of process the code is running in. */
export type WorkerRole = "http" | "background";

/** Describes the current process, as published by the generated runtime. */
export interface WorkerInfo {
	/** `http` serves requests; `background` runs singletons only and never binds a port. */
	role: WorkerRole;
	/** 0-based index within `role`. */
	index: number;
	/** Number of processes sharing `role`. */
	count: number;
	/** Dedicated background processes in this deployment (`BACKGROUND_WORKERS`). */
	backgroundWorkers: number;
	/** True outside the built Bun runtime (vite dev/preview, prerendering). */
	standalone: boolean;
}

export interface SingletonOptions<T> {
	/** How many processes of the target role run the factory. Default: 1 */
	workers?: number;
	/**
	 * Target role. `background` (default) uses the dedicated background processes
	 * and falls back to the HTTP workers when `BACKGROUND_WORKERS` is 0; `http`
	 * always uses the HTTP workers.
	 */
	role?: WorkerRole;
	/** Called on SIGTERM/SIGINT, before the process exits (bounded by `SHUTDOWN_TIMEOUT`). */
	dispose?: (value: T) => unknown;
}

/**
 * Runs before static assets, ISR and SvelteKit. Return a Response to answer
 * the request right there, or nothing to let it through.
 */
export type Interceptor = (
	request: Request,
	server: Bun.Server<unknown>,
) => Response | undefined | Promise<Response | undefined>;

const ADAPTER_NAME = "@pingpolls/svelte-adapter-bun-isr";
const REGISTRY_KEY = `${ADAPTER_NAME}/registry`;
const RUNTIME_KEY = `${ADAPTER_NAME}/runtime`;
const SINGLETONS_KEY = `${ADAPTER_NAME}/singletons`;
const STORES_KEY = `${ADAPTER_NAME}/stores`;

/**
 * Connection setup, run in the supervisor before any worker exists (journal-mode
 * switches and DDL on an empty file are not covered by busy_timeout under contention)
 * and again, as cheap no-ops, in each process.
 */
const SHARED_STORE_SETUP = [
	"PRAGMA busy_timeout = 5000",
	"PRAGMA journal_mode = WAL",
	"PRAGMA synchronous = OFF",
	"CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT, n INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 9007199254740991, PRIMARY KEY (ns, key)) WITHOUT ROWID",
];

type RuntimeState = {
	worker?: WorkerInfo;
	intercept: Interceptor | null;
	/** SQLite file shared by every process of the deployment; unset means per-process memory. */
	sharedPath?: string;
};

/**
 * Cross-process key/value store on `bun:sqlite` (WAL), shared by every worker
 * of the deployment. All writes are atomic across processes; entries expire.
 */
export interface SharedStore {
	/** Fixed-window counter: increments `key` and returns the new count. The window starts at the first hit. */
	hit(key: string, windowSeconds: number): number;
	/** JSON value, or `undefined` when missing or expired. */
	get<T = unknown>(key: string): T | undefined;
	/** Store a JSON value; without `ttlSeconds` it never expires. */
	set(key: string, value: unknown, ttlSeconds?: number): void;
	has(key: string): boolean;
	delete(key: string): void;
	/** Remove expired rows now (a background sweep also runs every minute). */
	sweep(): void;
}
type SingletonEntry = {
	value: Promise<unknown>;
	dispose?: (value: never) => unknown;
};

/** Shared with the generated runtime through globalThis, so it survives HMR and duplicate module copies. */
function runtimeState(): RuntimeState {
	const scope = globalThis as Record<string, unknown>;
	scope[RUNTIME_KEY] ??= { intercept: null };
	return scope[RUNTIME_KEY] as RuntimeState;
}

/**
 * Shared, persistent-per-deployment store for interceptors (bans, counters).
 * Backed by one SQLite file in WAL mode that the supervisor hands to every
 * worker, so a ban or hit seen by one process is seen by all of them. Each
 * call is one synchronous prepared statement (a few microseconds); keep a
 * small per-process cache in front of it for the hottest checks.
 * `name` isolates key spaces. Without a supervisor (`cluster: false`, dev)
 * it is private to the process unless `SHARED_STORE_PATH` is set.
 */
export function sharedStore(name = "default"): SharedStore {
	const scope = globalThis as Record<string, unknown>;
	scope[STORES_KEY] ??= new Map();
	const stores = scope[STORES_KEY] as Map<string, SharedStore>;
	const cached = stores.get(name);
	if (cached) return cached;

	// Lazy: importing the adapter in a non-Bun config loader must not require bun:sqlite.
	const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
	const db = new Database(runtimeState().sharedPath ?? ":memory:");
	// busy_timeout first: every later statement waits for peers instead of failing.
	for (const statement of SHARED_STORE_SETUP) db.run(statement);
	const hitQuery = db.query(
		`INSERT INTO kv (ns, key, n, expires) VALUES (?1, ?2, 1, ?3)
		 ON CONFLICT (ns, key) DO UPDATE SET
		   n = CASE WHEN expires <= ?4 THEN 1 ELSE n + 1 END,
		   expires = CASE WHEN expires <= ?4 THEN ?3 ELSE expires END
		 RETURNING n`,
	);
	const getQuery = db.query(
		"SELECT value FROM kv WHERE ns = ?1 AND key = ?2 AND expires > ?3",
	);
	const setQuery = db.query(
		`INSERT INTO kv (ns, key, value, n, expires) VALUES (?1, ?2, ?3, 0, ?4)
		 ON CONFLICT (ns, key) DO UPDATE SET value = ?3, n = 0, expires = ?4`,
	);
	const deleteQuery = db.query("DELETE FROM kv WHERE ns = ?1 AND key = ?2");
	const sweepQuery = db.query("DELETE FROM kv WHERE expires <= ?1");
	const forever = Number.MAX_SAFE_INTEGER;

	const store: SharedStore = {
		hit(key, windowSeconds) {
			const now = Date.now();
			const row = hitQuery.get(name, key, now + windowSeconds * 1000, now) as {
				n: number;
			};
			return row.n;
		},
		get<T>(key: string) {
			const row = getQuery.get(name, key, Date.now()) as {
				value: string | null;
			} | null;
			return row?.value == null ? undefined : (JSON.parse(row.value) as T);
		},
		set(key, value, ttlSeconds) {
			setQuery.run(
				name,
				key,
				JSON.stringify(value),
				ttlSeconds === undefined ? forever : Date.now() + ttlSeconds * 1000,
			);
		},
		has(key) {
			return getQuery.get(name, key, Date.now()) !== null;
		},
		delete(key) {
			deleteQuery.run(name, key);
		},
		sweep() {
			sweepQuery.run(Date.now());
		},
	};
	// Jittered so workers don't sweep in lockstep; unref'd so it never keeps a process alive.
	setInterval(store.sweep, 60_000 + Math.random() * 5_000).unref();
	// Under saturated multi-process writes the automatic checkpoint never gets a quiet
	// moment, so the WAL grows without bound (GBs in RAM-backed /dev/shm within a minute).
	// RESTART briefly blocks writers until the WAL is fully checkpointed, then reuses it.
	setInterval(() => {
		try {
			db.run("PRAGMA wal_checkpoint(RESTART)");
		} catch {}
	}, 100 + Math.random() * 25).unref();
	stores.set(name, store);
	return store;
}

/** The current process' role and index. */
export function workerInfo(): WorkerInfo {
	return (
		runtimeState().worker ?? {
			role: "http",
			index: 0,
			count: 1,
			backgroundWorkers: 0,
			standalone: true,
		}
	);
}

/**
 * Run `factory` once per process, and only in the first `workers` processes
 * of the target role, e.g. queue consumers that must not multiply per core.
 * Repeated calls with the same key (HMR, a second import of hooks.server)
 * return the first call's result. Unselected processes resolve `undefined`.
 * Outside the built runtime every call is selected, so keep `building` guards.
 */
export function singleton<T>(
	key: string,
	factory: () => T | Promise<T>,
	options: SingletonOptions<Awaited<T>> = {},
): Promise<Awaited<T> | undefined> {
	const { workers = 1, role = "background", dispose } = options;
	if (!(workers >= 1)) {
		throw new Error(`[${ADAPTER_NAME}] singleton workers must be >= 1`);
	}
	const scope = globalThis as Record<string, unknown>;
	scope[SINGLETONS_KEY] ??= new Map();
	const store = scope[SINGLETONS_KEY] as Map<string, SingletonEntry>;
	const existing = store.get(key);
	if (existing) return existing.value as Promise<Awaited<T> | undefined>;

	const worker = workerInfo();
	const target =
		role === "http" || worker.backgroundWorkers === 0 ? "http" : "background";
	const selected =
		worker.standalone || (worker.role === target && worker.index < workers);
	const entry: SingletonEntry = {
		value: selected
			? Promise.resolve().then(factory)
			: Promise.resolve(undefined),
		dispose: selected ? (dispose as SingletonEntry["dispose"]) : undefined,
	};
	// A failed start may be retried by the next call instead of staying cached.
	entry.value.catch(() => {
		if (store.get(key) === entry) store.delete(key);
	});
	store.set(key, entry);
	return entry.value as Promise<Awaited<T> | undefined>;
}

/**
 * Register Bun-level interceptors from `hooks.server`. They run in order on
 * every request to the HTTP workers, before static assets, ISR and SvelteKit;
 * the first one returning a Response wins. Calling again replaces the chain.
 * They only run in the built Bun runtime, not under vite dev/preview.
 */
export function intercept(...handlers: Interceptor[]): void {
	runtimeState().intercept =
		handlers.length === 0
			? null
			: handlers.length === 1
				? (handlers[0] as Interceptor)
				: (request, server) => {
						let i = 0;
						// Stays synchronous until a handler actually returns a promise.
						const next = (): ReturnType<Interceptor> => {
							while (i < handlers.length) {
								const result = (handlers[i++] as Interceptor)(request, server);
								if (result instanceof Promise) {
									return result.then((response) => response ?? next());
								}
								if (result) return result;
							}
							return undefined;
						};
						return next();
					};
}

/** File extensions skipped during precompression (already compressed, or negligible gains). */
const SKIP_COMPRESS_EXT = new Set([
	".gz",
	".br",
	".zst",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".avif",
	".woff",
	".woff2",
	".mp4",
	".mp3",
	".zip",
]);

/**
 * Trigger an ISR regeneration from inside a running server, e.g. a
 * `+server.ts`, `+page.server.ts` or `+layout.server.ts` endpoint.
 */
export function regenerate(
	paths: string[],
	removePaths: string[] = [],
): Promise<RegenerateResult> {
	const registry = (globalThis as Record<string, unknown>)[REGISTRY_KEY] as
		| { regenerate: (p: string[], r: string[]) => Promise<RegenerateResult> }
		| undefined;

	if (!registry) {
		throw new Error(
			`[${ADAPTER_NAME}] regenerate() has no runtime server to talk to — ` +
				"this only works while build/app.js is running, called from inside a request.",
		);
	}
	return registry.regenerate(paths, removePaths);
}

export default function (options: AdapterOptions = {}): Adapter {
	const {
		out = "build",
		serveAssets = true,
		precompress = false,
		envPrefix = "",
		idleTimeout = 10,
		websockets = true,
		cluster = true,
		compress = false,
		isrHosts,
		isrOrigin = "http://isr-worker",
	} = options;
	const normalizedHosts = validateIsrOptions(isrHosts, isrOrigin);

	return {
		name: ADAPTER_NAME,

		async adapt(builder: Builder) {
			const dest = join(process.cwd(), out);
			const tmp = builder.getBuildDirectory("adapter-bun");
			const serverDest = join(dest, "server");

			builder.rimraf(dest);
			builder.rimraf(tmp);
			mkdirSync(tmp, { recursive: true });
			mkdirSync(serverDest, { recursive: true });

			/** 1. Client assets + prerendered pages, optionally precompressed. */
			builder.log.minor("Copying client assets");
			builder.writeClient(join(dest, "client"));
			builder.writePrerendered(join(dest, "prerendered"));

			if (precompress) {
				builder.log.minor("Precompressing assets");
				await Promise.all([
					precompressDir(join(dest, "client")),
					precompressDir(join(dest, "prerendered")),
				]);
			}

			/** 2. Server code + ISR route manifest, written straight to serverDest. */
			builder.log.minor("Building server");
			builder.writeServer(tmp);

			const isrRoutes: Record<string, { revalidate: number | null }> = {};
			for (const route of builder.routes) {
				if (route.prerender !== "auto") continue;
				const revalidate = (route.config as Config | undefined)?.revalidate;
				isrRoutes[route.id] = {
					revalidate:
						typeof revalidate === "number" && revalidate > 0
							? revalidate
							: null,
				};
			}

			// Opt-in SSR micro-cache: only plain dynamic routes. Prerendered/ISR routes are
			// served from files, so a TTL there would never apply.
			const ssrCacheRoutes: Record<
				string,
				{ ttl: number; ignoreCookies: string[] }
			> = {};
			for (const route of builder.routes) {
				const raw = (route.config as Config | undefined)?.ssrCache;
				if (raw === undefined) continue;
				const ttl = typeof raw === "number" ? raw : raw?.ttl;
				if (typeof ttl !== "number" || !(ttl > 0)) {
					builder.log.warn(
						`[${ADAPTER_NAME}] ${route.id}: ssrCache needs a TTL > 0, ignoring`,
					);
					continue;
				}
				if (route.prerender) {
					builder.log.warn(
						`[${ADAPTER_NAME}] ${route.id}: ssrCache has no effect on prerendered routes, ignoring`,
					);
					continue;
				}
				const names = typeof raw === "object" ? raw.ignoreCookies : undefined;
				ssrCacheRoutes[route.id] = {
					ttl,
					ignoreCookies: Array.isArray(names)
						? names.filter((name) => typeof name === "string")
						: [],
				};
			}

			// `prerender = true` dynamic routes are stripped from the SSR manifest, so the
			// runtime can't match them via manifest.routes. Ship their patterns so unknown
			// params get an instant static 404 instead of a full SSR round-trip.
			const prerenderOnlyPatterns = builder.routes
				.filter((route) => route.prerender === true && route.id.includes("["))
				.map((route) => route.pattern.source);

			// Kit 3 removed generateManifest: generate the server instance module
			// and re-export its (otherwise private) manifest for the runtime.
			const manifestFile = join(serverDest, "manifest.js");
			builder.generateServerInstance(manifestFile, {
				serverDirectory: serverDest,
			});
			const generated = await Bun.file(manifestFile).text();
			if (!generated.includes("const manifest =")) {
				throw new Error(
					`[${ADAPTER_NAME}] Unexpected generateServerInstance output: no manifest found`,
				);
			}
			await Bun.write(
				manifestFile,
				[
					generated.replace("const manifest =", "export const manifest ="),
					`export const base = ${JSON.stringify(builder.config.paths.base)};`,
					`export const isrRoutes = ${JSON.stringify(isrRoutes)};`,
					`export const ssrCacheRoutes = ${JSON.stringify(ssrCacheRoutes)};`,
					`export const prerenderOnlyPatterns = ${JSON.stringify(prerenderOnlyPatterns)};`,
				].join("\n\n"),
			);

			/** 3. Copy the rest of the built server verbatim (single files, then dirs). */
			for (const file of [
				"index.js",
				"env.js",
				"internal.js",
				"remote-entry.js",
			]) {
				const src = join(tmp, file);
				if (existsSync(src)) cpSync(src, join(serverDest, file));
			}
			for (const dir of ["chunks", "entries", "nodes", ".vite"]) {
				const src = join(tmp, dir);
				if (existsSync(src)) await copyDir(src, join(serverDest, dir));
			}

			/** 4. Locate (or bundle) hooks.server's `websocket` export, if present. */
			const websocketModule = websockets
				? await resolveWebsocketHooks(builder, serverDest)
				: null;

			/** 5. Write the Bun entry point(s). */
			const serverFileName = cluster ? "app.js" : "index.js";
			await Bun.write(
				join(dest, serverFileName),
				generateServerCode({
					serveAssets,
					envPrefix,
					idleTimeout,
					websocketModule,
					compress,
					isrHosts: normalizedHosts,
					isrOrigin: new URL(isrOrigin).origin,
				}),
			);
			if (cluster) {
				await Bun.write(
					join(dest, "index.js"),
					generateSupervisorCode({ envPrefix }),
				);
			}

			builder.log.minor(`Adapter output written to ${dest}`);
		},

		supports: {
			read: () => true,
		},
	};
}

function validateIsrOptions(
	hosts: string[] | undefined,
	origin: string,
): string[] | undefined {
	const hostnamePattern =
		/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
	if (
		hosts !== undefined &&
		(!Array.isArray(hosts) ||
			hosts.some(
				(host) => typeof host !== "string" || !hostnamePattern.test(host),
			))
	) {
		throw new Error(
			`[${ADAPTER_NAME}] isrHosts must contain exact DNS hostnames (no scheme, port, wildcard, or path)`,
		);
	}
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error(`[${ADAPTER_NAME}] isrOrigin must be an HTTP(S) origin`);
	}
	if (
		typeof origin !== "string" ||
		!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(origin) ||
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error(
			`[${ADAPTER_NAME}] isrOrigin must be an HTTP(S) origin without credentials, path, query, or hash`,
		);
	}
	return hosts?.map((host) => host.toLowerCase());
}

/** Recursively copy a directory; siblings copy in parallel. */
async function copyDir(src: string, dest: string): Promise<void> {
	mkdirSync(dest, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });
	await Promise.all(
		entries.map((entry) => {
			const from = join(src, entry.name);
			const to = join(dest, entry.name);
			if (entry.isDirectory()) return copyDir(from, to);
			cpSync(from, to);
			return undefined;
		}),
	);
}

/** Gzip + Brotli (+ Zstd if the Bun build supports it) every compressible file in a tree. */
async function precompressDir(dir: string): Promise<void> {
	if (!existsSync(dir)) return;

	const entries = await readdir(dir, { withFileTypes: true });
	await Promise.all(
		entries.map(async (entry) => {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) return precompressDir(fullPath);

			const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
			if (SKIP_COMPRESS_EXT.has(ext)) return;

			const data = Bun.file(fullPath);
			if (data.size === 0) return;

			await Bun.write(
				`${fullPath}.gz`,
				Bun.gzipSync(await data.bytes(), { level: 9 }),
			);
			await Bun.write(
				`${fullPath}.br`,
				brotliCompressSync(await data.bytes(), {
					params: {
						[zlibConstants.BROTLI_PARAM_QUALITY]:
							zlibConstants.BROTLI_MAX_QUALITY,
						[zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.size,
					},
				}),
			);

			await Bun.write(
				`${fullPath}.zst`,
				Bun.zstdCompressSync(await data.arrayBuffer()),
			);
		}),
	);
}

/**
 * Runtime import path of the module holding hooks.server's `websocket` export.
 * Prefers SvelteKit's own compiled entry, so the runtime shares the module
 * instance SvelteKit loads and top-level code (singletons, intercept) runs once.
 */
async function resolveWebsocketHooks(
	builder: Builder,
	serverDest: string,
): Promise<string | null> {
	const hooksSrc = ["src/hooks.server.ts", "src/hooks.server.js"]
		.map((p) => join(process.cwd(), p))
		.find(existsSync);
	if (!hooksSrc) return null;

	const source = await Bun.file(hooksSrc).text();
	if (!/export\s+(const|function)\s+websocket\b/.test(source)) return null;

	if (existsSync(join(serverDest, "entries", "hooks.server.js"))) {
		return "./server/entries/hooks.server.js";
	}

	builder.log.minor("Bundling hooks.server websocket export");
	const result = await Bun.build({
		entrypoints: [hooksSrc],
		outdir: serverDest,
		naming: "hooks.js",
		target: "bun",
		format: "esm",
		external: ["$env/*", "$app/*"],
	});

	if (!result.success) {
		builder.log.warn(
			`[${ADAPTER_NAME}] Failed to bundle hooks.server for websockets, continuing without: ${result.logs.join(", ")}`,
		);
		return null;
	}
	return "./server/hooks.js";
}

/** Generates the Bun HTTP server (`app.js` or `index.js` when `cluster: false`). */
function generateServerCode(opts: {
	serveAssets: boolean;
	envPrefix: string;
	idleTimeout: number;
	websocketModule: string | null;
	compress: boolean;
	isrHosts: string[] | undefined;
	isrOrigin: string;
}): string {
	const { serveAssets, envPrefix, idleTimeout, websocketModule } = opts;

	return `
import { Server } from './server/index.js';
import { manifest, base, isrRoutes, ssrCacheRoutes, prerenderOnlyPatterns } from './server/manifest.js';
import { existsSync, statSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import { join, sep } from 'node:path';

const ADAPTER_NAME = 'svelte-adapter-bun-isr';
const REGISTRY_KEY = ${JSON.stringify(REGISTRY_KEY)};
const RUNTIME_KEY = ${JSON.stringify(RUNTIME_KEY)};
const SINGLETONS_KEY = ${JSON.stringify(SINGLETONS_KEY)};
const ENV_PREFIX = ${JSON.stringify(envPrefix)};
const DEFAULT_IDLE_TIMEOUT = ${idleTimeout};
const SERVE_ASSETS = ${JSON.stringify(serveAssets)};
const COMPRESS = ${JSON.stringify(opts.compress)};
const ISR_HOSTS = ${JSON.stringify(opts.isrHosts ?? null)};
const ISR_ORIGIN = ${JSON.stringify(opts.isrOrigin)};
const ASSET_DIR = join(import.meta.dir, 'client', base);
const PRERENDERED_DIR = join(import.meta.dir, 'prerendered');

/**
 * Read a runtime env var under ENV_PREFIX, falling back to a default. Empty,
 * blank and quoted-empty ("" or '') values count as unset: secret stores that
 * cannot hold an empty value often keep "" as a placeholder.
 */
function env(name, fallback) {
  const value = Bun.env[ENV_PREFIX + name]?.trim();
  return value === undefined || value === '' || value === '""' || value === "''" ? fallback : value;
}

const HOST = env('HOST', '0.0.0.0');
const PORT = Number(env('PORT', 3000));
const SOCKET_PATH = env('SOCKET_PATH', undefined);
const HOST_HEADER = env('HOST_HEADER', undefined);
const PROTOCOL_HEADER = env('PROTOCOL_HEADER', undefined);
const idleTimeoutRaw = env('IDLE_TIMEOUT', undefined);
const IDLE_TIMEOUT = idleTimeoutRaw === undefined ? DEFAULT_IDLE_TIMEOUT : Number(idleTimeoutRaw);
const SHUTDOWN_TIMEOUT = Number(env('SHUTDOWN_TIMEOUT', 10));
const TLS_ORIGIN_CERT = env('TLS_ORIGIN_CERT', undefined);

/** Non-negative integer env var; anything else falls back. */
function intEnv(name, fallback) {
  const value = Number(env(name, fallback));
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Publish this process' role before SvelteKit loads hooks.server, so
 * singleton() and intercept() see it on their very first call.
 */
const ROLE = env('WORKER_ROLE', 'http') === 'background' ? 'background' : 'http';
const BACKGROUND_WORKERS = intEnv('BACKGROUND_WORKERS', 0);
const runtime = (globalThis[RUNTIME_KEY] ??= { intercept: null });
runtime.sharedPath = env('SHARED_STORE_PATH', undefined);
runtime.worker = {
  role: ROLE,
  index: intEnv('WORKER_INDEX', 0),
  count: ROLE === 'background' ? Math.max(BACKGROUND_WORKERS, 1) : intEnv('WORKER_COUNT', 1) || 1,
  backgroundWorkers: BACKGROUND_WORKERS,
  standalone: false,
};

/**
 * TLS_ORIGIN_CERT holds the PEM itself, not a path: the certificate and its
 * private key in one value (e.g. a Cloudflare Origin Certificate with its key
 * appended). Literal \\n escapes are accepted for single-line secret stores.
 * The variable is removed from the environment before SvelteKit starts, so
 * $env/dynamic/private and app code never see the key.
 */
let tls;
if (ROLE === 'http' && TLS_ORIGIN_CERT) {
  const pem = TLS_ORIGIN_CERT.replace(/\\\\n/g, '\\n');
  if (!pem.includes('-----BEGIN CERTIFICATE-----') || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    throw new Error(\`[\${ADAPTER_NAME}] \${ENV_PREFIX}TLS_ORIGIN_CERT must contain both the certificate and its private key as PEM blocks\`);
  }
  tls = { cert: pem, key: pem };
}
delete Bun.env[ENV_PREFIX + 'TLS_ORIGIN_CERT'];

const server = new Server(manifest);
await server.init({
  env: Bun.env,
  read: (file) => Bun.file(join(ASSET_DIR, file)).stream(),
});
${
	websocketModule
		? `// Imported after init: for SvelteKit's own entry this is the already-loaded instance.
const { websocket } = await import(${JSON.stringify(websocketModule)});
`
		: ""
}
/**
 * Route lookup, split for speed:
 *  - static routes (no bracket segments) live in a Map -> O(1) lookup.
 *  - dynamic routes are pattern-tested in specificity order (static > matched
 *    param > plain param > rest param), preserving SvelteKit's routing
 *    priority. Only the (typically small) dynamic subset is ever scanned.
 */
const routesById = new Map(manifest.routes.map((r) => [r.id, r]));
const staticRoutes = new Map();
const dynamicRoutes = [];
function routePath(id) {
  return id.split('/').filter((segment) => !/^\\(.*\\)$/.test(segment)).join('/') || '/';
}
for (const route of manifest.routes) {
  if (route.id.includes('[')) dynamicRoutes.push(route);
  else staticRoutes.set(routePath(route.id), route);
}
dynamicRoutes.sort(compareRouteSpecificity);

function segmentWeight(seg) {
  if (seg.startsWith('[...')) return 3;
  if (seg.startsWith('[') && seg.includes('=')) return 1;
  if (seg.startsWith('[')) return 2;
  return 0; // static
}

function compareRouteSpecificity(a, b) {
  const as = routePath(a.id).split('/');
  const bs = routePath(b.id).split('/');
  const len = Math.min(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const diff = segmentWeight(as[i]) - segmentWeight(bs[i]);
    if (diff !== 0) return diff;
  }
  return as.length - bs.length;
}

/** Bounded memo of dynamic-route scans; cleared when full so hostile URL spaces can't grow it. */
const dynamicRouteCache = new Map();
const MAX_ROUTE_CACHE = 2000;
function findRouteForPath(pathname) {
  if (base && pathname !== base && !pathname.startsWith(base + '/')) return undefined;
  const relative = base ? pathname.slice(base.length) || '/' : pathname;
  const fixed = staticRoutes.get(relative);
  if (fixed !== undefined || dynamicRoutes.length === 0) return fixed;
  let route = dynamicRouteCache.get(relative);
  if (route === undefined) {
    route = dynamicRoutes.find((r) => r.pattern.test(relative)) ?? null;
    if (dynamicRouteCache.size >= MAX_ROUTE_CACHE) dynamicRouteCache.clear();
    dynamicRouteCache.set(relative, route);
  }
  return route ?? undefined;
}

function pagePath(path) {
  return path.endsWith('/__data.json') ? path.slice(0, -12) || '/' : path;
}

function dataPath(path) {
  return (path === '/' ? '' : path.replace(/\\/$/, '')) + '/__data.json';
}

/**
 * In-memory index of prerendered files: pathname -> { file, type }.
 * Built at boot, then checked against shared disk on every lookup so workers
 * observe creation, replacement, deletion, and compression invalidation.
 *
 * Not every ISR route is HTML — a prerendered \`+server.ts\` (JSON, CSV,
 * etc.) can land here too, extensionless or with its own extension, so
 * files are indexed regardless of suffix and their real content-type is
 * read from disk once at boot rather than guessed per request.
 */
const prerendered = new Map();

async function indexPrerendered(dir, routeBase) {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.isr' || entry.name.includes('.tmp-')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await indexPrerendered(abs, \`\${routeBase}/\${entry.name}\`);
      continue;
    }
    if (/\\.(br|gz|zst)$/.test(entry.name)) continue;
    const dot = entry.name.lastIndexOf('.');
    const isHtmlIndex = entry.name === 'index.html';
    const route = isHtmlIndex
      ? routeBase || '/'
      : \`\${routeBase}/\${dot > 0 && entry.name.endsWith('.html') ? entry.name.slice(0, dot) : entry.name}\`;

    // Cache file metadata at boot; lookups validate it against shared disk.
    const stats = await stat(abs);
    prerendered.set(route, {
      file: abs,
      type: Bun.file(abs).type,
      timestamp: stats.mtimeMs,
      size: stats.size,
    });
  }
}
await indexPrerendered(PRERENDERED_DIR, '');

/**
 * Client assets never change after build, so index them once: no per-request stat,
 * and the precompressed variants (br > zstd > gzip) are resolved at boot too.
 */
const clientFiles = new Map();
async function indexClientFiles() {
  if (!SERVE_ASSETS || !existsSync(ASSET_DIR)) return;
  const names = new Set();
  for (const entry of await readdir(ASSET_DIR, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) names.add(join(entry.parentPath, entry.name));
  }
  for (const abs of names) {
    const relative = abs.slice(ASSET_DIR.length).replaceAll(sep, '/');
    const encodings = [['br', '.br'], ['zstd', '.zst'], ['gzip', '.gz']]
      .filter(([, ext]) => names.has(abs + ext))
      .map(([encoding, ext]) => [encoding, Bun.file(abs + ext)]);
    const file = Bun.file(abs);
    // A compressed variant is served with the original file's type, not the .br/.gz/.zst one.
    clientFiles.set(relative, { file, type: file.type, encodings, immutable: relative.startsWith('/_app/immutable/') });
  }
}
await indexClientFiles();

/** Sync stat that treats ENOENT/ENOTDIR (missing path) as null; cheaper than an async stat on the miss path. */
function statSyncOrNull(file) {
  try {
    return statSync(file, { throwIfNoEntry: false }) ?? null;
  } catch (err) {
    if (err.code === 'ENOTDIR') return null;
    throw err;
  }
}
async function lookupPrerendered(path) {
  if (path === '/.isr' || path.startsWith('/.isr/')) return null;
  const previous = prerendered.get(path);
  // Hot path: one synchronous stat confirms the indexed file is unchanged on
  // shared disk, so peers' replacements and deletions are still seen immediately.
  if (previous) {
    const current = statSync(previous.file, { throwIfNoEntry: false });
    if (current?.isFile() && current.mtimeMs === previous.timestamp && current.size === previous.size) return previous;
  }
  const candidates = [...new Set([previous?.file, prerenderedDiskPath(path), join(PRERENDERED_DIR, path, 'index.html')].filter(Boolean))];
  for (const file of candidates) {
    const stats = statSyncOrNull(file);
    if (!stats?.isFile()) continue;
    const metadata = await readFile(metadataPath(path), 'utf8').catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
    const entry = { file, type: metadata ? JSON.parse(metadata).type : previous?.type || Bun.file(file).type, timestamp: stats.mtimeMs, size: stats.size };
    if (previous?.file === file && previous.timestamp === stats.mtimeMs && previous.size === stats.size) {
      // Unchanged on disk: keep derived per-entry caches (revalidate, encodings).
      previous.type = entry.type;
      missingPathsCache.delete(path);
      return previous;
    }
    prerendered.set(path, entry);
    missingPathsCache.delete(path);
    return entry;
  }
  prerendered.delete(path);
  return null;
}

/**
 * Disk path for a path with no prerendered entry yet (first-ever
 * regenerate of a route SvelteKit never wrote at build time). Keeps the
 * path's own extension if it has one (e.g. '/lala.csv'), otherwise
 * defaults to '.html'.
 */
function prerenderedDiskPath(path) {
  if (path === '/') return join(PRERENDERED_DIR, 'index.html');
  if (path.endsWith('/__data.json')) return join(PRERENDERED_DIR, path);
  if (findRouteForPath(path)?.page) return join(PRERENDERED_DIR, path + '.html');
  const last = path.slice(path.lastIndexOf('/') + 1);
  const hasExt = last.includes('.');
  return join(PRERENDERED_DIR, hasExt ? path : path + '.html');
}

function metadataPath(path) {
  return join(PRERENDERED_DIR, '.isr', 'types', Bun.hash(path).toString(16) + '.json');
}

/** Pick the best available precompressed variant for a file, if any. */
async function negotiateCompressed(filePath, acceptEncoding) {
  if (!acceptEncoding) return null;
  const accepts = acceptEncoding.toLowerCase();
  for (const [encoding, ext] of [['br', '.br'], ['zstd', '.zst'], ['gzip', '.gz']]) {
    if (!accepts.includes(encoding)) continue;
    const file = Bun.file(filePath + ext);
    const [source, compressed] = await Promise.all([stat(filePath).catch(() => null), stat(filePath + ext).catch(() => null)]);
    if (source?.isFile() && compressed?.isFile() && compressed.mtimeMs >= source.mtimeMs) return { file, encoding, path: filePath + ext };
  }
  return null;
}

const isrInFlight = new Set();
const MAX_IN_FLIGHT = 100; // caps concurrent background renders
const missingPathsCache = new Map();
const MAX_MISSING_CACHE = 5000; // bounded negative cache (~1MB worst case)

/** Exclusive lockfiles serialize writers across workers; recover dead owners. */
async function withPathLock(path, operation) {
  const lockDir = join(PRERENDERED_DIR, '.isr', 'locks');
  await mkdir(lockDir, { recursive: true });
  const lock = join(lockDir, Bun.hash(path).toString(16));
  let fd;
  while (!fd) {
    try {
      fd = await open(lock, 'wx');
      try { await fd.writeFile(String(process.pid)); }
      catch (err) { await fd.close(); await unlink(lock).catch(() => {}); throw err; }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Only one contender may recover a dead lock at a time. Re-read its
      // current owner under the recovery guard, so a new live lock survives.
      const recovery = lock + '.recover';
      try {
        await mkdir(recovery);
        try {
          const owner = Number(await readFile(lock, 'utf8').catch(() => ''));
          if (owner > 0) {
            try { process.kill(owner, 0); }
            catch (err) { if (err.code === 'ESRCH') await unlink(lock).catch(() => {}); }
          } else {
            const stats = await stat(lock).catch(() => null);
            if (stats && Date.now() - stats.mtimeMs > 30000) await unlink(lock).catch(() => {});
          }
        } finally { await rmdir(recovery); }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const stats = await stat(recovery).catch(() => null);
        if (stats && Date.now() - stats.mtimeMs > 30000) await rmdir(recovery).catch(() => {});
      }
      await Bun.sleep(10);
    }
  }
  try {
    return await operation();
  } finally {
    await fd.close();
    await unlink(lock);
  }
}

/** Render a complete page/data pair, then commit it under its shared writer lock. */
async function renderAndCommit(path) {
    const request = new Request(ISR_ORIGIN + path);
    const response = await server.respond(request, { getClientAddress: () => '127.0.0.1' });
    if (response.status !== 200) {
      console.warn(\`[\${ADAPTER_NAME}] regenerate \${path} -> \${response.status}, keeping existing content\`);
      return false;
    }
    const renders = [[path, response]];
    if (findRouteForPath(path)?.page) {
      const data = await server.respond(new Request(ISR_ORIGIN + dataPath(path)), { getClientAddress: () => '127.0.0.1' });
      if (data.status !== 200) {
        console.warn(\`[\${ADAPTER_NAME}] regenerate data \${path} -> \${data.status}, keeping existing content\`);
        return false;
      }
      renders.push([dataPath(path), data]);
    }
    // Consume both successful responses before touching last-known-good files.
    const writes = await Promise.all(renders.map(async ([pathname, rendered]) => {
      const file = (await lookupPrerendered(pathname))?.file ?? prerenderedDiskPath(pathname);
      const body = await rendered.arrayBuffer();
      if (pathname === dataPath(path)) {
        // SvelteKit encodes load errors and redirects in HTTP 200 data responses.
        const [payload, ...chunks] = new TextDecoder().decode(body).split('\\n').filter(Boolean).map((line) => JSON.parse(line));
        if (payload.type !== 'data' || !Array.isArray(payload.nodes) || payload.nodes.some((node) => node?.type === 'error') || chunks.some((chunk) => 'error' in chunk)) throw new Error('Data render returned an error or redirect');
      }
      return { path: pathname, file, body, type: rendered.headers.get('content-type') || Bun.file(file).type };
    }));
    // Share response MIME types too (extensionless endpoints and dotted page slugs).
    writes.push(...writes.map((write) => ({ path: null, file: metadataPath(write.path), body: JSON.stringify({ type: write.type }) })));
    const staged = [];
    const committed = [];
    try {
      for (const write of writes) {
        write.previous = await Bun.file(write.file).arrayBuffer().catch((err) => { if (err.code === 'ENOENT') return undefined; throw err; });
        if (write.previous !== undefined) write.previousStats = await stat(write.file);
        await mkdir(join(write.file, '..'), { recursive: true });
        const temp = write.file + '.tmp-' + process.pid;
        staged.push(temp);
        await Bun.write(temp, write.body);
      }
      for (let i = 0; i < writes.length; i++) {
        const write = writes[i];
        await Promise.all(['.br', '.gz', '.zst'].map((ext) => unlink(write.file + ext).catch((err) => { if (err.code !== 'ENOENT') throw err; })));
        await rename(staged[i], write.file);
        committed.push(write);
      }
      for (const write of writes) {
        const stats = await stat(write.file);
        if (write.path !== null) {
          prerendered.set(write.path, { file: write.file, type: write.type, timestamp: stats.mtimeMs, size: stats.size });
          missingPathsCache.delete(write.path);
        }
      }
    } catch (err) {
      // A failed disk commit must not leave a half-updated HTML/data pair.
      await Promise.all(committed.map(async (write) => {
        if (write.previous === undefined) await unlink(write.file);
        else {
          const rollback = write.file + '.tmp-rollback-' + process.pid;
          staged.push(rollback);
          await Bun.write(rollback, write.previous);
          await rename(rollback, write.file);
          await utimes(write.file, write.previousStats.atime, write.previousStats.mtime);
        }
      }));
      for (const write of writes) if (write.path !== null) prerendered.delete(write.path);
      throw err;
    } finally {
      await Promise.all(staged.map((file) => unlink(file).catch(() => {})));
    }
    return true;
}

/** Re-render one path via SSR and overwrite its prerendered file + index entry. */
async function regenerateIsr(path) {
  path = pagePath(path);
  if (isrInFlight.has(path) || isrInFlight.size >= MAX_IN_FLIGHT) return false;
  isrInFlight.add(path);
  try {
    return await withPathLock(path, () => renderAndCommit(path));
  } catch (err) {
    console.error(\`[\${ADAPTER_NAME}] regenerate failed for \${path}\`, err);
    return false;
  } finally {
    isrInFlight.delete(path);
  }
}

/** Expand a dynamic route id's entries() into concrete paths, e.g. '/blog/[slug]' -> '/blog/foo'. */
async function expandEntries(routeId) {
  const route = routesById.get(routeId);
  const nodeIndex = route?.page?.leaf;
  if (nodeIndex === undefined) return null;
  const node = await manifest.nodes[nodeIndex]();
  const entriesFn = node?.server?.entries ?? node?.universal?.entries;
  if (typeof entriesFn !== 'function') return [];
  const paramSets = (await entriesFn()) || [];
  return paramSets.map((params) =>
    base + routePath(routeId).replace(/\\[\\[?(\\.\\.\\.)?([^\\]=]+)(?:=[^\\]]+)?\\]\\]?/g, (_m, rest, name) => rest ? String(params[name] ?? '').split('/').map(encodeURIComponent).join('/') : encodeURIComponent(String(params[name] ?? ''))).replace(/\\/+/g, '/'),
  );
}

async function regenerateOne(path, result) {
  const existed = !!(await lookupPrerendered(path));
  const ok = await regenerateIsr(path);
  if (ok) result[existed ? 'regenerated' : 'created'].push(path);
  else result.failed.push({ path, reason: 'render failed' });
}

async function regenerateImpl(paths, removePaths) {
  const result = { regenerated: [], created: [], removed: [], failed: [] };

  function validPath(path) {
    return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\\\\?#]/.test(path) && !path.split('/').some((segment) => segment === '.' || segment === '..' || segment === '.isr');
  }

  for (const entry of paths) {
    if (!validPath(entry)) {
      result.failed.push({ path: entry, reason: 'invalid pathname' });
      continue;
    }
    if (entry.includes('[')) {
      if (!isrRoutes[entry]) {
        result.failed.push({ path: entry, reason: 'not an ISR-enabled route (prerender must be auto)' });
        continue;
      }
      const concretePaths = await expandEntries(entry).catch((err) => {
        result.failed.push({ path: entry, reason: 'entries/regeneration threw: ' + String(err) });
        return null;
      });
      if (concretePaths === null) {
        if (!result.failed.some((failure) => failure.path === entry)) result.failed.push({ path: entry, reason: 'no +page node with entries for this route id' });
        continue;
      }
      if (concretePaths.length === 0) {
        result.failed.push({ path: entry, reason: 'no +page node with entries for this route id' });
        continue;
      }
      await Promise.all(concretePaths.map((p) => regenerateOne(p, result)));
      continue;
    }

    const route = findRouteForPath(pagePath(entry));
    if (!route || !isrRoutes[route.id]) {
      result.failed.push({ path: entry, reason: 'route is not ISR-enabled (prerender must be auto)' });
      continue;
    }
    await regenerateOne(entry, result);
  }

  await Promise.all(
    removePaths.map(async (path) => {
      if (!validPath(path)) {
        result.failed.push({ path, reason: 'invalid pathname' });
        return;
      }
      const primary = pagePath(path);
      const paired = dataPath(primary);
      const entry = (await lookupPrerendered(primary)) ?? (await lookupPrerendered(paired));
      if (!entry) {
        result.failed.push({ path, reason: 'not a tracked prerendered path' });
        return;
      }
      try {
        await withPathLock(primary, async () => {
          const files = [(await lookupPrerendered(primary))?.file ?? prerenderedDiskPath(primary), (await lookupPrerendered(paired))?.file ?? prerenderedDiskPath(paired)];
          await Promise.all(files.flatMap((file) => [file, file + '.br', file + '.gz', file + '.zst']).map((file) => unlink(file).catch((err) => { if (err.code !== 'ENOENT') throw err; })));
          await Promise.all([primary, paired].map((pathname) => unlink(metadataPath(pathname)).catch((err) => { if (err.code !== 'ENOENT') throw err; })));
          for (const pathname of [primary, paired]) {
            prerendered.delete(pathname);
            missingPathsCache.delete(pathname);
          }
        });
        result.removed.push(path);
      } catch (err) {
        result.failed.push({ path, reason: String(err) });
      }
    }),
  );

  return result;
}

globalThis[REGISTRY_KEY] = { regenerate: regenerateImpl };

const isrRouteCount = Object.keys(isrRoutes).length;
if (isrRouteCount > 0 && ROLE === 'http' && runtime.worker.index === 0) {
  console.log(\`[\${ADAPTER_NAME}] ISR enabled for \${isrRouteCount} route pattern(s), serving from \${PRERENDERED_DIR}\`);
}

/** Prerender-only (\`prerender = true\`) dynamic route patterns; no SSR manifest entry exists for them. */
const prerenderOnlyRoutes = prerenderOnlyPatterns.map((source) => new RegExp(source));
function isPrerenderOnlyPath(pathname) {
  if (base && pathname !== base && !pathname.startsWith(base + '/')) return false;
  const relative = base ? pathname.slice(base.length) || '/' : pathname;
  return prerenderOnlyRoutes.some((pattern) => pattern.test(relative));
}

/** The 404 page is read (or rendered once) and then held in memory: no disk or DB access per miss. */
let notFoundPayload;
function loadNotFound() {
  return (notFoundPayload ??= (async () => {
    const fallback404Path = join(PRERENDERED_DIR, '404.html');
    const fallbackFile = Bun.file(fallback404Path);
    try {
      if (await fallbackFile.exists()) return await fallbackFile.bytes();
      const res = await server.respond(new Request(ISR_ORIGIN + '/__404__'), {
        getClientAddress: () => '127.0.0.1',
      });
      const html = new Uint8Array(await res.arrayBuffer());
      await Bun.write(fallback404Path, html);
      return html;
    } catch {
      return new TextEncoder().encode('Not Found');
    }
  })());
}
const NOT_FOUND_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

async function notFound(method) {
  const body = await loadNotFound();
  return new Response(method === 'HEAD' ? null : body, { status: 404, headers: NOT_FOUND_HEADERS });
}

/** Background processes only host singletons: no port, no request handling. */
/** True when the Accept-Encoding header lists \`name\` with a non-zero q-value. */
function acceptsEncoding(header, name) {
  for (const part of header.toLowerCase().split(',')) {
    const [token, ...params] = part.trim().split(';');
    if (token !== name) continue;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

/**
 * Runtime compression of SSR responses (\`compress: true\`). zstd first, then gzip: brotli's
 * default quality costs ~10x the CPU per response, which is why it is reserved for build-time
 * precompression. Streams through, so large or slow bodies are never buffered.
 */
function compressResponse(response, acceptEncoding, method) {
  if (!acceptEncoding || !response.body || response.status !== 200 || response.headers.has('content-encoding')) return response;
  if (/no-transform/i.test(response.headers.get('cache-control') ?? '')) return response;
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  const compressible = (type.startsWith('text/') && !type.startsWith('text/event-stream')) || type.includes('json') || type.includes('javascript') || type.includes('xml');
  if (!compressible) return response;
  const length = Number(response.headers.get('content-length'));
  if (length > 0 && length < 1024) return response;
  const encoding = acceptsEncoding(acceptEncoding, 'zstd') ? 'zstd' : acceptsEncoding(acceptEncoding, 'gzip') ? 'gzip' : null;
  if (encoding === null) return response;
  const headers = new Headers(response.headers);
  headers.set('content-encoding', encoding);
  headers.delete('content-length');
  headers.append('vary', 'Accept-Encoding');
  const etag = headers.get('etag');
  if (etag && !etag.startsWith('W/')) headers.set('etag', 'W/' + etag);
  return new Response(method === 'HEAD' ? null : response.body.pipeThrough(new CompressionStream(encoding)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Opt-in micro-cache for SSR responses (\`config.ssrCache\`), private to this worker process:
 * with reusePort every worker keeps its own copy, so staleness is bounded by the TTL and nothing
 * is shared between processes. Only anonymous GETs are served from or stored in it, keyed by the
 * full URL (host, path, query) plus the request headers the response names in \`Vary\`.
 */
const MAX_SSR_ENTRIES = 512;
const MAX_SSR_BODY = 512 * 1024;
const MAX_SSR_BYTES = 64 * 1024 * 1024;
const MAX_SSR_KEY = 2048;
const ssrEntries = new Map();
const ssrVary = new Map();
const ssrInflight = new Map();
let ssrBytes = 0;

function ssrDrop(key) {
  const entry = ssrEntries.get(key);
  if (entry === undefined) return;
  ssrBytes -= entry.size;
  ssrEntries.delete(key);
}

function ssrStore(key, entry) {
  ssrDrop(key);
  ssrEntries.set(key, entry);
  ssrBytes += entry.size;
  // Map keeps insertion order: the oldest entries go first.
  while (ssrEntries.size > MAX_SSR_ENTRIES || ssrBytes > MAX_SSR_BYTES) ssrDrop(ssrEntries.keys().next().value);
}

/** A request that may carry per-user state is never cached, whatever the cookie is called. */
function ssrCacheableRequest(request, ignoreCookies) {
  const headers = request.headers;
  if (headers.has('authorization') || headers.has('proxy-authorization')) return false;
  if (headers.has('range') || headers.has('if-range') || headers.has('if-match') || headers.has('if-none-match') || headers.has('if-modified-since')) return false;
  const cookie = headers.get('cookie');
  if (cookie) {
    if (ignoreCookies.length === 0) return false;
    for (const pair of cookie.split(';')) {
      const name = pair.split('=', 1)[0].trim();
      if (name !== '' && !ignoreCookies.includes(name)) return false;
    }
  }
  return true;
}

/**
 * Headers SvelteKit reads on every request that can't make one visitor's page differ from
 * another's once the request passed ssrCacheableRequest(): cookie/authorization are absent or
 * declared irrelevant, the rest only matter for non-GET or hop-by-hop handling. \`host\` is in the URL.
 */
const SSR_IGNORED_READS = new Set(['origin', 'content-type', 'cookie', 'connection', 'if-none-match', 'host', 'authorization', 'proxy-authorization', 'accept-encoding']);

/**
 * Copy of \`base\` whose header reads are recorded in \`reads\`, so the cache learns which request
 * headers a render depends on even when the route never sends \`Vary\`. Enumerating the headers
 * (entries, iteration, forEach) marks the render as depending on all of them.
 */
function trackRequest(base, reads) {
  const tracked = new Request(base);
  Object.defineProperty(tracked, 'headers', {
    value: new Proxy(tracked.headers, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (prop === 'get' || prop === 'has') {
          return (name) => {
            reads.names.add(String(name).toLowerCase());
            return value.call(target, name);
          };
        }
        reads.all = true;
        return value.bind(target);
      },
    }),
  });
  return tracked;
}

function ssrVaryKey(request, names) {
  let key = '';
  for (const name of names) key += '\\n' + name + ':' + (request.headers.get(name) ?? '');
  return key;
}

/** Sorted, lower-cased \`Vary\` names (\`accept-encoding\` is handled on replay); null when \`*\`. */
function ssrVaryNames(response) {
  const names = new Set();
  for (const raw of (response.headers.get('vary') ?? '').split(',')) {
    const name = raw.trim().toLowerCase();
    if (name === '*') return null;
    if (name !== '' && name !== 'accept-encoding') names.add(name);
  }
  return [...names].sort();
}

function ssrReplay(entry, state) {
  const headers = new Headers(entry.headers);
  headers.set('x-ssr-cache', state);
  return new Response(entry.body, { status: entry.status, statusText: entry.statusText, headers });
}

/** Whether a rendered response may be shared between visitors. */
function ssrCacheableResponse(response) {
  if (response.status !== 200 || !response.body) return false;
  const headers = response.headers;
  if (headers.has('set-cookie') || headers.has('content-encoding')) return false;
  if (/private|no-store|no-cache/i.test(headers.get('cache-control') ?? '')) return false;
  if ((headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream')) return false;
  const length = Number(headers.get('content-length'));
  return !(length > MAX_SSR_BODY);
}

/**
 * Serve \`request\` from the cache or render it once. Concurrent misses for the same key share a
 * single render; a response that turns out uncacheable is remembered for the TTL so the route
 * stops paying for the attempt.
 */
async function respondCached(rule, primary, request, render) {
  let names = ssrVary.get(primary);
  const key = names === undefined ? undefined : primary + ssrVaryKey(request, names);
  if (key !== undefined) {
    const entry = ssrEntries.get(key);
    if (entry !== undefined) {
      if (entry.expires > Date.now()) return entry.bypass ? render() : ssrReplay(entry, 'HIT');
      ssrDrop(key);
    }
  }
  // Before the first response the Vary names are unknown, so cold misses queue on the bare URL
  // and a follower reuses the leader's render only if its own Vary headers match the leader's.
  const flight = key ?? primary;
  const pending = ssrInflight.get(flight);
  if (pending !== undefined) {
    const shared = await pending;
    return shared !== null && ssrVaryKey(request, shared.names) === shared.varyKey ? ssrReplay(shared, 'HIT') : render();
  }

  let settle;
  ssrInflight.set(flight, new Promise((resolve) => { settle = resolve; }));
  let shared = null;
  try {
    // Header reads and the client address are recorded while rendering: whatever the app looked at
    // becomes part of the key, and anything it cannot be keyed on makes the response uncacheable.
    const reads = { names: new Set(), all: false, addr: false };
    const response = await render(reads);
    names = ssrVaryNames(response);
    const expires = Date.now() + rule.ttl * 1000;
    if (names === null || !ssrCacheableResponse(response)) {
      // Unknown vary (\`*\`) cannot be keyed at all; otherwise remember the verdict for this key.
      if (names !== null) {
        if (ssrVary.size >= MAX_SSR_ENTRIES) ssrVary.clear();
        ssrVary.set(primary, names);
        ssrStore(primary + ssrVaryKey(request, names), { bypass: true, expires, size: 0 });
      }
      return response;
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_SSR_BODY) return new Response(body, response);
    // Streamed promises may read headers while the body is buffered, so decide only now.
    if (reads.all || reads.addr) {
      if (ssrVary.size >= MAX_SSR_ENTRIES) ssrVary.clear();
      ssrVary.set(primary, names);
      ssrStore(primary + ssrVaryKey(request, names), { bypass: true, expires, size: 0 });
      return new Response(body, response);
    }
    // Keys only ever widen: a header first read on a later render joins the ones already known.
    const known = new Set(ssrVary.get(primary) ?? []);
    for (const name of names) known.add(name);
    for (const name of reads.names) if (!SSR_IGNORED_READS.has(name)) known.add(name);
    names = [...known].sort();
    const headers = [...response.headers];
    const hasLength = response.headers.has('content-length');
    if (!hasLength) headers.push(['content-length', String(body.byteLength)]);
    const varyKey = ssrVaryKey(request, names);
    shared = { body, headers, status: response.status, statusText: response.statusText, expires, size: body.byteLength, bypass: false, names, varyKey };
    if (ssrVary.size >= MAX_SSR_ENTRIES) ssrVary.clear();
    ssrVary.set(primary, names);
    ssrStore(primary + varyKey, shared);
    return ssrReplay(shared, 'MISS');
  } finally {
    ssrInflight.delete(flight);
    settle(shared);
  }
}

const bunServer = ROLE === 'background' ? null : Bun.serve({
  ...(SOCKET_PATH ? { unix: SOCKET_PATH } : { hostname: HOST, port: PORT }),
  ...(tls ? { tls } : {}),
  idleTimeout: IDLE_TIMEOUT,
  reusePort: true,
  development: false,
  ${websocketModule ? "websocket," : ""}

  async fetch(request) {
    /** 0. intercept() handlers from hooks.server: Bun-level gating before any asset, ISR or SvelteKit work. */
    const gate = runtime.intercept;
    if (gate !== null) {
      let gated = gate(request, bunServer);
      if (gated instanceof Promise) gated = await gated;
      if (gated) return gated;
    }

    const url = new URL(request.url);
    // Proxy headers are trusted only when explicitly configured. Reject ambiguous
    // authorities/protocols rather than letting them select a canonical cache.
    try {
      const host = HOST_HEADER ? request.headers.get(HOST_HEADER) : null;
      const protocol = PROTOCOL_HEADER ? request.headers.get(PROTOCOL_HEADER) : null;
      if (protocol !== null) {
        if (!/^(http|https)$/i.test(protocol)) throw new Error('Invalid protocol');
        url.protocol = protocol.toLowerCase() + ':';
      }
      if (host !== null) {
        if (!/^(?:[a-z0-9.-]+|\\[[a-f0-9:]+\\])(?::[0-9]+)?$/i.test(host)) throw new Error('Invalid host');
        const parsed = new URL(url.protocol + '//' + host);
        url.hostname = parsed.hostname;
        url.port = parsed.port;
      }
    } catch {
      return new Response('Invalid proxy headers', { status: 400 });
    }
    const effectiveRequest = url.href === request.url ? request : new Request(url, request);
    const pathname = url.pathname;
    const acceptEncoding = request.headers.get('accept-encoding');
    const safeMethod = request.method === 'GET' || request.method === 'HEAD';
    const isrHost = ISR_HOSTS === null || ISR_HOSTS.includes(url.hostname.toLowerCase());
    const cachedResponse = (body, init) => {
      const response = new Response(body, init);
      if (request.method !== 'HEAD') return response;
      if (body?.size !== undefined) response.headers.set('content-length', String(body.size));
      return new Response(null, { status: response.status, headers: response.headers });
    };

    /** 1. Static client assets (_app/*, static directory files). */
    if (SERVE_ASSETS && safeMethod) {
      const asset = clientFiles.get(pathname.startsWith(base) ? pathname.slice(base.length) : pathname);
      if (asset !== undefined) {
        const headers = asset.immutable
          ? { vary: 'Accept-Encoding', 'cache-control': 'public,max-age=31536000,immutable' }
          : { vary: 'Accept-Encoding' };
        if (acceptEncoding && asset.encodings.length > 0) {
          const accepts = acceptEncoding.toLowerCase();
          for (const [encoding, file] of asset.encodings) {
            if (!accepts.includes(encoding)) continue;
            headers['content-encoding'] = encoding;
            headers['content-type'] = asset.type;
            return cachedResponse(file, { headers });
          }
        }
        return cachedResponse(asset.file, { headers });
      }
    }

    /** Resolved once: decides whether the disk probes below can matter, and feeds steps 2-3b. */
    const route = findRouteForPath(pagePath(pathname));

    /** 2. Prerendered ISR pages — O(1) index lookup, background revalidation if stale. */
    // A matched route that isn't ISR-enabled and was never prerendered can't have a file on disk
    // (only ISR creates files at runtime), so plain SSR routes skip the stat probes entirely.
    if (SERVE_ASSETS && safeMethod && isrHost && (route === undefined || isrRoutes[route.id] !== undefined || prerendered.has(pathname))) {
      const entry = await lookupPrerendered(pathname);
      if (entry) {
        const { file: filePath, type, timestamp } = entry;

        // Cache the route lookup on the entry so we don't regex-scan routes on every request
        if (entry.revalidateSec === undefined) {
          entry.revalidateSec = route ? isrRoutes[route.id]?.revalidate ?? null : null;
        }

        if (entry.revalidateSec != null) {
          // Pure in-memory age check. No I/O blocking.
          const age = Date.now() - timestamp;
          if (age > entry.revalidateSec * 1000) regenerateIsr(pathname);
        }

        const freshFile = Bun.file(filePath);
        const headers = { 'content-type': type || 'text/html; charset=utf-8', vary: 'Accept-Encoding' };

        // Encoding choice is memoized per entry; it resets whenever the entry is replaced.
        const encodingKey = acceptEncoding ?? '';
        entry.encodings ??= new Map();
        let compressed = entry.encodings.get(encodingKey);
        if (compressed && !statSync(compressed.path, { throwIfNoEntry: false })?.isFile()) compressed = undefined;
        if (compressed === undefined) {
          compressed = await negotiateCompressed(filePath, acceptEncoding);
          if (entry.encodings.size >= 8) entry.encodings.clear();
          entry.encodings.set(encodingKey, compressed);
        }
        if (compressed) {
          headers['content-encoding'] = compressed.encoding;
          return cachedResponse(compressed.file, { headers });
        }

        return cachedResponse(freshFile, { headers });
      }
    }

    /** 3. Unknown paths under an ISR-enabled route: trigger background generation, serve static 404 now. */
    if (safeMethod && isrHost && route && isrRoutes[route.id]) {
      const revalidateSec = isrRoutes[route.id]?.revalidate;
      if (revalidateSec != null) {
        const now = Date.now();
        const lastCheck = missingPathsCache.get(pathname);
        if (!lastCheck || now - lastCheck > revalidateSec * 1000) {
          if (missingPathsCache.size >= MAX_MISSING_CACHE) missingPathsCache.clear();
          missingPathsCache.set(pathname, now);
          regenerateIsr(pathname); // writes to disk for the *next* request if it now exists
        }
      }
      return notFound(request.method);
    }

    /** 3b. \`prerender = true\` route, file not in the build: it can never exist, so 404 without touching SSR/DB. */
    if (safeMethod && isrHost && !route && isPrerenderOnlyPath(pagePath(pathname))) {
      return notFound(request.method);
    }

    /** 4. Everything else: normal dynamic SSR, through the opt-in micro-cache when the route asks for it. */
    const render = (reads) => server.respond(reads ? trackRequest(effectiveRequest, reads) : effectiveRequest, {
      platform: { server: bunServer, request: reads ? trackRequest(request, reads) : request },
      getClientAddress: () => {
        if (reads) reads.addr = true;
        return request.headers.get('x-forwarded-for') ?? '127.0.0.1';
      },
    });
    const cacheRule = route !== undefined && request.method === 'GET' ? ssrCacheRoutes[route.id] : undefined;
    const rendered = cacheRule !== undefined && url.href.length <= MAX_SSR_KEY && ssrCacheableRequest(request, cacheRule.ignoreCookies)
      ? await respondCached(cacheRule, url.href, request, render)
      : await render();
    return COMPRESS ? compressResponse(rendered, acceptEncoding, request.method) : rendered;
  },
});

if (bunServer === null) {
  // Nothing else may hold the event loop open; the supervisor would respawn us.
  setInterval(() => {}, 1 << 30);
  console.log(\`\${ADAPTER_NAME} background worker \${runtime.worker.index} ready (pid \${process.pid})\`);
} else {
  console.log(
    SOCKET_PATH
      ? \`\${ADAPTER_NAME} listening on unix socket \${SOCKET_PATH}\${tls ? ' (tls)' : ''} (pid \${process.pid})\`
      : \`\${ADAPTER_NAME} listening on \${tls ? 'https' : 'http'}://\${HOST}:\${bunServer.port} (pid \${process.pid})\`
  );
}

/** Stop accepting connections, let singleton dispose() hooks finish (bounded), then exit. */
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  bunServer?.stop();
  const disposals = [...(globalThis[SINGLETONS_KEY]?.entries() ?? [])]
    .filter(([, entry]) => entry.dispose)
    .map(async ([key, entry]) => {
      try {
        const value = await entry.value;
        await entry.dispose(value);
      } catch (err) {
        console.error(\`[\${ADAPTER_NAME}] singleton \${key} dispose failed\`, err);
      }
    });
  if (disposals.length > 0) {
    await Promise.race([Promise.all(disposals), Bun.sleep(SHUTDOWN_TIMEOUT * 1000)]);
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;
}

/** Generates the cluster supervisor (`index.js` when `cluster: true`), which spawns one worker per core. */
function generateSupervisorCode(opts: { envPrefix: string }): string {
	const { envPrefix } = opts;

	return `
import { spawn } from 'bun';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { cpus as osCpus, tmpdir } from 'node:os';
import { join } from 'node:path';

const ADAPTER_NAME = 'svelte-adapter-bun-isr';
const ENV_PREFIX = ${JSON.stringify(envPrefix)};

/** Same as the server's: empty, blank and quoted-empty values count as unset. */
function env(name, fallback) {
  const value = Bun.env[ENV_PREFIX + name]?.trim();
  return value === undefined || value === '' || value === '""' || value === "''" ? fallback : value;
}

const cpusFromEnv = Number(env('CPUS', 0));
const CPUS = cpusFromEnv > 0
  ? Math.floor(cpusFromEnv)
  : (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || osCpus().length || 1;

const backgroundFromEnv = Number(env('BACKGROUND_WORKERS', 0));
const BACKGROUND_WORKERS = Number.isInteger(backgroundFromEnv) && backgroundFromEnv > 0 ? backgroundFromEnv : 0;

const BUN_BINARY = env('BUN_BINARY', undefined) || process.execPath || 'bun';
const APP_ENTRY = join(import.meta.dir, 'app.js');

console.log(\`[\${ADAPTER_NAME}] supervisor (pid \${process.pid}) starting \${CPUS} worker(s)\${BACKGROUND_WORKERS ? \` + \${BACKGROUND_WORKERS} background worker(s)\` : ''} via \${BUN_BINARY}\`);

/**
 * One SQLite file per supervisor run: shared by its workers, fresh after a restart, RAM-backed when
 * available. It lives in a random-named 0700 directory, so other local users can neither read nor
 * tamper with it (the -wal/-shm files sit beside it), and a pre-planted path or symlink can't be
 * followed. A path given through SHARED_STORE_PATH is used as-is and never deleted.
 */
const SHARED_STORE_DIR = env('SHARED_STORE_PATH', undefined)
  ? undefined
  : mkdtempSync(join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), 'svelte-adapter-bun-isr-'));
const SHARED_STORE_PATH = env('SHARED_STORE_PATH', undefined) || join(SHARED_STORE_DIR, 'store.sqlite');
function removeSharedStore() {
  if (SHARED_STORE_DIR) rmSync(SHARED_STORE_DIR, { recursive: true, force: true });
}
{
  const { Database } = await import('bun:sqlite');
  const db = new Database(SHARED_STORE_PATH);
  for (const statement of ${JSON.stringify(SHARED_STORE_SETUP)}) db.run(statement);
  db.close();
}

let shuttingDown = false;
const workers = [];

/** Spawn a role's worker i into slot, respawning it on unexpected exit until shutdown begins. */
function spawnWorker(slot, role, i) {
  const proc = spawn({
    cmd: [BUN_BINARY, APP_ENTRY],
    env: {
      ...Bun.env,
      [ENV_PREFIX + 'WORKER_ROLE']: role,
      [ENV_PREFIX + 'WORKER_INDEX']: String(i),
      [ENV_PREFIX + 'WORKER_COUNT']: String(CPUS),
      [ENV_PREFIX + 'BACKGROUND_WORKERS']: String(BACKGROUND_WORKERS),
      [ENV_PREFIX + 'SHARED_STORE_PATH']: SHARED_STORE_PATH,
    },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  workers[slot] = proc;
  proc.exited.then((code) => {
    if (shuttingDown) return;
    console.warn(\`[\${ADAPTER_NAME}] \${role} worker \${i} (pid \${proc.pid}) exited with code \${code}, respawning\`);
    spawnWorker(slot, role, i);
  });
  return proc;
}

for (let i = 0; i < CPUS; i++) spawnWorker(i, 'http', i);
for (let i = 0; i < BACKGROUND_WORKERS; i++) spawnWorker(CPUS + i, 'background', i);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(\`[\${ADAPTER_NAME}] supervisor received \${signal}, stopping \${workers.length} worker(s)\`);
  for (const w of workers) w?.kill(signal);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => { for (const w of workers) w?.kill(); removeSharedStore(); });
`;
}
