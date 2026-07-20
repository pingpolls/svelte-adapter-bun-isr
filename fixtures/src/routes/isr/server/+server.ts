import { json } from "@sveltejs/kit";
import { getTodos } from "$src/lib/server/db";
import type { Config } from "../../../../../src";

export const prerender = "auto";
export const config: Config = { revalidate: 10 };

export const GET = async () => {
	const todos = getTodos();

	return json({
		todos,
	});
};
