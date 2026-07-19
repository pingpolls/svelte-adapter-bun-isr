import { addTodo } from '$lib/server/db';

export const POST = async ({ request }: { request: Request }) => {
	const { text } = await request.json();
	if (!text) {
		return new Response(JSON.stringify({ error: 'Text is required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	addTodo(text);
	return new Response(JSON.stringify({ success: true }), {
		status: 201,
		headers: { 'Content-Type': 'application/json' },
	});
};
