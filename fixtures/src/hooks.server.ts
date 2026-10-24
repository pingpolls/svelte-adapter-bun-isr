import type { Handle } from "@sveltejs/kit/hooks";
import { intercept, type SharedStore, sharedStore } from "../../src/index.ts";

// Bun-level gates exercised by `stress`: a honeypot, and a rate-limited
// path that costs one shared-store write per request (limit never trips).
let limits: SharedStore | undefined;
intercept((request, server) => {
	const { pathname } = new URL(request.url);
	if (pathname === "/wp-login.php") return new Response(null, { status: 451 });
	if (pathname === "/limited") {
		limits ??= sharedStore("limits");
		const ip = server.requestIP(request)?.address ?? "unknown";
		return limits.hit(ip, 60) > 1e12
			? new Response("Too Many Requests", { status: 429 })
			: new Response("ok");
	}
});

export const handle: Handle = async ({ event, resolve }) => {
	const { request } = event;
	const isUpgrade =
		request.headers.get("connection")?.toLowerCase().includes("upgrade") &&
		request.headers.get("upgrade")?.toLowerCase() === "websocket";

	if (isUpgrade && new URL(request.url).pathname === "/ws") {
		const upgraded = event.platform?.server?.upgrade(event.platform?.request);
		if (upgraded) return new Response(null, { status: 101 });
	}

	return resolve(event);
};

export const websocket: Bun.WebSocketHandler<undefined> = {
	open(ws) {
		ws.send("connection opened");
	},
	message(ws, message) {
		ws.send(message); // echo
	},
};
