import { getTodos } from "$lib/server/db";
import type { Config } from "../../../../src";
import type { PageServerLoad } from "./$types";

export const prerender = true;
export const config: Config = { revalidate: 5 * 1000 };

export const load: PageServerLoad = async () => {
	const todos = await getTodos();
	return { todos };
};
