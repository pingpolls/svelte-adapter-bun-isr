import type { Handle } from "@sveltejs/kit";

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
