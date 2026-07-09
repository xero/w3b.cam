// Dev mode: build the site with in-browser editing hooks, serve it, and expose
// mutation endpoints that emulate the blacklist / reorder / tag workflows, plus a
// traffic-cam remove, against the LOCAL camhunting.sqlite (never the GitHub Actions
// db-store). Right-clicking a card or screenshot in the browser drives those
// endpoints (see src/dev-client/).
//
// Mutations write straight to the DB; we deliberately do NOT rebuild per click. A
// full bake re-extracts thousands of screenshots from a ~441MB DB (tens of seconds).
// The client does optimistic DOM updates instead; run `bun run bake` to regenerate
// the static site once you're done. Local-only; this never runs in CI.
//
// Usage:  bun dev   (or `bun run dev`; override the port with PORT=3000 bun dev)

import { isIP } from "node:net";
import { OUT_DIR } from "./config.ts";
import { addFeatured, addTag, blacklist, closeDb, distinctTags, entityTags, isFeatured, openDb, removeFeatured, removeTag, setPreferred } from "./db.ts";
import { ingestMjpegOne, ingestShodanText, ingestYoutubeOne } from "./ingest.ts";
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

	// ── GET /__dev/entity-tags?kind=&ref= → string[] (one entity's current tags) ────
	if (req.method === "GET" && path === "/__dev/entity-tags") {
		const q = new URL(req.url).searchParams;
		const kind = q.get("kind");
		const ref = q.get("ref");
		if (kind !== "cam" && kind !== "stream" && kind !== "traffic") return json({ error: "invalid kind" }, 400);
		if (!ref) return json({ error: "invalid ref" }, 400);
		return json(entityTags(db, kind, ref));
	}

	// ── GET /__dev/featured?kind=&ref= → { featured } (labels the toggle menu item) ─
	// cam|stream ONLY: traffic has no featured pins (the homepage slices newest traffic
	// directly, see build.ts), so a traffic ref can never be featured.
	if (req.method === "GET" && path === "/__dev/featured") {
		const q = new URL(req.url).searchParams;
		const kind = q.get("kind");
		const ref = q.get("ref");
		if (kind !== "cam" && kind !== "stream") return json({ error: "invalid kind" }, 400);
		if (!ref) return json({ error: "invalid ref" }, 400);
		return json({ featured: isFeatured(db, kind, ref) });
	}

	// ── POST /__dev/feature {kind, ref, on} → set homepage-feature membership ───────
	if (req.method === "POST" && path === "/__dev/feature") {
		const { kind, ref, on } = await readBody(req);
		if (kind !== "cam" && kind !== "stream") return json({ error: "invalid kind" }, 400);
		if (typeof ref !== "string" || ref.trim() === "") return json({ error: "invalid ref" }, 400);
		if (typeof on !== "boolean") return json({ error: "invalid on" }, 400);
		if (on) addFeatured(db, kind, ref);
		else removeFeatured(db, kind, ref);
		return json({ kind, ref, featured: on });
	}

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

	// ── POST /__dev/tag {kind, ref, tag}, unified tagging (INSERT OR IGNORE) ───────
	// `kind` picks the source; `ref` is that source's key (ip_str / video_id / id).
	// Only cams get the isIP shape-check; stream/traffic refs are opaque strings.
	if (req.method === "POST" && path === "/__dev/tag") {
		const { kind, ref, tag } = await readBody(req);
		if (kind !== "cam" && kind !== "stream" && kind !== "traffic") return json({ error: "invalid kind" }, 400);
		if (typeof ref !== "string" || ref.trim() === "") return json({ error: "invalid ref" }, 400);
		if (kind === "cam" && isIP(ref) === 0) return json({ error: "invalid ip" }, 400);
		if (typeof tag !== "string" || tag.trim() === "") return json({ error: "invalid tag" }, 400);
		const added = addTag(db, kind, ref, tag);
		return json({ kind, ref, tag: tag.trim().toLowerCase(), added });
	}

	// ── POST /__dev/untag {kind, ref, tag}, remove one tag (inverse of /tag) ───────
	if (req.method === "POST" && path === "/__dev/untag") {
		const { kind, ref, tag } = await readBody(req);
		if (kind !== "cam" && kind !== "stream" && kind !== "traffic") return json({ error: "invalid kind" }, 400);
		if (typeof ref !== "string" || ref.trim() === "") return json({ error: "invalid ref" }, 400);
		if (typeof tag !== "string" || tag.trim() === "") return json({ error: "invalid tag" }, 400);
		const removed = removeTag(db, kind, ref, tag);
		return json({ kind, ref, tag: tag.trim().toLowerCase(), removed });
	}

	// ── POST /__dev/remove {kind, ref}, delete a traffic cam and its tags ──────────
	// Traffic cams (Osiris, mjpeg camhunt, ...) have no re-scrape blacklist, so this is
	// a plain delete; a removed cam returns if you re-ingest its source list.
	if (req.method === "POST" && path === "/__dev/remove") {
		const { kind, ref } = await readBody(req);
		if (kind !== "traffic") return json({ error: "invalid kind" }, 400);
		if (typeof ref !== "string" || ref.trim() === "") return json({ error: "invalid ref" }, 400);
		const { changes } = db.query("DELETE FROM traffic WHERE id = ?").run(ref);
		db.query("DELETE FROM tags WHERE kind = 'traffic' AND ref = ?").run(ref);
		return changes ? json({ kind, ref, deleted: changes }) : json({ error: "id not stored" }, 404);
	}

	// ── POST /__dev/import {type, ...fields}, add one record from the browser ──────
	// Dispatches on `type` to the SAME ingest core (src/ingest.ts) the CLI runs. Every
	// failure (bad JSON, no vendor rule, network error) is caught and returned as
	// 400 {error} so the client toasts it and the long-lived server stays up. Shodan
	// needs no key; YouTube reads YOUTUBE_API_KEY off the env (NOT mustEnv, which would
	// exit the process) and 400s if it is unset.
	if (req.method === "POST" && path === "/__dev/import") {
		const body = await readBody(req);
		const type = body.type;
		const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
		try {
			if (type === "shodan") {
				if (!str(body.json)) return json({ error: "paste some Shodan JSON" }, 400);
				return json({ type, ...ingestShodanText(db, body.json as string) });
			}
			if (type === "youtube") {
				if (!str(body.url)) return json({ error: "url required" }, 400);
				const key = process.env.YOUTUBE_API_KEY?.trim();
				if (!key) return json({ error: "YOUTUBE_API_KEY not set (export it and restart bun dev)" }, 400);
				return json({ type, ...(await ingestYoutubeOne(db, { url: str(body.url), label: str(body.label) }, key)) });
			}
			if (type === "mjpeg") {
				if (!str(body.url)) return json({ error: "url required" }, 400);
				return json({ type, ...(await ingestMjpegOne(db, { url: str(body.url), label: str(body.label) })) });
			}
			return json({ error: "invalid import type" }, 400);
		} catch (err) {
			return json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
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
		`Right-click a card or screenshot to blacklist / reorder / tag / remove. Run \`bun run bake\` to regenerate the static site.`,
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
