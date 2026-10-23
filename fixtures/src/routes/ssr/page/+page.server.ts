import { getTodos } from "#lib/server/db.ts";
import type { PageServerLoad } from "./$types";

export const prerender = false;

export const load: PageServerLoad = async () => {
	console.info("Running SSR page load");

	const todos = getTodos();
	return { todos, renderedAt: Date.now() };
};
