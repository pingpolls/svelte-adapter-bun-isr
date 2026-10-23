import { addTodo } from "#lib/server/db.ts";
import { regenerate } from "../../../../../src/index.ts";

export const POST = async ({ request }: { request: Request }) => {
	const { text } = await request.json();
	if (!text) {
		return new Response(JSON.stringify({ error: "Text is required" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}
	const slug = addTodo(text);
	// Only the ISR slug page is refreshed; /no-isr/[slug] is fully static and must not discover it.
	await regenerate([`/isr/${slug}`]);
	return new Response(JSON.stringify({ success: true }), {
		status: 201,
		headers: { "Content-Type": "application/json" },
	});
};
