import { readdir } from 'node:fs/promises';
import path from 'node:path';

export interface IsrRoute {
  routeId: string;              // e.g. /blog/[slug]
  revalidate: number;           // seconds
  hasEntries: boolean;          // whether entries() must be called to expand params
}

const PAGE_FILE_RE = /^\+page\.(server\.)?(js|ts)$/;

export async function buildIsrManifest(routesDir: string): Promise<IsrRoute[]> {
  const manifest: IsrRoute[] = [];

  async function walk(dir: string, routeId = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), `${routeId}/${entry.name}`);
        continue;
      }
      if (!PAGE_FILE_RE.test(entry.name)) continue;

      const filePath = path.join(dir, entry.name);
      const mod = await import(filePath);
      if (typeof mod.revalidate === 'number') {
        manifest.push({
          routeId,
          revalidate: mod.revalidate,
          hasEntries: typeof mod.entries === 'function',
        });
      }
    }
  }

  await walk(routesDir);
  return manifest;
}