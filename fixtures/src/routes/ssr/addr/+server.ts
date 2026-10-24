import type { Config } from "../../../../../src";
import type { RequestHandler } from "./$types";

export const prerender = false;
export const config: Config = { ssrCache: 30 };

export const GET: RequestHandler = ({ getClientAddress }) =>
	Response.json({ ip: getClientAddress(), renderedAt: performance.now() });
