import type { PageServerLoad } from "./$types";

export const prerender = false;

// No DB, no logging: isolates SvelteKit + adapter overhead from the app's own work.
export const load: PageServerLoad = () => ({ renderedAt: Date.now() });
