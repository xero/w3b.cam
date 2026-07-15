// Pure rendering: DB rows -> HTML strings. No IO here (build.ts does the writing and
// image extraction). Every banner-derived string is attacker-controlled, so it is
// HTML-escaped before interpolation. Split into render/* modules; this barrel re-exports
// their public API so callers keep importing from "../site/render.ts". Internal helpers
// (pagers, shared card/detail infra, primitives beyond the public few) stay module-local.

export { T, project, extFromMime, isSafeImageMime } from "./render/primitives.ts";
export { groupByIp, renderIndexMain, renderHomeMain, renderHostMain, type Host } from "./render/host.ts";
export { toYtStream, renderYtMain, renderYtDetail, type YtStream } from "./render/stream.ts";
export { toFeedCam, renderFeedMain, renderFeedDetail, renderEventDetail, type FeedCam } from "./render/feed.ts";
export { renderTagsMain, renderFingerprintsMain, renderTagBrowseMain, renderGalleryMain, renderVendorMain, type TagItem } from "./render/tags.ts";
export { renderMapMain, type MapPoint } from "./render/map.ts";
export { renderTipsMain, renderImportForm, renderImportMain } from "./render/pages.ts";
export { TITLE, renderShell, type SiteStats } from "./render/shell.ts";
