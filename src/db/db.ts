// Aggregated DB surface. The store was split into focused modules under store/*; this
// barrel re-exports their public API so callers keep a single import surface
// (`import { openDb, loadTags, ... } from "../db/db.ts"`). The internal helpers in
// store/common.ts are deliberately NOT re-exported, keeping the public surface identical
// to the pre-split db.ts.
//
//   schema      — table DDL, fresh-DB seeds, openDb/closeDb, the TagKind discriminator
//   inserts     — the transactional cam/stream/feed upserters + fingerprint hooks
//   reads       — counts, row readers (full + metadata-only), presence checks, vendor index
//   tags        — free-form tag CRUD on the `meta` table
//   featured    — homepage feature pins + super-feature event groups
//   ytgeo       — hand-assigned stream coordinates
//   moderation  — blacklists, deletions, preferred-image pins, thumbnail overrides

export * from "./store/schema.ts";
export * from "./store/inserts.ts";
export * from "./store/reads.ts";
export * from "./store/tags.ts";
export * from "./store/featured.ts";
export * from "./store/ytgeo.ts";
export * from "./store/moderation.ts";
