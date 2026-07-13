// Dev mode: build the site with in-browser editing hooks, serve it, and expose
// mutation endpoints that emulate the blacklist / remove / reorder / tag workflows,
// against the LOCAL camhunting.sqlite (never the GitHub Actions db-store). Right-clicking
// a card or screenshot in the browser drives those endpoints (see src/dev-client/).
//
// Mutations write straight to the DB; we deliberately do NOT rebuild per click. A
// full bake re-extracts thousands of screenshots from a ~441MB DB (tens of seconds).
// The client does optimistic DOM updates instead; run `bun run bake` to regenerate
// the static site once you're done. Local-only; this never runs in CI.
//
// Usage:  bun dev   (or `bun run dev`; override the port with PORT=3000 bun dev)
//   bun dev --index-only   rebuild only index.html and reuse the rest of out/ from the
//                          last full bake, for a much faster start. Other pages and the
//                          homepage's newest cards reflect that last bake, not any DB
//                          changes since; run a plain `bun dev` when you need them fresh.

import { parseArgs } from "node:util";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { OUT_DIR } from "./config.ts";
import { addFeatured, addTag, blacklist, closeDb, deleteWebcamsByIp, distinctTags, entityTags, isFeatured, openDb, removeEntity, removeFeatured, removeTag, setPreferred, setThumbnail } from "./db.ts";
import { ingestMjpegOne, ingestShodanText, ingestYoutubeOne } from "./ingest.ts";
import { build } from "./build.ts";
import { isSafeImageMime } from "./render.ts";
import { serveStatic } from "./serve.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { "index-only": { type: "boolean" } }, allowPositionals: true });

/** Dev-client assets, served from source so they never get copied into out/. */
const DEV_CLIENT = `${import.meta.dir}/dev-client`;
const port = Number(process.env.PORT ?? 1337);

// 1. Bake the dev-flavored site into out/ (data-* hooks + /__dev/* asset refs).
await build({ dev: true, indexOnly: values["index-only"] });

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
		if (kind !== "cam" && kind !== "stream" && kind !== "feed") return json({ error: "invalid kind" }, 400);
		if (!ref) return json({ error: "invalid ref" }, 400);
		return json(entityTags(db, kind, ref));
	}

	// ── GET /__dev/featured?kind=&ref= → { featured } (labels the toggle menu item) ─
	// cam|stream|feed: the homepage samples featured pins of every kind (see build.ts).
	if (req.method === "GET" && path === "/__dev/featured") {
		const q = new URL(req.url).searchParams;
		const kind = q.get("kind");
		const ref = q.get("ref");
		if (kind !== "cam" && kind !== "stream" && kind !== "feed") return json({ error: "invalid kind" }, 400);
		if (!ref) return json({ error: "invalid ref" }, 400);
		return json({ featured: isFeatured(db, kind, ref) });
	}

	// ── POST /__dev/feature {kind, ref, on} → set homepage-feature membership ───────
	if (req.method === "POST" && path === "/__dev/feature") {
		const { kind, ref, on } = await readBody(req);
		if (kind !== "cam" && kind !== "stream" && kind !== "feed") return json({ error: "invalid kind" }, 400);
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
		const changes = deleteWebcamsByIp(db, ip);
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

	// ── POST /__dev/thumbnail {kind, ref, port?, mime, data, permanent} → overwrite ss_* ──
	// `data` is raw base64 (no data: prefix). cam id = ref:port (port = the detail shot, or a
	// card's shown rep shot); stream/feed id = ref. permanent=true locks it against re-scan
	// (last_seen sentinel); permanent=false stamps now (clearing any prior lock). The new
	// image only appears on the site after `bun run bake` re-extracts out/img/.
	if (req.method === "POST" && path === "/__dev/thumbnail") {
		const { kind, ref, port: rawPort, mime, data, permanent } = await readBody(req);
		if (kind !== "cam" && kind !== "stream" && kind !== "feed") return json({ error: "invalid kind" }, 400);
		if (typeof ref !== "string" || ref.trim() === "") return json({ error: "invalid ref" }, 400);
		if (typeof mime !== "string" || !isSafeImageMime(mime)) return json({ error: "unsupported image type" }, 400);
		if (typeof data !== "string" || data === "") return json({ error: "no image data" }, 400);
		if (typeof permanent !== "boolean") return json({ error: "invalid permanent" }, 400);
		const buf = Buffer.from(data, "base64");
		if (buf.length === 0) return json({ error: "empty image" }, 400);
		let id = ref;
		if (kind === "cam") {
			const p = Number(rawPort);
			if (isIP(ref) === 0) return json({ error: "invalid ip" }, 400);
			if (!Number.isInteger(p) || p < 0) return json({ error: "invalid port" }, 400);
			id = `${ref}:${p}`;
		}
		const hash = createHash("sha256").update(buf).digest("hex");
		return setThumbnail(db, id, mime, hash, data, permanent)
			? json({ kind, ref, id, permanent, bytes: buf.length })
			: json({ error: "not stored" }, 404);
	}

	// ── POST /__dev/tag {kind, ref, tag}, unified tagging (INSERT OR IGNORE) ───────
	// `kind` picks the source; `ref` is that source's key (ip_str / video_id / id).
	// Only cams get the isIP shape-check; stream/feed refs are opaque strings.
	if (req.method === "POST" && path === "/__dev/tag") {
		const { kind, ref, tag } = await readBody(req);
		if (kind !== "cam" && kind !== "stream" && kind !== "feed") return json({ error: "invalid kind" }, 400);
		if (typeof ref !== "string" || ref.trim() === "") return json({ error: "invalid ref" }, 400);
		if (kind === "cam" && isIP(ref) === 0) return json({ error: "invalid ip" }, 400);
		if (typeof tag !== "string" || tag.trim() === "") return json({ error: "invalid tag" }, 400);
		const added = addTag(db, kind, ref, tag);
		return json({ kind, ref, tag: tag.trim().toLowerCase(), added });
	}

	// ── POST /__dev/untag {kind, ref, tag}, remove one tag (inverse of /tag) ───────
	if (req.method === "POST" && path === "/__dev/untag") {
		const { kind, ref, tag } = await readBody(req);
		if (kind !== "cam" && kind !== "stream" && kind !== "feed") return json({ error: "invalid kind" }, 400);
		if (typeof ref !== "string" || ref.trim() === "") return json({ error: "invalid ref" }, 400);
		if (typeof tag !== "string" || tag.trim() === "") return json({ error: "invalid tag" }, 400);
		const removed = removeTag(db, kind, ref, tag);
		return json({ kind, ref, tag: tag.trim().toLowerCase(), removed });
	}

	// ── POST /__dev/remove {kind, ref}, plain delete (no blacklist) for any kind ──
	// A cam removes every port for the host (ref = ip_str); a stream/feed removes the one
	// row (ref = id). Also clears the entry's tags/featured pins. Nothing is recorded to
	// keep it out, so a removed entry returns if you re-ingest its source; use /blacklist
	// to keep a host out for good.
	if (req.method === "POST" && path === "/__dev/remove") {
		const { kind, ref } = await readBody(req);
		if (kind !== "cam" && kind !== "stream" && kind !== "feed") return json({ error: "invalid kind" }, 400);
		if (typeof ref !== "string" || ref.trim() === "") return json({ error: "invalid ref" }, 400);
		if (kind === "cam" && isIP(ref) === 0) return json({ error: "invalid ip" }, 400);
		const deleted = removeEntity(db, kind, ref);
		return deleted ? json({ kind, ref, deleted }) : json({ error: "not stored" }, 404);
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
		`Right-click a card or screenshot to blacklist / reorder / tag / remove / change thumbnail. Run \`bun run bake\` to regenerate the static site.`,
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
