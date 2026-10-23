import { error } from "@sveltejs/kit";
import { getTodoFromSlug, getTodos } from "#lib/server/db.ts";
import type { EntryGenerator, PageServerLoad } from "./$types";

export const prerender = true;

export const entries: EntryGenerator = () =>
	getTodos().map((item) => ({ slug: String(item.slug) }));

export const load: PageServerLoad = async ({ params: { slug } }) => {
	const todo = getTodoFromSlug(slug);

	if (!todo) {
		error(404);
	}

	return { todo };
};
