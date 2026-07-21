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
	 * (HOST, PORT, SOCKET_PATH, IDLE_TIMEOUT). Default: ''
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
}

/**
 * Adapter-specific route config. Use it via SvelteKit's own `export const config` page option
 * in +page.server.ts / +page.ts (or the +layout equivalents to apply it to a whole subtree):
 *
 * ```ts
 * import type { Config } from '@pingpolls/svelte-adapter-bun-isr';
 *
 * export const prerender = 'auto'; // NOT `true` — see note below
 * export const config: Config = { revalidate: 5 }; // Sec
 * ```
 *
 * `revalidate` only has an effect on routes that are also prerendered. Use
 * `export const prerender = 'auto'`, not `true`: SvelteKit strips fully-prerendered
 * (`true`) routes from the SSR manifest entirely, so there'd be nothing left for the
 * adapter's stale-while-revalidate check to re-render at runtime. `'auto'` still produces
 * the static file at build time, but keeps the route reachable via `server.respond()` for
 * regeneration.
 */
export interface Config {
	revalidate?: number;
}

const ADAPTER_NAME = "@pingpolls/svelte-adapter-bun-isr";

export default function (options: AdapterOptions = {}): Adapter {
	const {
		out = "build",
		serveAssets = true,
		precompress = true,
		envPrefix = "",
		idleTimeout = 10,
		websockets = true,
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
			const prerenderedPaths = JSON.stringify(builder.prerendered.paths);

			// Resolve ISR `revalidate` per prerendered path at build time. `builder.routes`
			// already gives us `config` fully merged across the layout chain (same merge
			// SvelteKit uses internally for adapter.supports.read), so no need to walk
			// node modules ourselves at runtime — just match each concrete prerendered
			// path against its route pattern and pull `config.revalidate` off it.
			const isrRevalidate: Record<string, number> = {};
			for (const path of builder.prerendered.paths) {
				const route = builder.routes.find((r) => r.pattern.test(path));
				const revalidate = (route?.config as Config | undefined)?.revalidate;
				if (typeof revalidate !== "number" || revalidate <= 0) continue;

				// `prerender = true` strips the route from the SSR manifest entirely (SvelteKit
				// does this to shrink the server bundle), which means our runtime regenerate()
				// call — which goes through server.respond() — has nothing to match and always
				// 404s. `'auto'` keeps the static output *and* keeps the route in the manifest,
				// which is exactly what ISR needs.
				if (route?.prerender !== "auto") {
					builder.log.warn(
						`[${ADAPTER_NAME}] ${path} sets config.revalidate but "export const prerender" ` +
							`is not 'auto'. Routes with prerender = true are stripped from the SSR ` +
							`manifest, so the adapter can't re-render them at runtime — ISR will be a ` +
							`no-op here. Change to \`export const prerender = 'auto'\` to enable it.`,
					);
					continue;
				}

				isrRevalidate[path] = revalidate;
			}

			writeFileSync(
				join(tmp, "manifest.js"),
				[
					`export const manifest = ${builder.generateManifest({ relativePath: "./" })};`,
					`export const prerendered = new Set(${prerenderedPaths});`,
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`,
					`export const isrRevalidate = ${JSON.stringify(isrRevalidate)};`,
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

			// 5b. Bundle hooks.server's `websocket` export (if any) so the runtime
			// server can wire it into Bun.serve without us having to reach into
			// SvelteKit's internal server bundle, which doesn't expose it.
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
							// $env/* and $app/* are Vite-only virtual modules — no physical
							// file exists for Bun to resolve, so they stay external.
							// $lib/* is real project code (src/lib) resolved via
							// tsconfig.json "paths" — do NOT externalize it, or any
							// hooks.server.ts that imports from $lib (db clients,
							// session stores, etc.) will emit an unresolved import
							// and crash at runtime instead of build time.
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

			// 6. Write the Bun server entry point with ISR caching
			writeFileSync(
				join(dest, "index.js"),
				generateServerCode({
					serveAssets,
					envPrefix,
					idleTimeout,
					hasWebsocketExport,
				}),
			);

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

// Extensions that are already compressed / not worth (re)compressing.
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

			// zstd: only available on newer Bun builds. Best-effort.
			const zstdCompress = (
				Bun as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }
			).zstdCompressSync;
			if (typeof zstdCompress === "function") {
				try {
					const zst = zstdCompress(data);
					writeFileSync(`${fullPath}.zst`, zst);
				} catch {
					// ignore — zstd precompression is best-effort
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
import { manifest, prerendered, base, isrRevalidate } from './server/manifest.js';
${hasWebsocketExport ? "import { websocket } from './server/hooks.js';" : ""}
import { Glob } from 'bun';
import { join } from 'node:path';

const ADAPTER_NAME = 'svelte-adapter-bun-isr';
const ENV_PREFIX = ${JSON.stringify(envPrefix)};
const DEFAULT_IDLE_TIMEOUT = ${idleTimeout};
const SERVE_ASSETS = ${JSON.stringify(serveAssets)};
const ASSET_DIR = join(import.meta.dir, 'client', base);
const PRERENDERED_DIR = join(import.meta.dir, 'prerendered');

function env(name, fallback) {
  const value = Bun.env[ENV_PREFIX + name];
  return value === undefined ? fallback : value;
}

// --- Runtime binding config ---------------------------------------------
const HOST = env('HOST', '0.0.0.0');
const PORT = Number(env('PORT', 3000));
const SOCKET_PATH = env('SOCKET_PATH', undefined);

const idleTimeoutRaw = env('IDLE_TIMEOUT', undefined);
const IDLE_TIMEOUT =
  idleTimeoutRaw === undefined ? DEFAULT_IDLE_TIMEOUT : Number(idleTimeoutRaw);

const server = new Server(manifest);

await server.init({
  env: Bun.env,
  read: (file) => Bun.file(join(ASSET_DIR, file)).stream(),
});

// Pre-compute: O(1) lookup set for static client assets
const clientAssets = new Set();
if (SERVE_ASSETS) {
  const assetGlob = new Glob('**/*');
  for await (const entry of assetGlob.scan({ cwd: ASSET_DIR, onlyFiles: true, absolute: false })) {
    if (entry.endsWith('.gz') || entry.endsWith('.br') || entry.endsWith('.zst')) continue;
    clientAssets.add('/' + base + '/' + entry);
  }
}

// Pre-open BunFile handles for every prerendered path (zero-syscall serving)
const prerenderedFiles = new Map();
if (SERVE_ASSETS) {
  for (const p of prerendered) {
    const candidates = [
      join(PRERENDERED_DIR, p),
      join(PRERENDERED_DIR, p + '.html'),
      join(PRERENDERED_DIR, p, 'index.html'),
    ];
    for (const filePath of candidates) {
      const f = Bun.file(filePath);
      if (await f.exists()) {
        prerenderedFiles.set(p, f);
        break;
      }
    }
  }
}

// Negotiate best precompressed variant for a file path + Accept-Encoding header.
// Returns { file, encoding } or null if nothing precompressed is available/accepted.
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

// --- Stale-while-revalidate ISR -----------------------------------------
// No background interval workers. Freshness is only checked when a request
// actually hits an ISR-configured path:
//   - fresh  (age <= revalidate) -> serve cached HTML, do nothing else
//   - stale  (age >  revalidate) -> serve cached/build-time HTML immediately,
//                                    fire a background regeneration (unawaited)
//                                    so the NEXT request gets fresh content
// isrCache: pathname -> { html, timestamp } — populated lazily on first
// regeneration. Before that, the build-time prerendered file is served as
// the initial "stale" baseline. Resets on process restart (falls back to
// the build-time file again, which is still valid, just possibly stale).
const isrCache = new Map();
const isrInFlight = new Set(); // paths currently being regenerated, dedupes concurrent triggers
const serverStartedAt = Date.now();

async function regenerateIsr(path) {
  if (isrInFlight.has(path)) return;
  isrInFlight.add(path);
  try {
    const request = new Request('http://isr-worker' + path);
    const response = await server.respond(request, {
      getClientAddress: () => '127.0.0.1',
    });
    if (response.status === 200) {
      isrCache.set(path, { html: await response.text(), timestamp: Date.now() });
    } else {
      console.warn(\`[\${ADAPTER_NAME}] ISR regenerate \${path} -> \${response.status}, keeping stale content\`);
    }
  } catch (err) {
    console.error(\`[\${ADAPTER_NAME}] ISR regenerate failed for \${path}\`, err);
  } finally {
    isrInFlight.delete(path);
  }
}

const isrPathCount = Object.keys(isrRevalidate).length;
if (isrPathCount > 0) {
  console.log(\`[\${ADAPTER_NAME}] ISR (stale-while-revalidate) enabled for \${isrPathCount} route(s)\`);
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

    // 1. Static client assets
    if (SERVE_ASSETS && clientAssets.has(pathname)) {
      const filePath = join(ASSET_DIR, pathname.slice(base.length + 1) || pathname);
      const headers = {};
      if (pathname.includes('/immutable/')) {
        headers['cache-control'] = 'public,max-age=31536000,immutable';
      }
      headers['vary'] = 'Accept-Encoding';

      const compressed = await negotiateCompressed(filePath, acceptEncoding);
      if (compressed) {
        headers['content-encoding'] = compressed.encoding;
        return new Response(compressed.file, { headers });
      }
      return new Response(Bun.file(filePath), { headers });
    }

    // 2. Prerendered pages, with stale-while-revalidate for ISR-configured routes
    if (SERVE_ASSETS) {
      const revalidateSec = isrRevalidate[pathname];

      if (revalidateSec !== undefined) {
        const cached = isrCache.get(pathname);
        const age = Date.now() - (cached ? cached.timestamp : serverStartedAt);
        const isStale = age > revalidateSec * 1000;

        if (isStale) {
          // Fire-and-forget: don't block this response on regeneration.
          // Next request(s) after this one will pick up the fresh HTML.
          regenerateIsr(pathname);
        }

        if (cached) {
          return new Response(cached.html, { headers: { 'Content-Type': 'text/html' } });
        }
        // No regenerated version yet — fall through and serve the build-time
        // prerendered file below (still correct HTML, just possibly stale).
      }

      const prerenderedFile = prerenderedFiles.get(pathname);
      if (prerenderedFile) {
        const headers = { 'Content-Type': 'text/html', vary: 'Accept-Encoding' };
        const compressed = await negotiateCompressed(prerenderedFile.name, acceptEncoding);
        if (compressed) {
          headers['content-encoding'] = compressed.encoding;
          return new Response(compressed.file, { headers });
        }
        return new Response(prerenderedFile, { headers });
      }
    }

    // 3. Everything else: normal dynamic SSR, no caching
    return server.respond(request, {
      platform: { server: bunServer, request },
      getClientAddress: () => request.headers.get('x-forwarded-for') ?? '127.0.0.1',
    });
  },
});

console.log(
  SOCKET_PATH
    ? \`\${ADAPTER_NAME} listening on unix socket \${SOCKET_PATH}\`
    : \`\${ADAPTER_NAME} listening on http://\${HOST}:\${bunServer.port}\`
);

const shutdown = () => {
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;
}
