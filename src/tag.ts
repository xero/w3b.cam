// Tag: attach a free-form metadata tag to a host (IP), stored in ip_tags. A single
// IP may carry several tags; they render comma-joined on the host page. Tags are
// normalized (trimmed + lowercased) so casing/whitespace never dupes one. Re-run
// `bun run bake` afterwards to reflect it on the site. No API, no query credits.
//
// Usage:  bun run tag <ip> <tag>

import { isIP } from "node:net";
import { addIpTag, closeDb, hasHost, openDb } from "./db.ts";

const ip = Bun.argv[2]?.trim();
const tag = Bun.argv[3]?.trim();

if (!ip || isIP(ip) === 0 || !tag) {
  console.error("Usage: bun run tag <ip> <tag>");
  process.exit(1);
}

const db = openDb();

try {
  const added = addIpTag(db, ip, tag);
  console.log(`\n── Tag summary ──`);
  console.log(`IP:         ${ip}`);
  console.log(`Tag:        ${tag.toLowerCase()}`);
  console.log(`Applied:    ${added ? "added" : "already tagged"}`);
  if (!hasHost(db, ip)) {
    console.warn(`⚠ ${ip} has no stored cameras. Check for a typo. Recorded anyway; it applies if the host is scraped later.`);
  }
  console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
} finally {
  closeDb(db);
}
