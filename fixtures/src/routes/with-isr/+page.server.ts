import type { PageServerLoad } from './$types';
import { getTodos } from '$lib/server/db';

export const load: PageServerLoad = async () => {
	const todos = await getTodos();
	return { todos };
};

export const config = {
	revalidate: 5,
	prerender: false,
};
