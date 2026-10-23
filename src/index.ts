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
	/** Emit gzip + brotli (+ zstd if available) variants at build time. Default: true */
	precompress?: boolean;
	/** Prefix applied to runtime env vars (HOST, PORT, ...). Default: '' */
	envPrefix?: string;
	/** Build-time default idle timeout in seconds; runtime env wins. Default: 10 */
	idleTimeout?: number;
	/** Bundle hooks.server's `websocket` export into Bun.serve. Default: true */
	websockets?: boolean;
	/** Spawn one worker per core behind SO_REUSEPORT via a supervisor. If this enabled, adapter will generate two file, `app.js` and `index.js` while the `index.js` file will consist of Bun spawn commands running `app.js` file. Default: true */
	cluster?: boolean;
	/** Hostnames allowed to serve prerendered/ISR content. Omitted: all hosts; []: none. */
	isrHosts?: string[];
	/** HTTP(S) origin used for ISR renders and the fallback 404. Default: 'http://isr-worker' */
	isrOrigin?: string;
}

/** Per-route config read from `export const config = { revalidate }`. */
export interface Config {
	revalidate?: number;
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

const ADAPTER_NAME = "@pingpolls/svelte-adapter-bun-isr";
const REGISTRY_KEY = `${ADAPTER_NAME}/registry`;

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
		precompress = true,
		envPrefix = "",
		idleTimeout = 10,
		websockets = true,
		cluster = true,
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

			/** 4. Bundle hooks.server's `websocket` export, if present. */
			const hasWebsocketExport =
				websockets && (await bundleWebsocketHooks(builder, serverDest));

			/** 5. Write the Bun entry point(s). */
			const serverFileName = cluster ? "app.js" : "index.js";
			await Bun.write(
				join(dest, serverFileName),
				generateServerCode({
					serveAssets,
					envPrefix,
					idleTimeout,
					hasWebsocketExport,
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

/** Bundle `hooks.server`'s `websocket` export for Bun.serve, if the app defines one. */
async function bundleWebsocketHooks(
	builder: Builder,
	serverDest: string,
): Promise<boolean> {
	const hooksSrc = ["src/hooks.server.ts", "src/hooks.server.js"]
		.map((p) => join(process.cwd(), p))
		.find(existsSync);
	if (!hooksSrc) return false;

	const source = await Bun.file(hooksSrc).text();
	if (!/export\s+(const|function)\s+websocket\b/.test(source)) return false;

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
		return false;
	}
	return true;
}

/** Generates the Bun HTTP server (`app.js` or `index.js` when `cluster: false`). */
function generateServerCode(opts: {
	serveAssets: boolean;
	envPrefix: string;
	idleTimeout: number;
	hasWebsocketExport: boolean;
	isrHosts: string[] | undefined;
	isrOrigin: string;
}): string {
	const { serveAssets, envPrefix, idleTimeout, hasWebsocketExport } = opts;

	return `
import { Server } from './server/index.js';
import { manifest, base, isrRoutes, prerenderOnlyPatterns } from './server/manifest.js';
${hasWebsocketExport ? "import { websocket } from './server/hooks.js';" : ""}
import { existsSync, statSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';

const ADAPTER_NAME = 'svelte-adapter-bun-isr';
const REGISTRY_KEY = ${JSON.stringify(`${ADAPTER_NAME}/registry`)};
const ENV_PREFIX = ${JSON.stringify(envPrefix)};
const DEFAULT_IDLE_TIMEOUT = ${idleTimeout};
const SERVE_ASSETS = ${JSON.stringify(serveAssets)};
const ISR_HOSTS = ${JSON.stringify(opts.isrHosts ?? null)};
const ISR_ORIGIN = ${JSON.stringify(opts.isrOrigin)};
const ASSET_DIR = join(import.meta.dir, 'client', base);
const PRERENDERED_DIR = join(import.meta.dir, 'prerendered');

/** Read a runtime env var under ENV_PREFIX, falling back to a default. */
function env(name, fallback) {
  const value = Bun.env[ENV_PREFIX + name];
  return value === undefined ? fallback : value;
}

const HOST = env('HOST', '0.0.0.0');
const PORT = Number(env('PORT', 3000));
const SOCKET_PATH = env('SOCKET_PATH', undefined);
const HOST_HEADER = env('HOST_HEADER', undefined);
const PROTOCOL_HEADER = env('PROTOCOL_HEADER', undefined);
const idleTimeoutRaw = env('IDLE_TIMEOUT', undefined);
const IDLE_TIMEOUT = idleTimeoutRaw === undefined ? DEFAULT_IDLE_TIMEOUT : Number(idleTimeoutRaw);

const server = new Server(manifest);
await server.init({
  env: Bun.env,
  read: (file) => Bun.file(join(ASSET_DIR, file)).stream(),
});

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

function findRouteForPath(pathname) {
  if (base && pathname !== base && !pathname.startsWith(base + '/')) return undefined;
  const relative = base ? pathname.slice(base.length) || '/' : pathname;
  return staticRoutes.get(relative) ?? dynamicRoutes.find((r) => r.pattern.test(relative));
}

function pagePath(path) {
  return path.replace(/\\/__data\\.json$/, '') || '/';
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

/** Sync stat that treats ENOENT/ENOTDIR (missing path) as null; cheaper than an async stat on the miss path. */
function statSyncOrNull(file) {
  try {
    return statSync(file, { throwIfNoEntry: false }) ?? null;
  } catch (err) {
    if (err.code === 'ENOTDIR') return null;
    throw err;
  }
}
function isFileSync(file) {
  return statSyncOrNull(file)?.isFile() === true;
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

const workerIndex = env('WORKER_INDEX', undefined);
const isrRouteCount = Object.keys(isrRoutes).length;
if (isrRouteCount > 0 && (workerIndex === undefined || workerIndex === '0')) {
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

const bunServer = Bun.serve({
  ...(SOCKET_PATH ? { unix: SOCKET_PATH } : { hostname: HOST, port: PORT }),
  idleTimeout: IDLE_TIMEOUT,
  reusePort: true,
  development: false,
  ${hasWebsocketExport ? "websocket," : ""}

  async fetch(request) {
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
      const relativePath = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
      if (relativePath !== '/' && relativePath !== '') {
        const assetPath = join(ASSET_DIR, relativePath);
        const assetFile = Bun.file(assetPath);
        if (isFileSync(assetPath)) {
          const headers = { vary: 'Accept-Encoding' };
          if (relativePath.startsWith('/_app/immutable/')) {
            headers['cache-control'] = 'public,max-age=31536000,immutable';
          }
          const compressed = await negotiateCompressed(assetPath, acceptEncoding);
          if (compressed) {
            headers['content-encoding'] = compressed.encoding;
            return cachedResponse(compressed.file, { headers });
          }
          return cachedResponse(assetFile, { headers });
        }
      }
    }

    /** 2. Prerendered ISR pages — O(1) index lookup, background revalidation if stale. */
    if (SERVE_ASSETS && safeMethod && isrHost) {
      const entry = await lookupPrerendered(pathname);
      if (entry) {
        const { file: filePath, type, timestamp } = entry;

        // Cache the route lookup on the entry so we don't regex-scan routes on every request
        if (entry.revalidateSec === undefined) {
          const route = findRouteForPath(pagePath(pathname));
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
    const route = findRouteForPath(pagePath(pathname));
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

    /** 4. Everything else: normal dynamic SSR. */
    return server.respond(effectiveRequest, {
      platform: { server: bunServer, request },
      getClientAddress: () => request.headers.get('x-forwarded-for') ?? '127.0.0.1',
    });
  },
});

console.log(
  SOCKET_PATH
    ? \`\${ADAPTER_NAME} listening on unix socket \${SOCKET_PATH} (pid \${process.pid})\`
    : \`\${ADAPTER_NAME} listening on http://\${HOST}:\${bunServer.port} (pid \${process.pid})\`
);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

/** Generates the cluster supervisor (`index.js` when `cluster: true`), which spawns one worker per core. */
function generateSupervisorCode(opts: { envPrefix: string }): string {
	const { envPrefix } = opts;

	return `
import { spawn } from 'bun';
import { cpus as osCpus } from 'node:os';
import { join } from 'node:path';

const ADAPTER_NAME = 'svelte-adapter-bun-isr';
const ENV_PREFIX = ${JSON.stringify(envPrefix)};

function env(name, fallback) {
  const value = Bun.env[ENV_PREFIX + name];
  return value === undefined ? fallback : value;
}

const cpusFromEnv = Number(env('CPUS', 0));
const CPUS = cpusFromEnv > 0
  ? Math.floor(cpusFromEnv)
  : (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || osCpus().length || 1;

const BUN_BINARY = env('BUN_BINARY', undefined) || process.execPath || 'bun';
const APP_ENTRY = join(import.meta.dir, 'app.js');

console.log(\`[\${ADAPTER_NAME}] supervisor (pid \${process.pid}) starting \${CPUS} worker(s) via \${BUN_BINARY}\`);

let shuttingDown = false;
const workers = new Array(CPUS);

/** Spawn worker i, respawning it on unexpected exit until shutdown begins. */
function spawnWorker(i) {
  const proc = spawn({
    cmd: [BUN_BINARY, APP_ENTRY],
    env: { ...Bun.env, [ENV_PREFIX + 'WORKER_INDEX']: String(i) },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  workers[i] = proc;
  proc.exited.then((code) => {
    if (shuttingDown) return;
    console.warn(\`[\${ADAPTER_NAME}] worker \${i} (pid \${proc.pid}) exited with code \${code}, respawning\`);
    spawnWorker(i);
  });
  return proc;
}

for (let i = 0; i < CPUS; i++) spawnWorker(i);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(\`[\${ADAPTER_NAME}] supervisor received \${signal}, stopping \${CPUS} worker(s)\`);
  for (const w of workers) w?.kill(signal);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => { for (const w of workers) w?.kill(); });
`;
}
