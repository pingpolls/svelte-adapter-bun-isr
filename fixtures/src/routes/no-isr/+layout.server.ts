import { getTodos } from "$lib/server/db";
import type { LayoutServerLoad } from "../no-isr/$types";

export const prerender = true;

export const load: LayoutServerLoad = async () => {
	const todos = getTodos();
	return { layoutTodo: todos };
};
