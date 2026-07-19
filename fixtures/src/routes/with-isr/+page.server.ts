import { getTodos } from "$lib/server/db";
import type { PageServerLoad } from "./$types";

export const config = {
	revalidate: 5,
};

export const load: PageServerLoad = async () => {
	const todos = await getTodos();
	return { todos };
};
