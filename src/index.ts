import { writeFileSync, mkdirSync, cpSync } from 'node:fs';
import path from 'node:path';
import type { Adapter } from '@sveltejs/kit';
import { buildIsrManifest, IsrRoute } from './manifest.js';

export interface AdapterOptions {
  out?: string;
  revalidateToken?: string;
  precompress?: boolean;
}

function sanitizeRouteId(routeId: string): string {
  return routeId.replace(/[\/\\[\\]]/g, '_');
}

export default function adapter(options: AdapterOptions = {}): Adapter {
  const { out = 'build' } = options;

  return {
    name: '@pingpolls/svelte-adapter-bun-isr',

    async adapt(builder) {
      builder.rimraf(out);
      builder.mkdirp(out);

      builder.log.minor('Writing server bundle...');
      builder.writeServer(`${out}/server`);
      builder.writeClient(`${out}/client`);
      builder.writePrerendered(`${out}/prerendered`);

      const manifestFile = `${out}/server/manifest.js`;
      writeFileSync(
        manifestFile,
        `export const manifest = ${builder.generateManifest({ relativePath: './server' })};\n`
      );

      builder.log.minor('Scanning routes for ISR revalidate exports...');
      const routesDir = path.join(process.cwd(), 'src', 'routes');
      const isrManifest = await buildIsrManifest(routesDir);
      writeFileSync(`${out}/isr-manifest.json`, JSON.stringify(isrManifest, null, 2));

      builder.log.minor('Emitting entries() wrapper modules for dynamic ISR routes...');
      const entriesDir = path.join(out, 'server', 'entries');
      mkdirSync(entriesDir, { recursive: true });

      for (const route of isrManifest) {
        if (route.hasEntries) {
          // Determine the source file path for entries(). Assumes src/routes/[routeId]/entries.ts/js
          // Since manifest.ts uses imports, we assume the entry point is adjacent or under the route directory.
          // We will assume a file named 'entries.js' or 'entries.ts' exists within the route directory structure.
          const routePath = path.join('src', 'routes', route.routeId.replace(/[\/\\[]/g, '_'));
          const entriesSource = path.join(routePath, 'entries.js'); // Simplified assumption, relying on Bun's dynamic import handling later
          
          // For the wrapper, we need a function that exports the result of import(source).entries()
          const safeId = sanitizeRouteId(route.routeId);
          const entryWrapperPath = path.join(entriesDir, `${safeId}.js`);
          
          // Create a wrapper that dynamically imports the actual entries function
          const wrapperContent = `export default async function entries() {
    try {
      const mod = await import(path.resolve('./src/routes/${route.routeId}/entries.js'));
      return mod.entries ? mod.entries() : [];
    } catch (error) {
      console.error(\`Failed to load entries for route \${route.routeId}\`: \${error.message}\`);
      return [];
    }
  }`;
          writeFileSync(entryWrapperPath, wrapperContent);
        }
      }

      builder.log.minor('Writing Bun entrypoint...');
      const templatePath = new URL('../templates/entrypoint.js', import.meta.url);
      cpSync(templatePath, `${out}/index.js`);

      builder.log.success(
        `Built. Run with: REVALIDATE_TOKEN=xxx bun run ${out}/index.js`
      );
    },
  };
}