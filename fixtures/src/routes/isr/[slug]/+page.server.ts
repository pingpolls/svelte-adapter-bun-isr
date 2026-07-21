import { error } from "@sveltejs/kit";
import { getTodoFromSlug, getTodos } from "$lib/server/db";
import type { EntryGenerator, PageServerLoad } from "./$types";

export const prerender = "auto";

export const entries: EntryGenerator = () => {
	const todos = getTodos();
	console.info("Entries re run");
	return todos.map((item) => ({
		slug: String(item.slug),
	}));
};

export const load: PageServerLoad = async ({ params: { slug } }) => {
	console.info("Rerunning slug load");

	const todo = getTodoFromSlug(slug);

	if (!todo) {
		error(404);
	}

	return { todo };
};
