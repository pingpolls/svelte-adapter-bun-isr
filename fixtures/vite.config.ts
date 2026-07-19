import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type PluginOption } from "vite";
import BunISRAdapter from "../src/index.ts";

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			adapter: BunISRAdapter({ port: 3000 }),
			alias: {
				$src: "./src",
			},
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
			},
		}) as PluginOption,
	],
});
