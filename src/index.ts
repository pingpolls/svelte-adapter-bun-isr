import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, Builder } from "@sveltejs/kit";

interface AdapterOptions {
	out?: string;
	port?: number;
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
			writeFileSync(
				join(tmp, "manifest.js"),
				[
					`export const manifest = ${builder.generateManifest({ relativePath: "./" })};`,
					`export const prerendered = new Set(${prerenderedPaths});`,
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`,
				].join("\n\n"),
			);

			// 5. Copy server artifacts to dest
			const serverDest = join(dest, "server");
			mkdirSync(serverDest, { recursive: true });

			cpSync(join(tmp, "manifest.js"), join(serverDest, "manifest.js"));

			// Copy server index if it exists
			const serverIndex = join(tmp, "index.js");
			if (existsSync(serverIndex)) {
				cpSync(serverIndex, join(serverDest, "index.js"));
			}

			// Copy server chunks
			const serverChunksDir = join(tmp, "chunks");
			if (existsSync(serverChunksDir)) {
				const destChunksDir = join(serverDest, "chunks");
				mkdirSync(destChunksDir, { recursive: true });
				const chunks = await readdir(serverChunksDir);
				for (const chunk of chunks) {
					cpSync(join(serverChunksDir, chunk), join(destChunksDir, chunk));
				}
			}

			// Copy server entries
			const serverEntriesDir = join(tmp, "entries");
			if (existsSync(serverEntriesDir)) {
				await copyDirAsync(serverEntriesDir, join(serverDest, "entries"));
			}

			// Copy server nodes
			const serverNodesDir = join(tmp, "nodes");
			if (existsSync(serverNodesDir)) {
				await copyDirAsync(serverNodesDir, join(serverDest, "nodes"));
			}

			// Copy single-file server artifacts
			const singleFiles = ["env.js", "internal.js", "remote-entry.js"];
			for (const name of singleFiles) {
				const src = join(tmp, name);
				if (existsSync(src)) {
					cpSync(src, join(serverDest, name));
				}
			}

			// Copy .vite manifest if present
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
import { manifest, prerendered, base } from './server/manifest.js';
import { Glob } from 'bun';
import { join } from 'node:path';

const ADAPTER_NAME = 'svelte-adapter-bun-isr';
const ISR_CACHE = new Map();
const ASSET_DIR = join(import.meta.dir, 'client', base);
const PRERENDERED_DIR = join(import.meta.dir, 'prerendered');

const server = new Server(manifest);

await server.init({
  env: Bun.env,
  read: (file) => Bun.file(join(ASSET_DIR, file)).stream(),
});

// Pre-compute: build a Set of all client asset paths for O(1) lookups
// instead of calling existsSync on every request
const clientAssets = new Set();
const assetGlob = new Glob('**/*');
for await (const entry of assetGlob.scan({ cwd: ASSET_DIR, onlyFiles: true, absolute: false })) {
  clientAssets.add('/' + base + '/' + entry);
}

// Pre-compute: build a Map of regex -> revalidate duration from manifest routes
// This eliminates per-request route pattern matching and dynamic imports
const revalidateMap = new Map();
const routes = manifest._?.routes || [];
for (const route of routes) {
  if (!route.pattern) continue;
  const page = route.page;
  if (!page) continue;

  let revalidate = null;

  // Check layouts first
  for (const leafIdx of page.layouts || []) {
    try {
      const mod = await manifest._.nodes[leafIdx]();
      if (mod?.config && typeof mod.config.revalidate === 'number') {
        revalidate = mod.config.revalidate;
        break;
      }
    } catch {}
  }

  // Check leaf if no layout had revalidate
  if (revalidate === null && typeof page.leaf === 'number') {
    try {
      const mod = await manifest._.nodes[page.leaf]();
      if (mod?.config && typeof mod.config.revalidate === 'number') {
        revalidate = mod.config.revalidate;
      }
    } catch {}
  }

  if (revalidate !== null) {
    revalidateMap.set(route.pattern, revalidate);
  }
}

function getRevalidateForPath(pathname) {
  for (const [pattern, revalidate] of revalidateMap) {
    if (pattern.test(pathname)) {
      return revalidate;
    }
  }
  return null;
}

function getCached(pathname) {
  const entry = ISR_CACHE.get(pathname);
  if (!entry) return null;
  const age = (Date.now() - entry.timestamp) / 1000;
  if (age < entry.revalidate) return entry.html;
  ISR_CACHE.delete(pathname);
  return null;
}

function setCache(pathname, html, revalidate) {
  ISR_CACHE.set(pathname, { html, timestamp: Date.now(), revalidate });
}

// Pre-compute: build a Map of prerendered page -> pre-opened BunFile
// for zero-allocation, zero-syscall serving
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

const bunServer = Bun.serve({
  port: ${port},
  idleTimeout: 0,
  reusePort: true,
  development: false,

  async fetch(request) {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // 1. Serve static client assets (O(1) Set lookup)
    if (clientAssets.has(pathname)) {
      const filePath = join(ASSET_DIR, pathname.slice(base.length + 1) || pathname);
      const file = Bun.file(filePath);
      const headers = {};
      if (pathname.includes('/immutable/')) {
        headers['cache-control'] = 'public,max-age=31536000,immutable';
      }
      return new Response(file, { headers });
    }

    // 2. Serve prerendered pages (O(1) Map lookup, pre-opened BunFile)
    const prerenderedFile = prerenderedFiles.get(pathname);
    if (prerenderedFile) {
      return new Response(prerenderedFile, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 3. Try ISR cache (O(1) Map lookup)
    const cached = getCached(pathname);
    if (cached) {
      return new Response(cached, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    // 4. Forward to SvelteKit
    const response = await server.respond(request, {
      platform: { server: bunServer, request },
    });

    // 5. Cache 200 responses with revalidate config (pre-computed map)
    if (response.status === 200) {
      const revalidate = getRevalidateForPath(pathname);
      if (revalidate && revalidate > 0) {
        const clone = response.clone();
        const html = await clone.text();
        setCache(pathname, html, revalidate);
      }
    }

    return response;
  },
});

console.log(\`\${ADAPTER_NAME} listening on http://localhost:\${bunServer.port}\`);
`;
}
