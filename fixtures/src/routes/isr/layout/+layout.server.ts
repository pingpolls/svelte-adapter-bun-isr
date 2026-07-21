import { getTodos } from "$lib/server/db";
import type { Config } from "../../../../../src";
import type { LayoutServerLoad } from "./$types";

export const prerender = "auto";
export const config: Config = { revalidate: 6 };

export const load: LayoutServerLoad = async () => {
	console.info("Rerunning layout load");
	const todos = getTodos();
	return { layoutTodo: todos };
};
