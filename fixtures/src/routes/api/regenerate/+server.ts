import { json } from "@sveltejs/kit";

import { regenerate } from "../../../../../src/index.ts";

export const POST = async ({ request }: { request: Request }) => {
	const { id } = await request.json();

	regenerate([`/isr/todo/${id}`]);

	return json({
		message: `Path of /isr/todo/${id} regenerated!`,
	});
};
