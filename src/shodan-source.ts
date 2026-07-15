// Shodan-JSON loader logic, shared by the CLI (`bun import --shodan`) and the
// dev-mode web importer. Normalizes any supported JSON shape into a flat banner
// list and filters banners into insertable rows, applying the same blacklist and
// RDP/VNC product guards as the scraper. DB-free: the caller loads the blacklist
// (loadBlacklist) and owns the inserter (makeInserter).

import { asMatch, getScreenshot, isBlockedProduct, toRow } from "./util.ts";
import type { Blacklist } from "./db.ts";
import type { CamRow, WebcamMatch } from "./types.ts";

/** Normalize any supported JSON shape into a flat list of banners, or null if unrecognized. */
export function toBanners(parsed: unknown): WebcamMatch[] | null {
  if (Array.isArray(parsed)) return parsed as WebcamMatch[];
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.matches)) return o.matches as WebcamMatch[]; // search response
    if (Array.isArray(o.data)) return o.data as WebcamMatch[]; // host-info object
    if (typeof o.port === "number") return [parsed as WebcamMatch]; // single banner
  }
  return null;
}

/** Insertable rows plus a per-list tally (the counts the import summary reports). */
interface ShodanScan {
  rows: CamRow[];
  banners: number;
  /** Banners kept: passed the blacklist, carry a screenshot, and aren't RDP/VNC. */
  screenshots: number;
  blocked: number;
  blacklisted: number;
}

/**
 * Filter a banner list into insertable rows, in the exact order the scraper/importer
 * apply: skip blacklisted hosts, then banners with no screenshot, then RDP/VNC
 * products. Only banners that clear all three become rows.
 */
export function scanBanners(list: WebcamMatch[], bl: Blacklist): ShodanScan {
  const rows: CamRow[] = [];
  let banners = 0;
  let screenshots = 0;
  let blocked = 0;
  let blacklisted = 0;
  for (const raw of list) {
    banners++;
    const m = asMatch(raw);
    if (bl.blocks(m)) {
      blacklisted++;
      continue;
    }
    const ss = getScreenshot(m);
    if (!ss) continue;
    if (isBlockedProduct(m.product)) {
      blocked++;
      continue;
    }
    screenshots++;
    const row = toRow(m, ss);
    if (row) rows.push(row);
  }
  return { rows, banners, screenshots, blocked, blacklisted };
}
