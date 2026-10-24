import type { Config } from "../../../../../src";
import type { RequestHandler } from "./$types";

export const prerender = false;
export const config: Config = { ssrCache: 30 };

export const GET: RequestHandler = ({ request, setHeaders }) => {
	setHeaders({ vary: "X-Variant" });
	return Response.json({
		variant: request.headers.get("x-variant"),
		renderedAt: performance.now(),
	});
};
