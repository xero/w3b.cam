// Dev mode: build the site with in-browser editing hooks, serve it, and expose
// mutation endpoints that emulate the blacklist / reorder / tag workflows against
// the LOCAL camhunting.sqlite (never the GitHub Actions db-store). Right-clicking a
// card or screenshot in the browser drives those endpoints (see src/dev-client/).
//
// Mutations write straight to the DB; we deliberately do NOT rebuild per click. A
// full bake re-extracts thousands of screenshots from a ~441MB DB (tens of seconds).
// The client does optimistic DOM updates instead; run `bun run bake` to regenerate
// the static site once you're done. Local-only; this never runs in CI.
//
// Usage:  bun dev   (or `bun run dev`; override the port with PORT=3000 bun dev)

import { isIP } from "node:net";
import { OUT_DIR } from "./config.ts";
import { addIpTag, blacklist, closeDb, distinctTags, openDb, setPreferred } from "./db.ts";
import { build } from "./build.ts";
import { serveStatic } from "./serve.ts";

/** Dev-client assets, served from source so they never get copied into out/. */
const DEV_CLIENT = `${import.meta.dir}/dev-client`;
const port = Number(process.env.PORT ?? 1337);

// 1. Bake the dev-flavored site into out/ (data-* hooks + /__dev/* asset refs).
await build({ dev: true });

// 2. One long-lived handle for the server's lifetime. bun:sqlite calls are
//    synchronous and Bun is single-threaded, so mutation endpoints can't race each
//    other; the build() handle above is already closed before this opens.
const db = openDb();

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

/** Parse a JSON request body into a plain object, tolerating malformed input. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
	try {
		const b: unknown = await req.json();
		return b !== null && typeof b === "object" ? (b as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

async function handleDev(req: Request, path: string): Promise<Response> {
	// ── Dev-client assets (served from src/, never from out/) ──────────────────────
	if (req.method === "GET" && path === "/__dev/dev.js") return new Response(Bun.file(`${DEV_CLIENT}/dev.js`));
	if (req.method === "GET" && path === "/__dev/dev.css") return new Response(Bun.file(`${DEV_CLIENT}/dev.css`));

	// ── GET /__dev/tags → string[] (tag autocomplete) ──────────────────────────────
	if (req.method === "GET" && path === "/__dev/tags") return json(distinctTags(db));

	// ── POST /__dev/blacklist {ip}, emulates blacklist.ts for an IP ───────────────
	if (req.method === "POST" && path === "/__dev/blacklist") {
		const { ip } = await readBody(req);
		if (typeof ip !== "string" || isIP(ip) === 0) return json({ error: "invalid ip" }, 400);
		const { changes } = db.query("DELETE FROM webcams WHERE ip_str = ?").run(ip);
		const added = blacklist(db, ip);
		return json({ ip, deleted: changes, blacklisted: added });
	}

	// ── POST /__dev/reorder {ip, port}, emulates reorder.ts (setPreferred) ────────
	if (req.method === "POST" && path === "/__dev/reorder") {
		const { ip, port: rawPort } = await readBody(req);
		const p = Number(rawPort);
		if (typeof ip !== "string" || isIP(ip) === 0) return json({ error: "invalid ip" }, 400);
		if (!Number.isInteger(p) || p < 0) return json({ error: "invalid port" }, 400);
		return setPreferred(db, ip, p)
			? json({ ip, port: p, preferred: true })
			: json({ error: "ip:port not stored" }, 404);
	}

	// ── POST /__dev/tag {ip, tag}, the new tagging workflow (INSERT OR IGNORE) ─────
	if (req.method === "POST" && path === "/__dev/tag") {
		const { ip, tag } = await readBody(req);
		if (typeof ip !== "string" || isIP(ip) === 0) return json({ error: "invalid ip" }, 400);
		if (typeof tag !== "string" || tag.trim() === "") return json({ error: "invalid tag" }, 400);
		const added = addIpTag(db, ip, tag);
		return json({ ip, tag: tag.trim().toLowerCase(), added });
	}

	return json({ error: "not found" }, 404);
}

const server = Bun.serve({
	port,
	async fetch(req): Promise<Response> {
		const path = decodeURIComponent(new URL(req.url).pathname);
		return path.startsWith("/__dev/") ? handleDev(req, path) : serveStatic(req);
	},
});

console.log(
	`Dev server on http://localhost:${server.port}, serving ${OUT_DIR}/. Mutations write to the local camhunting.sqlite.\n` +
		`Right-click a card or screenshot to blacklist / reorder / tag. Run \`bun run bake\` to regenerate the static site.`,
);

// 3. Open the browser (macOS). Fire-and-forget; ignore if `open` is unavailable.
try {
	Bun.spawn(["open", `http://localhost:${server.port}`]);
} catch {}

// 4. Clean shutdown: checkpoint + close the WAL so -wal/-shm don't linger (closeDb).
process.on("SIGINT", () => {
	closeDb(db);
	server.stop();
	process.exit(0);
});
