// Our own view of the Shodan data. `shodan-ts`'s ShodanService has a
// `[key: string]: unknown` catch-all and does NOT model `screenshot`, so we
// define the fields we actually consume and cast at the boundary (see util.ts).

/** The screenshot sub-object attached to a banner. `mime` (not `mimetype`) is the format. */
export interface ShodanScreenshot {
  /** Base64-encoded image bytes (no `data:` prefix). */
  data: string;
  /** MIME type, e.g. "image/jpeg". */
  mime: string;
  /** Numeric hash of the image (signed 32-bit, may be negative). */
  hash: number;
  /** ML-generated labels, e.g. ["webcam", "login"]. */
  labels?: string[];
  /** OCR text extracted from the image. */
  text?: string;
}

/** Location fields we read off a match (all optional/nullable, so code defensively). */
export interface MatchLocation {
  city?: string | null;
  region_code?: string | null;
  country_code?: string | null;
  country_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  area_code?: number | null;
}

/** The subset of a search match we care about. Nearly everything is optional. */
export interface WebcamMatch {
  ip_str?: string;
  port?: number;
  transport?: string | null;
  timestamp?: string | null;
  hostnames?: string[];
  domains?: string[];
  org?: string | null;
  isp?: string | null;
  asn?: string | null;
  os?: string | null;
  product?: string | null;
  tags?: string[];
  location?: MatchLocation;
  /** Untyped in shodan-ts; we extract via getScreenshot(). */
  screenshot?: unknown;
  /** Untyped in shodan-ts; carries the per-banner UUID under `.id`. */
  _shodan?: unknown;
}

/**
 * A row to INSERT into the `webcams` table. Keys map 1:1 to the insert columns
 * (an index signature is included so it binds to Bun's named-parameter API).
 */
export type CamRow = {
  ip_str: string;
  port: number;
  shodan_id: string | null;
  transport: string | null;
  timestamp: string | null;
  hostnames: string; // JSON array
  domains: string; // JSON array
  org: string | null;
  isp: string | null;
  asn: string | null;
  os: string | null;
  product: string | null;
  country_name: string | null;
  country_code: string | null;
  city: string | null;
  region_code: string | null;
  latitude: number | null;
  longitude: number | null;
  tags: string; // JSON array
  ss_mime: string;
  ss_hash: number | null;
  ss_base64: string;
  raw_json: string;
} & Record<string, string | number | null>;

/** A row as read back from the DB (adds the generated + app-managed columns). */
export type StoredRow = CamRow & { first_seen: string; last_seen: string; preferred: number };
