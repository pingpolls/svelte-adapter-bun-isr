import { getTodos } from "#lib/server/db.ts";
import type { Config } from "../../../../../src";
import type { PageServerLoad } from "./$types";

export const prerender = false;
export const config: Config = { ssrCache: 2 };

export const load: PageServerLoad = async () => {
	const todos = getTodos();
	return { todos, renderedAt: Date.now() };
};
