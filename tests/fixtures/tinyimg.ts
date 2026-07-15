// A 1x1 PNG, base64-encoded (no `data:` prefix), reused as every fixture screenshot.
// Small enough to inline, but real decodable image bytes so `bun bake`'s extractImages
// writes a genuine file to out/img/ and the baked cards have working backgrounds.

export const TINY_PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const TINY_PNG_MIME = "image/png";

/** sha256 hex of the decoded bytes. Stored in ss_hash (change detection); build recomputes
 *  the on-disk filename hash itself, so this only needs to be a stable, correct digest. */
export function sha256Hex(b64: string): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(Buffer.from(b64, "base64"));
	return h.digest("hex");
}

export const TINY_PNG_HASH = sha256Hex(TINY_PNG_B64);
