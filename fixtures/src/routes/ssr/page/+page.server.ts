import { getTodos } from "#lib/server/db.ts";
import type { PageServerLoad } from "./$types";

export const prerender = false;

export const load: PageServerLoad = async () => {
	const todos = getTodos();
	return { todos, renderedAt: Date.now() };
};
