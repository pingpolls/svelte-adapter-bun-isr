import { getTodos } from "$lib/server/db";
import type { Config } from "../../../../../src";
import type { PageServerLoad } from "./$types";

export const prerender = "auto";
export const config: Config = { revalidate: 5 };

export const load: PageServerLoad = async () => {
  console.info("Rerunning page load")

	const todos = getTodos();
	return { todos };
};
