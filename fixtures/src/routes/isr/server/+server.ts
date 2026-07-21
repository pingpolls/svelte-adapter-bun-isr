import { json } from "@sveltejs/kit";
import { getTodos } from "$src/lib/server/db";
import type { Config } from "../../../../../src";

export const prerender = "auto";
export const config: Config = { revalidate: 6 };

export const GET = async () => {
	console.info("Rerunning server load");

	const todos = getTodos();

	return json({
		todos,
	});
};
