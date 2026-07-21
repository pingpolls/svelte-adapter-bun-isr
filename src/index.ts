import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	brotliCompressSync,
	gzipSync,
	constants as zlibConstants,
} from "node:zlib";
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
	} = options;

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

			writeFileSync(
				join(serverDest, "manifest.js"),
				[
					`export const manifest = ${builder.generateManifest({ relativePath: "./" })};`,
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`,
					`export const isrRoutes = ${JSON.stringify(isrRoutes)};`,
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
			writeFileSync(
				join(dest, serverFileName),
				generateServerCode({
					serveAssets,
					envPrefix,
					idleTimeout,
					hasWebsocketExport,
				}),
			);
			if (cluster) {
				writeFileSync(
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

			const data = await readFile(fullPath);
			if (data.byteLength === 0) return;

			writeFileSync(`${fullPath}.gz`, gzipSync(data, { level: 9 }));
			writeFileSync(
				`${fullPath}.br`,
				brotliCompressSync(data, {
					params: {
						[zlibConstants.BROTLI_PARAM_QUALITY]:
							zlibConstants.BROTLI_MAX_QUALITY,
						[zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
					},
				}),
			);

			const zstdCompress = (
				Bun as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }
			).zstdCompressSync;
			if (typeof zstdCompress === "function") {
				try {
					writeFileSync(`${fullPath}.zst`, zstdCompress(data));
				} catch {
					/** zstd unsupported on this platform — skip silently */
				}
			}
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

	const source = await readFile(hooksSrc, "utf-8");
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
}): string {
	const { serveAssets, envPrefix, idleTimeout, hasWebsocketExport } = opts;

	return `
import { Server } from './server/index.js';
import { manifest, base, isrRoutes } from './server/manifest.js';
${hasWebsocketExport ? "import { websocket } from './server/hooks.js';" : ""}
import { existsSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const ADAPTER_NAME = 'svelte-adapter-bun-isr';
const REGISTRY_KEY = ${JSON.stringify(`${ADAPTER_NAME}/registry`)};
const ENV_PREFIX = ${JSON.stringify(envPrefix)};
const DEFAULT_IDLE_TIMEOUT = ${idleTimeout};
const SERVE_ASSETS = ${JSON.stringify(serveAssets)};
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
const routesById = new Map(manifest._.routes.map((r) => [r.id, r]));
const staticRoutes = new Map();
const dynamicRoutes = [];
for (const route of manifest._.routes) {
  if (route.id.includes('[')) dynamicRoutes.push(route);
  else staticRoutes.set(route.id, route);
}
dynamicRoutes.sort(compareRouteSpecificity);

function segmentWeight(seg) {
  if (seg.startsWith('[...')) return 3;
  if (seg.startsWith('[') && seg.includes('=')) return 1;
  if (seg.startsWith('[')) return 2;
  return 0; // static
}

function compareRouteSpecificity(a, b) {
  const as = a.id.split('/');
  const bs = b.id.split('/');
  const len = Math.min(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const diff = segmentWeight(as[i]) - segmentWeight(bs[i]);
    if (diff !== 0) return diff;
  }
  return as.length - bs.length;
}

function findRouteForPath(pathname) {
  return staticRoutes.get(pathname) ?? dynamicRoutes.find((r) => r.pattern.test(pathname));
}

/**
 * In-memory index of prerendered files: pathname -> { file, type }.
 * Built once at boot by walking PRERENDERED_DIR, then kept in sync by
 * regenerateIsr()/remove() so lookups never touch the filesystem.
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
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await indexPrerendered(abs, \`\${routeBase}/\${entry.name}\`);
      continue;
    }
    const dot = entry.name.lastIndexOf('.');
    const isHtmlIndex = entry.name === 'index.html';
    const route = isHtmlIndex
      ? routeBase || '/'
      : \`\${routeBase}/\${dot > 0 && entry.name.endsWith('.html') ? entry.name.slice(0, dot) : entry.name}\`;
    prerendered.set(route, { file: abs, type: Bun.file(abs).type });
  }
}
await indexPrerendered(PRERENDERED_DIR, '');

/**
 * Disk path for a path with no prerendered entry yet (first-ever
 * regenerate of a route SvelteKit never wrote at build time). Keeps the
 * path's own extension if it has one (e.g. '/lala.csv'), otherwise
 * defaults to '.html'.
 */
function prerenderedDiskPath(path) {
  if (path === '/') return join(PRERENDERED_DIR, 'index.html');
  const last = path.slice(path.lastIndexOf('/') + 1);
  const hasExt = last.includes('.');
  return join(PRERENDERED_DIR, hasExt ? path : path + '.html');
}

/** Pick the best available precompressed variant for a file, if any. */
async function negotiateCompressed(filePath, acceptEncoding) {
  if (!acceptEncoding) return null;
  const accepts = acceptEncoding.toLowerCase();
  for (const [encoding, ext] of [['br', '.br'], ['zstd', '.zst'], ['gzip', '.gz']]) {
    if (!accepts.includes(encoding)) continue;
    const file = Bun.file(filePath + ext);
    if (await file.exists()) return { file, encoding };
  }
  return null;
}

const isrInFlight = new Set();
const MAX_IN_FLIGHT = 100; // caps concurrent background renders
const missingPathsCache = new Map();
const MAX_MISSING_CACHE = 5000; // bounded negative cache (~1MB worst case)

/** Re-render one path via SSR and overwrite its prerendered file + index entry. */
async function regenerateIsr(path) {
  if (isrInFlight.has(path) || isrInFlight.size >= MAX_IN_FLIGHT) return false;
  isrInFlight.add(path);
  try {
    const request = new Request('http://isr-worker' + path);
    const response = await server.respond(request, { getClientAddress: () => '127.0.0.1' });
    if (response.status !== 200) {
      console.warn(\`[\${ADAPTER_NAME}] regenerate \${path} -> \${response.status}, keeping existing content\`);
      return false;
    }
    const filePath = prerendered.get(path)?.file ?? prerenderedDiskPath(path);
    const type = response.headers.get('content-type') || Bun.file(filePath).type;
    await Bun.write(filePath, await response.arrayBuffer());
    await Promise.all(['.br', '.gz', '.zst'].map((ext) => unlink(filePath + ext).catch(() => {})));
    prerendered.set(path, { file: filePath, type });
    return true;
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
  const node = await manifest._.nodes[nodeIndex]();
  const entriesFn = node?.server?.entries ?? node?.universal?.entries;
  if (typeof entriesFn !== 'function') return [];
  const paramSets = (await entriesFn()) || [];
  return paramSets.map((params) =>
    routeId.replace(/\\[(\\.\\.\\.)?([^\\]]+)\\]/g, (_m, _rest, name) => String(params[name] ?? '')),
  );
}

async function regenerateOne(path, result) {
  const existed = prerendered.has(path);
  const ok = await regenerateIsr(path);
  if (ok) result[existed ? 'regenerated' : 'created'].push(path);
  else result.failed.push({ path, reason: 'render failed' });
}

async function regenerateImpl(paths, removePaths) {
  const result = { regenerated: [], created: [], removed: [], failed: [] };

  for (const entry of paths) {
    if (entry.includes('[')) {
      if (!isrRoutes[entry]) {
        result.failed.push({ path: entry, reason: 'not an ISR-enabled route (prerender must be auto)' });
        continue;
      }
      const concretePaths = await expandEntries(entry).catch((err) => {
        result.failed.push({ path: entry, reason: 'entries/regeneration threw: ' + String(err) });
        return null;
      });
      if (concretePaths === null) continue;
      if (concretePaths.length === 0) {
        result.failed.push({ path: entry, reason: 'no +page node with entries for this route id' });
        continue;
      }
      await Promise.all(concretePaths.map((p) => regenerateOne(p, result)));
      continue;
    }

    const route = findRouteForPath(entry);
    if (!route || !isrRoutes[route.id]) {
      result.failed.push({ path: entry, reason: 'route is not ISR-enabled (prerender must be auto)' });
      continue;
    }
    await regenerateOne(entry, result);
  }

  await Promise.all(
    removePaths.map(async (path) => {
      const entry = prerendered.get(path);
      if (!entry) {
        result.failed.push({ path, reason: 'not a tracked prerendered path' });
        return;
      }
      const filePath = entry.file;
      try {
        await Promise.all(
          [filePath, filePath + '.br', filePath + '.gz', filePath + '.zst'].map((f) =>
            unlink(f).catch(() => {}),
          ),
        );
        prerendered.delete(path);
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

/** Serve (and lazily cache) the static 404 page for ISR-blocked paths. */
async function get404Response() {
  const fallback404Path = join(PRERENDERED_DIR, '404.html');
  const fallbackFile = Bun.file(fallback404Path);
  if (await fallbackFile.exists()) {
    return new Response(fallbackFile, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  try {
    const res = await server.respond(new Request('http://isr-worker/__404__'), {
      getClientAddress: () => '127.0.0.1',
    });
    const html = await res.arrayBuffer();
    await Bun.write(fallback404Path, html);
    return new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

const bunServer = Bun.serve({
  ...(SOCKET_PATH ? { unix: SOCKET_PATH } : { hostname: HOST, port: PORT }),
  idleTimeout: IDLE_TIMEOUT,
  reusePort: true,
  development: false,
  ${hasWebsocketExport ? "websocket," : ""}

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const acceptEncoding = request.headers.get('accept-encoding');

    /** 1. Static client assets (_app/*, static directory files). */
    if (SERVE_ASSETS) {
      const relativePath = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
      if (relativePath !== '/' && relativePath !== '') {
        const assetPath = join(ASSET_DIR, relativePath);
        const assetFile = Bun.file(assetPath);
        if (await assetFile.exists()) {
          const headers = { vary: 'Accept-Encoding' };
          if (relativePath.startsWith('/_app/immutable/')) {
            headers['cache-control'] = 'public,max-age=31536000,immutable';
          }
          const compressed = await negotiateCompressed(assetPath, acceptEncoding);
          if (compressed) {
            headers['content-encoding'] = compressed.encoding;
            return new Response(compressed.file, { headers });
          }
          return new Response(assetFile, { headers });
        }
      }
    }

    /** 2. Prerendered ISR pages — O(1) index lookup, background revalidation if stale. */
    if (SERVE_ASSETS) {
      const entry = prerendered.get(pathname);
      if (entry) {
        const { file: filePath, type } = entry;
        const route = findRouteForPath(pathname);
        const revalidateSec = route ? isrRoutes[route.id]?.revalidate : null;

        if (revalidateSec != null) {
          try {
            const age = Date.now() - (await stat(filePath)).mtimeMs;
            if (age > revalidateSec * 1000) regenerateIsr(pathname);
          } catch {
            regenerateIsr(pathname);
          }
        }

        const freshFile = Bun.file(filePath);
        const headers = { 'content-type': type || 'text/html; charset=utf-8', vary: 'Accept-Encoding' };
        const compressed = await negotiateCompressed(filePath, acceptEncoding);
        if (compressed) {
          headers['content-encoding'] = compressed.encoding;
          return new Response(compressed.file, { headers });
        }
        return new Response(freshFile, { headers });
      }
    }

    /** 3. Unknown paths under an ISR-enabled route: trigger background generation, serve static 404 now. */
    const route = findRouteForPath(pathname);
    if (route && isrRoutes[route.id]) {
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
      return get404Response();
    }

    /** 4. Everything else: normal dynamic SSR. */
    return server.respond(request, {
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
