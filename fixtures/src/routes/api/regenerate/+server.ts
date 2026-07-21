import { json } from "@sveltejs/kit";
import { regenerate } from "../../../../../src/index.ts";

export const POST = async ({ request }: { request: Request }) => {
	const { paths = [], removePaths = [] } = await request.json();
	const result = await regenerate(paths, removePaths);
	return json(result);
};
