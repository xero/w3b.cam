// Screenshot extraction + the image manifest. Decodes each row's baked base64 to a
// content-hashed file under out/img/ (deduped), and persists/loads the id→url maps so a
// later `--index-only` build reuses the on-disk images without re-hashing every row.

import { createHash } from "node:crypto";
import { IMG_DIR, MANIFEST } from "../../core/config.ts";
import { extFromMime } from "../render.ts";

/**
 * Decode each row's screenshot to a file under out/img/ (deduped by content
 * hash) and return a map from the row's key to its image URL. Rows with no
 * stored image are skipped (a YouTube thumbnail fetch can fail), so their key is
 * absent and the caller renders a placeholder. `written` is shared across calls
 * so the webcam and YouTube passes dedupe against each other and the final image
 * count is accurate.
 */
/** The three id→url image maps a build resolves, serialized for `--index-only` reuse. */
export type ImgManifest = { cams: Map<string, string>; streams: Map<string, string>; feeds: Map<string, string> };

/** Persist the resolved image URLs so a later `--index-only` build reuses the on-disk
 *  screenshots without re-decoding and re-hashing every row. Written on every full bake. */
export async function writeManifest(m: ImgManifest): Promise<void> {
	const obj = { cams: Object.fromEntries(m.cams), streams: Object.fromEntries(m.streams), feeds: Object.fromEntries(m.feeds) };
	await Bun.write(MANIFEST, JSON.stringify(obj));
}

/** Load the image manifest a prior full bake wrote, or null if it is missing or unreadable
 *  (which sends `--index-only` down a one-time full build instead of failing). */
export async function loadManifest(): Promise<ImgManifest | null> {
	try {
		const raw = await Bun.file(MANIFEST).json();
		return {
			cams: new Map(Object.entries(raw.cams ?? {}) as [string, string][]),
			streams: new Map(Object.entries(raw.streams ?? {}) as [string, string][]),
			feeds: new Map(Object.entries(raw.feeds ?? {}) as [string, string][]),
		};
	} catch {
		return null;
	}
}

export async function extractImages<T>(
	rows: T[],
	key: (row: T) => string,
	ssBase64: (row: T) => string | null,
	ssMime: (row: T) => string | null,
	written: Set<string>,
): Promise<Map<string, string>> {
	const byKey = new Map<string, string>();
	for (const r of rows) {
		const b64 = ssBase64(r);
		if (!b64) continue;
		// Same base64 cleanup the single-page build did: strip any line wrapping.
		const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
		const buf = Buffer.from(clean, "base64");
		if (buf.length === 0) continue;
		const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
		const name = `${hash}.${extFromMime(ssMime(r) ?? "")}`;
		if (!written.has(name)) {
			await Bun.write(`${IMG_DIR}/${name}`, buf);
			written.add(name);
		}
		byKey.set(key(r), `/img/${name}`);
	}
	return byKey;
}
