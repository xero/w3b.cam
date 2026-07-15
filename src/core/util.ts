import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { CamRow, ShodanScreenshot, WebcamMatch } from "./types.ts";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn` over `items` with at most `n` in flight, preserving input order in the results. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * A random sample of up to `n` distinct items from `arr` (partial Fisher-Yates over a
 * copy; `arr` is not mutated). Returns min(n, arr.length) items; n <= 0 yields [].
 */
export function pickRandom<T>(arr: readonly T[], n: number): T[] {
  const a = arr.slice();
  const k = Math.max(0, Math.min(n, a.length));
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, k);
}

/** Parse a positive-int flag, or 0 (meaning "no limit / use the default") when absent/invalid. */
export const num = (s?: string): number => (s ? Math.max(1, Number.parseInt(s, 10) || 0) : 0);

/** Prompt y/N (default No). A non-TTY stdin reads as No. */
export function promptYesNo(): boolean {
  const answer = prompt("Proceed? [y/N]");
  return answer != null && /^y(es)?$/i.test(answer.trim());
}

/** Read a required env var or exit with a clear message. */
export function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`Missing required environment variable: ${name}`);
    console.error(`Export it, e.g.  export ${name}=xxxxxxxx`);
    process.exit(1);
  }
  return value;
}

/**
 * Register a GitHub Actions step output (`name=value`) so later steps and
 * downstream jobs can gate on it. No-op locally (GITHUB_OUTPUT unset), so the
 * same scripts run identically outside CI.
 */
export function setStepOutput(name: string, value: string | number | boolean): void {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${name}=${value}\n`);
}

/**
 * Publish a "does the site need rebuilding?" signal for CI to gate on.
 * Prints a human line always; in GitHub Actions also sets a `build_needed`
 * step output, so a downstream deploy job can skip when a run changed nothing.
 */
export function emitBuildNeeded(needed: boolean): void {
  console.log(`\nSite rebuild ${needed ? "needed" : "not needed"}.`);
  setStepOutput("build_needed", needed);
}

/** Escape a value for safe interpolation into HTML text or a double-quoted attribute. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Cast a raw match (typed `unknown` by shodan-ts) into our interface, once, at the edge. */
export const asMatch = (raw: unknown): WebcamMatch => raw as WebcamMatch;

/** Pull the per-banner UUID out of the untyped `_shodan` object. */
function shodanId(m: WebcamMatch): string | null {
  const sh = m._shodan;
  if (sh && typeof sh === "object" && "id" in sh) {
    const id = (sh as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/** Safely extract a usable screenshot, or null if the banner has none. */
export function getScreenshot(m: WebcamMatch): ShodanScreenshot | null {
  const s = m.screenshot as Partial<ShodanScreenshot> | null | undefined;
  if (!s || typeof s.data !== "string") return null;
  // Shodan wraps the base64 at 76 cols; strip whitespace to a single clean payload.
  const data = s.data.replace(/\s/g, "");
  if (data.length === 0) return null;
  return {
    data,
    mime: typeof s.mime === "string" && s.mime ? s.mime : "image/jpeg",
    hash: typeof s.hash === "number" ? s.hash : 0,
    labels: Array.isArray(s.labels) ? s.labels : undefined,
    text: typeof s.text === "string" ? s.text : undefined,
  };
}

/**
 * Service products to skip at ingestion. Shodan's classifier labels some RDP and
 * VNC login screens as "webcam", so they slip past the search query. Drop them by
 * product name. Compared case-insensitively and trimmed.
 */
export const BLOCKED_PRODUCTS: ReadonlySet<string> = new Set([
  "remote desktop protocol",
  "vnc",
]);

/** True when a match's product is one we skip (an RDP/VNC screen that looks like a webcam). */
export function isBlockedProduct(product: unknown): boolean {
  return typeof product === "string" && BLOCKED_PRODUCTS.has(product.trim().toLowerCase());
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const isBadHost = (h: string): boolean => {
  const t = h.trim().toLowerCase();
  return t === "" || t === "localhost" || t === "localhost.";
};

interface DisplayParts {
  /** First real domain/hostname, or null when only the host:ports should show. */
  name: string | null;
  /** IP, IPv6 bracketed so `host:port` stays unambiguous. */
  host: string;
  /** Every port the host was seen on, in the order its shots render. */
  ports: number[];
}

/**
 * Split a host into its display segments. Domains are preferred over reverse-DNS
 * hostnames since they read more cleanly; blank and localhost entries are skipped.
 * IPv6 literals are bracketed so `host:port` stays unambiguous.
 */
export function displayParts(
  hostnames: string[],
  domains: string[],
  ip: string,
  ports: number[],
): DisplayParts {
  const name =
    [...domains, ...hostnames].find((h) => typeof h === "string" && !isBadHost(h)) ?? null;
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return { name, host, ports };
}

/**
 * Plain-text title for a host (used for the document <title>): first real
 * domain/hostname followed by ` / ` and the host:ports, else just the host:ports.
 */
export function pickDisplayName(
  hostnames: string[],
  domains: string[],
  ip: string,
  ports: number[],
): string {
  const { name, host, ports: p } = displayParts(hostnames, domains, ip, ports);
  const hostPort = p.length ? `${host}:${p.join(",")}` : host;
  return name ? `${name} / ${hostPort}` : hostPort;
}

/** Full match minus the huge base64 image (kept separately in ss_base64) for the raw_json column. */
function rawWithoutImage(m: WebcamMatch): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(m as Record<string, unknown>) };
  const ss = copy.screenshot;
  if (ss && typeof ss === "object") {
    const { data: _omitBytes, ...rest } = ss as Record<string, unknown>;
    copy.screenshot = rest;
  }
  return copy;
}

/** Map a match + its screenshot into a unified `cams` row (kind='cam'). Returns null if it lacks an ip/port. */
export function toRow(m: WebcamMatch, ss: ShodanScreenshot): CamRow | null {
  if (typeof m.ip_str !== "string" || typeof m.port !== "number") return null;
  const loc = m.location ?? {};
  const hostnames = asStringArray(m.hostnames);
  const domains = asStringArray(m.domains);
  // Display name: first real domain/hostname (see displayParts), else the Shodan
  // product, else the bare IP. Stored so the unified dataset has one name per row.
  const name = displayParts(hostnames, domains, m.ip_str, []).name ?? m.product ?? m.ip_str;
  return {
    id: `${m.ip_str}:${m.port}`,
    kind: "cam",
    source: "shodan",
    feed_kind: "screenshot",
    name,
    product: m.product ?? null,
    ip_str: m.ip_str,
    port: m.port,
    lat: typeof loc.latitude === "number" ? loc.latitude : null,
    lng: typeof loc.longitude === "number" ? loc.longitude : null,
    city: loc.city ?? null,
    country_code: loc.country_code ?? null,
    country_name: loc.country_name ?? null,
    region_code: loc.region_code ?? null,
    ss_mime: ss.mime,
    // sha256 of the screenshot bytes, uniform with the other sources (Shodan's own
    // numeric perceptual hash stays in raw_json.hash).
    ss_hash: createHash("sha256").update(Buffer.from(ss.data, "base64")).digest("hex"),
    ss_base64: ss.data,
    shodan_id: shodanId(m),
    hostnames: JSON.stringify(hostnames),
    domains: JSON.stringify(domains),
    org: m.org ?? null,
    isp: m.isp ?? null,
    asn: m.asn ?? null,
    observed_at: m.timestamp ?? null,
    raw_json: JSON.stringify(rawWithoutImage(m)),
  };
}
