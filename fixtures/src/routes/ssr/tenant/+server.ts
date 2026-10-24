import type { Config } from "../../../../../src";
import type { RequestHandler } from "./$types";

export const prerender = false;
export const config: Config = { ssrCache: 30 };

// Personalises on a custom header and never sends Vary: the adapter must notice the read.
export const GET: RequestHandler = ({ request }) =>
	Response.json({
		tenant: request.headers.get("x-tenant"),
		renderedAt: performance.now(),
	});
