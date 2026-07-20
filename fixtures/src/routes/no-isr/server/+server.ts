import { json } from "@sveltejs/kit";
import { getTodos } from "$src/lib/server/db";

export const prerender = true;

export const GET = async () => {
	const todos = getTodos();

	return json({
		todos,
	});
};
