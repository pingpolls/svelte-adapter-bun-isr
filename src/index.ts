import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	brotliCompressSync,
	gzipSync,
	constants as zlibConstants,
} from "node:zlib";
import type { Adapter, Builder } from "@sveltejs/kit";

interface AdapterOptions {
	/** Output directory for the generated server. Default: 'build' */
	out?: string;
	/**
	 * Serve client and prerendered assets from Bun (incl. range requests).
	 * Set false if a reverse proxy / CDN serves them instead. Default: true
	 */
	serveAssets?: boolean;
	/**
	 * Emit gzip + brotli (+ zstd if available) variants of assets and
	 * prerendered pages at build time. Default: true
	 */
	precompress?: boolean;
	/**
	 * Prefix applied to runtime env vars read by the generated server
	 * (HOST, PORT, SOCKET_PATH, IDLE_TIMEOUT, CPUS, BUN_BINARY). Default: ''
	 */
	envPrefix?: string;
	/**
	 * Build-time default for Bun's idle timeout (seconds). Runtime
	 * `${envPrefix}IDLE_TIMEOUT` wins if set. Default: 10
	 */
	idleTimeout?: number;
	/**
	 * Bundle `hooks.server`'s `websocket` export and wire it into
	 * Bun.serve. Set false for plain HTTP apps. Default: true
	 */
	websockets?: boolean;
	/**
	 * Emit a `build/index.js` supervisor that spawns `build/app.js` across
	 * multiple worker processes (bound with SO_REUSEPORT) for multi-core
	 * throughput.
	 */
	cluster?: boolean;
}

export interface Config {
	revalidate?: number;
}

export interface RegenerateResult {
	/** Existing prerendered paths whose load function was re-run and file rewritten. */
	regenerated: string[];
	/** Brand-new paths written for the first time (via entries() or a fresh explicit path). */
	created: string[];
	/** Paths whose prerendered file (+ compressed variants) were deleted. */
	removed: string[];
	/** Anything that didn't work, with a reason. */
	failed: { path: string; reason: string }[];
}

const ADAPTER_NAME = "@pingpolls/svelte-adapter-bun-isr";
const REGISTRY_SYMBOL_KEY = `${ADAPTER_NAME}/registry`;

export function regenerate(
	paths: string[],
	removePaths: string[] = [],
): Promise<RegenerateResult> {
	const registry = (
		globalThis as unknown as Record<
			string,
			| { regenerate: (p: string[], r: string[]) => Promise<RegenerateResult> }
			| undefined
		>
	)[REGISTRY_SYMBOL_KEY as unknown as string] as
		| { regenerate: (p: string[], r: string[]) => Promise<RegenerateResult> }
		| undefined;

	if (!registry) {
		throw new Error(
			`[${ADAPTER_NAME}] regenerate() has no runtime server to talk to. This only works ` +
				"while build/app.js (or build/index.js with cluster:false) is actually running, " +
				"called from inside a request — e.g. a +server.ts endpoint.",
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

			builder.rimraf(dest);
			builder.rimraf(tmp);
			mkdirSync(tmp, { recursive: true });

			// 1. Copy client assets
			builder.log.minor("Copying client assets");
			builder.writeClient(join(dest, "client"));

			// 2. Copy prerendered pages
			builder.log.minor("Copying prerendered pages");
			builder.writePrerendered(join(dest, "prerendered"));

			// 2b. Precompress client + prerendered assets
			if (precompress) {
				builder.log.minor("Precompressing assets");
				await precompressDir(join(dest, "client"));
				await precompressDir(join(dest, "prerendered"));
			}

			// 3. Write server code to temp dir
			builder.log.minor("Building server");
			builder.writeServer(tmp);

			// 4. Generate route manifest
			const isrRoutes: Record<string, { revalidate: number | null }> = {};

			for (const route of builder.routes) {
				if (route.prerender !== "auto") continue;

				const revalidate = (route.config as Config | undefined)?.revalidate;
				const normalizedRevalidate =
					typeof revalidate === "number" && revalidate > 0 ? revalidate : null;

				isrRoutes[route.id] = { revalidate: normalizedRevalidate };
			}

			writeFileSync(
				join(tmp, "manifest.js"),
				[
					`export const manifest = ${builder.generateManifest({ relativePath: "./" })};`,
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`,
					`export const isrRoutes = ${JSON.stringify(isrRoutes)};`,
				].join("\n\n"),
			);

			// 5. Copy server artifacts to dest
			const serverDest = join(dest, "server");
			mkdirSync(serverDest, { recursive: true });

			cpSync(join(tmp, "manifest.js"), join(serverDest, "manifest.js"));

			const serverIndex = join(tmp, "index.js");
			if (existsSync(serverIndex)) {
				cpSync(serverIndex, join(serverDest, "index.js"));
			}

			const serverChunksDir = join(tmp, "chunks");
			if (existsSync(serverChunksDir)) {
				const destChunksDir = join(serverDest, "chunks");
				mkdirSync(destChunksDir, { recursive: true });
				const chunks = await readdir(serverChunksDir);
				for (const chunk of chunks) {
					cpSync(join(serverChunksDir, chunk), join(destChunksDir, chunk));
				}
			}

			const serverEntriesDir = join(tmp, "entries");
			if (existsSync(serverEntriesDir)) {
				await copyDirAsync(serverEntriesDir, join(serverDest, "entries"));
			}

			const serverNodesDir = join(tmp, "nodes");
			if (existsSync(serverNodesDir)) {
				await copyDirAsync(serverNodesDir, join(serverDest, "nodes"));
			}

			const singleFiles = ["env.js", "internal.js", "remote-entry.js"];
			for (const name of singleFiles) {
				const src = join(tmp, name);
				if (existsSync(src)) {
					cpSync(src, join(serverDest, name));
				}
			}

			const viteManifest = join(tmp, ".vite");
			if (existsSync(viteManifest)) {
				await copyDirAsync(viteManifest, join(serverDest, ".vite"));
			}

			// 5b. Bundle hooks.server's websocket export if present
			let hasWebsocketExport = false;
			if (websockets) {
				const hooksSrc = ["src/hooks.server.ts", "src/hooks.server.js"]
					.map((p) => join(process.cwd(), p))
					.find((p) => existsSync(p));

				if (hooksSrc) {
					const source = await readFile(hooksSrc, "utf-8");
					if (/export\s+(const|function)\s+websocket\b/.test(source)) {
						builder.log.minor("Bundling hooks.server websocket export");
						const result = await Bun.build({
							entrypoints: [hooksSrc],
							outdir: serverDest,
							naming: "hooks.js",
							target: "bun",
							format: "esm",
							external: ["$env/*", "$app/*"],
						});
						if (result.success) {
							hasWebsocketExport = true;
						} else {
							builder.log.warn(
								`[${ADAPTER_NAME}] Failed to bundle hooks.server for websockets, ` +
									`continuing without websocket support: ${result.logs.join(", ")}`,
							);
						}
					}
				}
			}

			// 6. Write Bun server entry point
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

async function copyDirAsync(src: string, dest: string) {
	mkdirSync(dest, { recursive: true });
	const entries = await readdir(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			await copyDirAsync(srcPath, destPath);
		} else {
			cpSync(srcPath, destPath);
		}
	}
}

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

async function precompressDir(dir: string) {
	if (!existsSync(dir)) return;

	const walk = async (current: string): Promise<void> => {
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}

			const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
			if (SKIP_COMPRESS_EXT.has(ext)) continue;

			const data = await readFile(fullPath);
			if (data.byteLength === 0) continue;

			const gz = gzipSync(data, { level: 9 });
			writeFileSync(`${fullPath}.gz`, gz);

			const br = brotliCompressSync(data, {
				params: {
					[zlibConstants.BROTLI_PARAM_QUALITY]:
						zlibConstants.BROTLI_MAX_QUALITY,
					[zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
				},
			});
			writeFileSync(`${fullPath}.br`, br);

			const zstdCompress = (
				Bun as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }
			).zstdCompressSync;
			if (typeof zstdCompress === "function") {
				try {
					const zst = zstdCompress(data);
					writeFileSync(`${fullPath}.zst`, zst);
				} catch {
					// ignore
				}
			}
		}
	};

	await walk(dir);
}

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
import { join } from 'node:path';
import { stat, unlink } from 'node:fs/promises';

const ADAPTER_NAME = 'svelte-adapter-bun-isr';
const REGISTRY_KEY = ${JSON.stringify(`${ADAPTER_NAME}/registry`)};
const ENV_PREFIX = ${JSON.stringify(envPrefix)};
const DEFAULT_IDLE_TIMEOUT = ${idleTimeout};
const SERVE_ASSETS = ${JSON.stringify(serveAssets)};
const ASSET_DIR = join(import.meta.dir, 'client', base);
const PRERENDERED_DIR = join(import.meta.dir, 'prerendered');

function env(name, fallback) {
  const value = Bun.env[ENV_PREFIX + name];
  return value === undefined ? fallback : value;
}

const HOST = env('HOST', '0.0.0.0');
const PORT = Number(env('PORT', 3000));
const SOCKET_PATH = env('SOCKET_PATH', undefined);

const idleTimeoutRaw = env('IDLE_TIMEOUT', undefined);
const IDLE_TIMEOUT =
  idleTimeoutRaw === undefined ? DEFAULT_IDLE_TIMEOUT : Number(idleTimeoutRaw);

const server = new Server(manifest);

// Precompute route order once: static > matched params > plain params
// > rest params. Lookups then stay a simple linear find with no
// per-request sorting or recursion.
const sortedRoutes = [...manifest._.routes].sort(compareRouteSpecificity);

await server.init({
  env: Bun.env,
  read: (file) => Bun.file(join(ASSET_DIR, file)).stream(),
});

async function negotiateCompressed(filePath, acceptEncoding) {
  if (!acceptEncoding) return null;
  const accepts = acceptEncoding.toLowerCase();
  const candidates = [
    ['br', filePath + '.br'],
    ['zstd', filePath + '.zst'],
    ['gzip', filePath + '.gz'],
  ];
  for (const [encoding, candidatePath] of candidates) {
    if (!accepts.includes(encoding)) continue;
    const f = Bun.file(candidatePath);
    if (await f.exists()) return { file: f, encoding };
  }
  return null;
}

// Lower weight = more specific. Static segments always win over
// dynamic ones; matched params ([x=matcher]) beat plain params ([x]);
// rest params ([...x]) are least specific.
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
    const wa = segmentWeight(as[i]);
    const wb = segmentWeight(bs[i]);
    if (wa !== wb) return wa - wb;
  }
  return as.length - bs.length;
}

function findRouteForPath(path) {
  return sortedRoutes.find((r) => r.pattern.test(path));
}
// Zero-memory cluster-safe file resolver
async function getPrerenderedFilePath(path) {
  const normalized = path === '/' || path === '' ? '/index' : path;
  const candidates = [
    join(PRERENDERED_DIR, normalized + '.html'),
    join(PRERENDERED_DIR, path, 'index.html'),
    join(PRERENDERED_DIR, path),
  ];
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

function getPrerenderedDiskPath(path) {
  if (path === '/' || path === '') return join(PRERENDERED_DIR, 'index.html');
  return join(PRERENDERED_DIR, path + '.html');
}

const isrInFlight = new Set();
const MAX_IN_FLIGHT = 100; // Limit concurrent background renders to prevent Promise OOM
const missingPathsCache = new Map();
const MAX_MISSING_CACHE = 5000; // Capped negative cache (takes less than 1MB memory)

async function regenerateIsr(path) {
  if (isrInFlight.has(path) || isrInFlight.size >= MAX_IN_FLIGHT) return false;
  isrInFlight.add(path);
  try {
    const request = new Request('http://isr-worker' + path);
    const response = await server.respond(request, {
      getClientAddress: () => '127.0.0.1',
    });
    if (response.status === 200) {
      const existingPath = await getPrerenderedFilePath(path);
      const filePath = existingPath || getPrerenderedDiskPath(path);

      await Bun.write(filePath, await response.arrayBuffer());

      for (const ext of ['.br', '.gz', '.zst']) {
        await unlink(filePath + ext).catch(() => {});
      }
      return true;
    }
    console.warn(\`[\${ADAPTER_NAME}] regenerate \${path} -> \${response.status}, keeping existing content\`);
    return false;
  } catch (err) {
    console.error(\`[\${ADAPTER_NAME}] regenerate failed for \${path}\`, err);
    return false;
  } finally {
    isrInFlight.delete(path);
  }
}

async function regenerateImpl(paths, removePaths) {
  const result = { regenerated: [], created: [], removed: [], failed: [] };

  for (const entry of paths) {
    if (entry.includes('[')) {
      const routeCfg = isrRoutes[entry];
      if (!routeCfg) {
        result.failed.push({ path: entry, reason: 'not an ISR-enabled route (prerender must be auto)' });
        continue;
      }
      const route = manifest._.routes.find((r) => r.id === entry);
      if (!route) {
        result.failed.push({ path: entry, reason: 'route not found in runtime manifest' });
        continue;
      }

      const nodeIndex = route.page && typeof route.page.leaf === 'number' ? route.page.leaf : undefined;
      if (nodeIndex === undefined) {
        result.failed.push({ path: entry, reason: 'no +page node with entries for this route id' });
        continue;
      }

      try {
        const node = await manifest._.nodes[nodeIndex]();
        const entriesFn = node?.server?.entries ?? node?.universal?.entries;

        let paramSets = [];
        if (typeof entriesFn === 'function') {
          paramSets = (await entriesFn()) || [];
        }

        if (!paramSets || paramSets.length === 0) {
          continue;
        }

        for (const params of paramSets) {
          const concretePath = entry.replace(/\\[(\\.\\.\\.)?([^\\]]+)\\]/g, (_m, _rest, name) => {
            const value = params[name];
            return value === undefined ? '' : String(value);
          });
          const existingPath = await getPrerenderedFilePath(concretePath);
          const ok = await regenerateIsr(concretePath);
          if (ok) {
            result[existingPath ? 'regenerated' : 'created'].push(concretePath);
          } else {
            result.failed.push({ path: concretePath, reason: 'render failed' });
          }
        }
      } catch (err) {
        result.failed.push({ path: entry, reason: 'entries/regeneration threw: ' + String(err) });
      }
      continue;
    }

    const route = findRouteForPath(entry);
    if (!route || !isrRoutes[route.id]) {
      result.failed.push({ path: entry, reason: 'route is not ISR-enabled (prerender must be auto)' });
      continue;
    }

    const existingPath = await getPrerenderedFilePath(entry);
    const ok = await regenerateIsr(entry);
    if (ok) {
      result[existingPath ? 'regenerated' : 'created'].push(entry);
    } else {
      result.failed.push({ path: entry, reason: 'render failed' });
    }
  }

  for (const path of removePaths) {
    const filePath = await getPrerenderedFilePath(path);
    if (!filePath) {
      result.failed.push({ path, reason: 'not a tracked prerendered path' });
      continue;
    }
    try {
      await unlink(filePath).catch(() => {});
      for (const ext of ['.br', '.gz', '.zst']) {
        await unlink(filePath + ext).catch(() => {});
      }
      result.removed.push(path);
    } catch (err) {
      result.failed.push({ path, reason: String(err) });
    }
  }

  return result;
}

globalThis[REGISTRY_KEY] = { regenerate: regenerateImpl };

const workerIndex = env('WORKER_INDEX', undefined);
const isrRouteCount = Object.keys(isrRoutes).length;
if (isrRouteCount > 0 && (workerIndex === undefined || workerIndex === '0')) {
  console.log(\`[\${ADAPTER_NAME}] ISR enabled for \${isrRouteCount} route pattern(s), serving from \${PRERENDERED_DIR}\`);
}

async function get404Response() {
  const fallback404Path = join(PRERENDERED_DIR, '404.html');
  const fallbackFile = Bun.file(fallback404Path);

  if (await fallbackFile.exists()) {
    return new Response(fallbackFile, {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  try {
    const res = await server.respond(new Request('http://isr-worker/__404__'), {
      getClientAddress: () => '127.0.0.1',
    });
    const html = await res.arrayBuffer();
    await Bun.write(fallback404Path, html);

    return new Response(html, {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
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

    // 1. Static Client Assets (_app/*, static directory files)
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

    // 2. Prerendered ISR Pages
    if (SERVE_ASSETS) {
      const filePath = await getPrerenderedFilePath(pathname);

      if (filePath) {
        const route = findRouteForPath(pathname);
        const revalidateSec = route ? isrRoutes[route.id]?.revalidate : null;

        if (revalidateSec !== undefined && revalidateSec !== null) {
          try {
            const fileStat = await stat(filePath);
            const age = Date.now() - fileStat.mtimeMs;
            if (age > revalidateSec * 1000) {
              regenerateIsr(pathname);
            }
          } catch {
            regenerateIsr(pathname);
          }
        }

        const freshFile = Bun.file(filePath);
        const headers = {
          'content-type': freshFile.type || 'text/html; charset=utf-8',
          vary: 'Accept-Encoding'
        };

        const compressed = await negotiateCompressed(filePath, acceptEncoding);
        if (compressed) {
          headers['content-encoding'] = compressed.encoding;
          return new Response(compressed.file, { headers });
        }

        return new Response(freshFile, { headers });
      }
    }

    // 3. Block dynamic SSR for unknown ISR paths (Bounded Negative Caching)
    const route = findRouteForPath(pathname);
    if (route && isrRoutes[route.id]) {
      const revalidateSec = isrRoutes[route.id]?.revalidate;

      if (revalidateSec !== undefined && revalidateSec !== null) {
        const now = Date.now();
        const lastCheck = missingPathsCache.get(pathname);

        // If the path isn't in cache, or the revalidate time window has passed
        if (!lastCheck || now - lastCheck > revalidateSec * 1000) {

          // OOM Protection: If cache gets too big during a brute-force attack, flush it
          if (missingPathsCache.size >= MAX_MISSING_CACHE) {
            missingPathsCache.clear();
          }

          missingPathsCache.set(pathname, now);

          // Trigger SvelteKit generation in the background.
          // If the page actually exists now, it will be written to disk for the NEXT request.
          regenerateIsr(pathname);
        }
      }

      // ALWAYS return the static 404 file immediately for this request
      // This saves CPU and memory from rendering 404s dynamically.
      return get404Response();
    }

    // 4. Everything else: normal dynamic SSR
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

const shutdown = () => {
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;
}

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

const cpusRaw = env('CPUS', undefined);
const cpusFromEnv = cpusRaw === undefined ? undefined : Number(cpusRaw);
const CPUS =
  cpusFromEnv && cpusFromEnv > 0
    ? Math.floor(cpusFromEnv)
    : (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ||
      osCpus().length ||
      1;

const BUN_BINARY = env('BUN_BINARY', undefined) || process.execPath || 'bun';

const APP_ENTRY = join(import.meta.dir, 'app.js');

console.log(\`[\${ADAPTER_NAME}] supervisor (pid \${process.pid}) starting \${CPUS} worker(s) via \${BUN_BINARY}\`);

let shuttingDown = false;
const workers = new Array(CPUS);

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
    console.warn(
      \`[\${ADAPTER_NAME}] worker \${i} (pid \${proc.pid}) exited with code \${code}, respawning\`,
    );
    spawnWorker(i);
  });

  return proc;
}

for (let i = 0; i < CPUS; i++) {
  spawnWorker(i);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(\`[\${ADAPTER_NAME}] supervisor received \${signal}, stopping \${CPUS} worker(s)\`);
  for (const w of workers) {
    if (w) w.kill(signal);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  for (const w of workers) {
    if (w) w.kill();
  }
});
`;
}
