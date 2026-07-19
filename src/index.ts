import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

			// 5. Copy manifest to dest
			if (!existsSync(join(dest, "server"))) {
				mkdirSync(join(dest, "server"), { recursive: true });
			}
			cpSync(join(tmp, "manifest.js"), join(dest, "server", "manifest.js"));

			// Copy server index if it exists
			const serverIndex = join(tmp, "index.js");
			if (existsSync(serverIndex)) {
				cpSync(serverIndex, join(dest, "server", "index.js"));
			}

			// Copy all server chunks
			const serverChunksDir = join(tmp, "chunks");
			if (existsSync(serverChunksDir)) {
				const destChunksDir = join(dest, "server", "chunks");
				mkdirSync(destChunksDir, { recursive: true });
				const chunks = require("node:fs").readdirSync(serverChunksDir);
				for (const chunk of chunks) {
					cpSync(join(serverChunksDir, chunk), join(destChunksDir, chunk));
				}
			}

			// Copy server entries
			const serverEntriesDir = join(tmp, "entries");
			if (existsSync(serverEntriesDir)) {
				copyDirRecursive(serverEntriesDir, join(dest, "server", "entries"));
			}

			// Copy server nodes
			const serverNodesDir = join(tmp, "nodes");
			if (existsSync(serverNodesDir)) {
				copyDirRecursive(serverNodesDir, join(dest, "server", "nodes"));
			}

			// Copy server env.js
			const envFile = join(tmp, "env.js");
			if (existsSync(envFile)) {
				cpSync(envFile, join(dest, "server", "env.js"));
			}

			// Copy server internal.js
			const internalFile = join(tmp, "internal.js");
			if (existsSync(internalFile)) {
				cpSync(internalFile, join(dest, "server", "internal.js"));
			}

			// Copy server remote-entry.js
			const remoteEntry = join(tmp, "remote-entry.js");
			if (existsSync(remoteEntry)) {
				cpSync(remoteEntry, join(dest, "server", "remote-entry.js"));
			}

			// Copy server .vite manifest
			const viteManifest = join(tmp, ".vite");
			if (existsSync(viteManifest)) {
				copyDirRecursive(viteManifest, join(dest, "server", ".vite"));
			}

			// 6. Write the Bun server entry point with ISR caching
			const serverCode = generateServerCode(port);
			writeFileSync(join(dest, "index.js"), serverCode);

			builder.log.minor(`Adapter output written to ${dest}`);
		},

		supports: {
			read: () => true,
		},
	};
}

function copyDirRecursive(src: string, dest: string) {
	mkdirSync(dest, { recursive: true });
	const entries = require("node:fs").readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else {
			cpSync(srcPath, destPath);
		}
	}
}

function generateServerCode(port: number): string {
	return `
import { Server } from './server/index.js';
import { manifest, prerendered, base } from './server/manifest.js';
import { existsSync } from 'node:fs';
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

async function getRevalidateForPath(pathname) {
  const routes = manifest._?.routes || [];
  for (const route of routes) {
    if (route.pattern && route.pattern.test(pathname)) {
      const page = route.page;
      if (page) {
        for (const leafIdx of page.layouts || []) {
          try {
            const mod = await manifest._.nodes[leafIdx]();
            if (mod && mod.config && typeof mod.config.revalidate === 'number') {
              return mod.config.revalidate;
            }
          } catch {}
        }
        if (typeof page.leaf === 'number') {
          try {
            const mod = await manifest._.nodes[page.leaf]();
            if (mod && mod.config && typeof mod.config.revalidate === 'number') {
              return mod.config.revalidate;
            }
          } catch {}
        }
      }
      return null;
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

function serveStatic(pathname) {
  const filePath = join(ASSET_DIR, pathname);
  if (existsSync(filePath)) {
    const file = Bun.file(filePath);
    const headers = {};
    if (pathname.includes('/immutable/')) {
      headers['cache-control'] = 'public,max-age=31536000,immutable';
    }
    return new Response(file, { headers });
  }
  return null;
}

function servePrerendered(pathname) {
  const tryPaths = [
    join(PRERENDERED_DIR, pathname),
    join(PRERENDERED_DIR, pathname + '.html'),
    join(PRERENDERED_DIR, pathname, 'index.html'),
  ];
  for (const tryPath of tryPaths) {
    if (existsSync(tryPath)) {
      return new Response(Bun.file(tryPath), {
        headers: { 'Content-Type': 'text/html' },
      });
    }
  }
  return null;
}

const bunServer = Bun.serve({
  port: ${port},
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // Serve static client assets
    if (pathname.startsWith(base)) {
      const staticResponse = serveStatic(pathname);
      if (staticResponse) return staticResponse;
    }

    // Serve prerendered pages
    if (prerendered.has(pathname)) {
      const prerenderedResponse = servePrerendered(pathname);
      if (prerenderedResponse) return prerenderedResponse;
    }

    // Try ISR cache
    const cached = getCached(pathname);
    if (cached) {
      return new Response(cached, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    // Forward to SvelteKit
    const response = await server.respond(request, {
      platform: { server: bunServer, request },
    });

    // Cache 200 responses with revalidate config
    if (response.status === 200) {
      const revalidate = await getRevalidateForPath(pathname);
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
