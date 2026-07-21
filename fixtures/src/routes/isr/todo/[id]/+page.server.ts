import { error } from "@sveltejs/kit";
import { getTodo, getTodos } from "$lib/server/db";
import type { EntryGenerator, PageServerLoad } from "./$types";

export const prerender = "auto";

export const entries: EntryGenerator = () => {
	const todos = getTodos();
	return todos.map((item) => ({
		id: String(item.id),
	}));
};

export const load: PageServerLoad = async ({ params: { id } }) => {
	console.info("Rerunning slug load");

	const numberedId = Number(id);

	if (Number.isNaN(numberedId)) {
		error(404);
	}

	const todo = getTodo(numberedId);

	if (!todo) {
		error(404);
	}

	return { todo };
};
