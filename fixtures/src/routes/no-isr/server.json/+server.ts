import { json } from "@sveltejs/kit";
import { getTodos } from "#lib/server/db.ts";

export const prerender = true;

export const GET = async () => {
	const todos = getTodos();

	return json({
		todos,
	});
};
