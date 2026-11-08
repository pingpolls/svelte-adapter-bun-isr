import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type PluginOption } from "vite";
import BunISRAdapter from "../src/index.ts";

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			adapter: BunISRAdapter({
				precompress: false,
				// Served on prerendered/ISR pages and the adapter's 404, which skip `handle`.
				prerenderedHeaders: { "X-Frame-Options": "DENY" },
			}),
			// /no-isr/[slug] has no entries on an empty DB; that is the point of the fixture.
			prerender: { handleUnseenRoutes: "ignore" },
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
			},
		}) as PluginOption,
	],
});
