// src/routes/ws/+server.ts
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ platform }) => {
	const upgraded = platform?.server?.upgrade(platform?.request);
	return upgraded
		? new Response(null, { status: 101 })
		: new Response("Upgrade failed", { status: 500 });
};
