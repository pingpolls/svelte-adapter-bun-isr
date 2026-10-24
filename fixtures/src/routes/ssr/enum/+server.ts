import type { Config } from "../../../../../src";
import type { RequestHandler } from "./$types";

export const prerender = false;
export const config: Config = { ssrCache: 30 };

export const GET: RequestHandler = ({ request }) =>
	Response.json({
		names: [...request.headers.keys()].length,
		renderedAt: performance.now(),
	});
