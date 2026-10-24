import type { Config } from "../../../../../src";
import type { RequestHandler } from "./$types";

export const prerender = false;
export const config: Config = { ssrCache: { ttl: 30, ignoreCookies: ["_ga"] } };

// Sets a cookie on every render: must never be shared between visitors.
export const GET: RequestHandler = ({ cookies, url }) => {
	if (url.searchParams.has("set")) cookies.set("seen", "1", { path: "/" });
	return Response.json({ renderedAt: performance.now() });
};
