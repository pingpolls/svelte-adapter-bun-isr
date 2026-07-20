import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, Builder } from "@sveltejs/kit";

interface AdapterOptions {
	out?: string;
	port?: number;
}

/**
 * Adapter-specific route config. Use it via SvelteKit's own `export const config` page option
 * in +page.server.ts / +page.ts (or the +layout equivalents to apply it to a whole subtree):
 *
 * ```ts
 * import type { Config } from '@pingpolls/svelte-adapter-bun-isr';
 *
 * export const prerender = 'auto'; // NOT `true` — see note below
 * export const config: Config = { revalidate: 5000 }; // ms
 * ```
 *
 * `revalidate` only has an effect on routes that are also prerendered. Use
 * `export const prerender = 'auto'`, not `true`: SvelteKit strips fully-prerendered
 * (`true`) routes from the SSR manifest entirely, so there'd be nothing left for the
 * adapter's background worker to re-render at runtime. `'auto'` still produces the static
 * file at build time, but keeps the route reachable via `server.respond()` for regeneration.
 */
export interface Config {
	revalidate?: number;
}

const ADAPTER_NAME = "svelte-adapter-bun-isr";

export default function (options: AdapterOptions = {}): Adapter {
	const { out = "build", port = 3000 } = options;

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

			// 6. Write the Bun server entry point with ISR caching
			writeFileSync(join(dest, "index.js"), generateServerCode(port));

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

function generateServerCode(port: number): string {
	return `
import { Server } from './server/index.js';
import { manifest, prerendered, base, isrRevalidate } from './server/manifest.js';
import { Glob } from 'bun';
import { join } from 'node:path';

const ADAPTER_NAME = 'svelte-adapter-bun-isr';
const ASSET_DIR = join(import.meta.dir, 'client', base);
const PRERENDERED_DIR = join(import.meta.dir, 'prerendered');

const server = new Server(manifest);

await server.init({
  env: Bun.env,
  read: (file) => Bun.file(join(ASSET_DIR, file)).stream(),
});

// Pre-compute: O(1) lookup set for static client assets
const clientAssets = new Set();
const assetGlob = new Glob('**/*');
for await (const entry of assetGlob.scan({ cwd: ASSET_DIR, onlyFiles: true, absolute: false })) {
  clientAssets.add('/' + base + '/' + entry);
}

// Pre-open BunFile handles for every prerendered path (zero-syscall serving)
const prerenderedFiles = new Map();
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

// In-memory ISR cache: pathname -> latest regenerated HTML.
// Overrides the build-time static file once the first background regeneration completes.
// NOTE: resets on process restart (falls back to the build-time file, which is still valid
// HTML, just up to \`revalidate\` ms stale). Persist to disk here if you need cross-restart freshness.
const isrCache = new Map();
const timers = [];

// isrRevalidate is a plain { [path]: revalidateMs } map, fully resolved at build time from
// each route's \`export const config: Config = { revalidate }\` (merged across the layout
// chain by SvelteKit itself, see adapter's adapt()). No manifest/node introspection needed here.
for (const [path, revalidate] of Object.entries(isrRevalidate)) {
  const regenerate = async () => {
    try {
      const request = new Request('http://isr-worker' + path);
      const response = await server.respond(request, {
        getClientAddress: () => '127.0.0.1',
      });
      if (response.status === 200) {
        isrCache.set(path, await response.text());
      } else {
        console.warn(\`[\${ADAPTER_NAME}] ISR regenerate \${path} -> \${response.status}, keeping stale content\`);
      }
    } catch (err) {
      console.error(\`[\${ADAPTER_NAME}] ISR regenerate failed for \${path}\`, err);
    }
  };

  console.log(\`[\${ADAPTER_NAME}] ISR enabled: \${path} (every \${revalidate}ms)\`);
  timers.push(setInterval(regenerate, revalidate));
}

const bunServer = Bun.serve({
  port: ${port},
  idleTimeout: 0,
  reusePort: true,
  development: false,

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Static client assets
    if (clientAssets.has(pathname)) {
      const filePath = join(ASSET_DIR, pathname.slice(base.length + 1) || pathname);
      const file = Bun.file(filePath);
      const headers = {};
      if (pathname.includes('/immutable/')) {
        headers['cache-control'] = 'public,max-age=31536000,immutable';
      }
      return new Response(file, { headers });
    }

    // 2. ISR-regenerated HTML takes priority over the original build-time file
    const isrHtml = isrCache.get(pathname);
    if (isrHtml !== undefined) {
      return new Response(isrHtml, { headers: { 'Content-Type': 'text/html' } });
    }

    // 3. Prerendered pages (pre-opened BunFile, zero extra syscalls)
    const prerenderedFile = prerenderedFiles.get(pathname);
    if (prerenderedFile) {
      return new Response(prerenderedFile, { headers: { 'Content-Type': 'text/html' } });
    }

    // 4. Everything else: normal dynamic SSR, no caching
    return server.respond(request, {
      platform: { server: bunServer, request },
      getClientAddress: () => request.headers.get('x-forwarded-for') ?? '127.0.0.1',
    });
  },
});

console.log(\`\${ADAPTER_NAME} listening on http://localhost:\${bunServer.port}\`);

const shutdown = () => {
  for (const t of timers) clearInterval(t);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;
}
