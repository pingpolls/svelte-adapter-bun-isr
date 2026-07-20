import { getTodos } from "$lib/server/db";
import type { PageServerLoad } from "../../no-isr/page/$types";

export const prerender = true;

export const load: PageServerLoad = async () => {
	const todos = getTodos();
	return { todos };
};
