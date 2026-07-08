// Static file server for the generated site. htmx fetches page fragments over
// HTTP, so the site must be served (those requests do not work from file://).
// Serving at the domain root keeps the root-relative URLs the build emits valid.
//
// Usage:  bun run serve   (override the port with PORT=3000 bun run serve)

import { OUT_DIR } from "./config.ts";

/**
 * Serve one request out of out/: `..` traversal guard, `/` → index.html, 404 on a
 * miss. Exported so `bun dev` (src/dev.ts) can reuse the exact static logic and only
 * layer its /__dev/* API on top; the static behavior lives in one place.
 */
export async function serveStatic(req: Request): Promise<Response> {
	let path = decodeURIComponent(new URL(req.url).pathname);
	// Traversal guard: camhunting.sqlite sits at the repo root, above out/.
	if (path.includes("..")) return new Response("Forbidden", { status: 403 });
	if (path.endsWith("/")) path += "index.html";

	const file = Bun.file(OUT_DIR + path);
	return (await file.exists())
		? new Response(file) // Bun sets Content-Type from the extension
		: new Response("Not found", { status: 404 });
}

// Direct run (`bun run serve`) starts the static server; importing this module
// (from src/dev.ts) does not, so the dev server owns the single listener on 1337.
if (import.meta.main) {
	const port = Number(process.env.PORT ?? 1337);
	const server = Bun.serve({ port, fetch: serveStatic });
	console.log(`Serving ${OUT_DIR}/ at http://localhost:${server.port}`);
}
