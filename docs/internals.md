# Internals

> [!NOTE]
> How the pieces fit: the unified data model, the cross-cutting site features (escaping, the world map, feed syndication), and the full project layout.

> ### Table of Contents
> - [The data model](#the-data-model)
> - [Escaping untrusted input](#escaping-untrusted-input)
> - [The world map](#the-world-map)
> - [Feed syndication](#feed-syndication)
> - [Project layout](#project-layout)

---

## The data model

Every camera lives in one `cams` table, whatever its source. A `kind` column discriminates the three:

- **cam.** A Shodan-discovered device, keyed on `ip:port`, with the screenshot baked in.
- **feed.** A live-pointer feed (MJPEG, HLS, or an Osiris cam), keyed on a slug.
- **stream.** A YouTube live stream, keyed on the video id, with the thumbnail as its screenshot.

A second `feed_kind` column records how a row renders: `screenshot`, `jpg`, `mjpeg`, `mp4`, `hls`, `youtube`, or `link`. An http MJPEG feed that browsers block as mixed content stores as `kind='feed'` with `feed_kind='link'`, so its card shows the baked still plus a "View live" link rather than an embed. Geolocation is one `lat`/`lng` pair shared across every kind.

Three side tables hang off it:

- **meta.** One polymorphic table for tags, featured pins, and super-feature groups, keyed on `(kind, ref, type, value)`. `type` is `tag`, `featured`, or `superfeature`.
- **blacklist and host_blacklist.** Blocked IPs and blocked hostnames or domains, so a dropped host never re-ingests.
- **fingerprints.** One audit row per fingerprinted cam or feed recording which signal named which vendor at what confidence. See [Fingerprinting](./fingerprinting.md).

Tags, featured pins, and geolocation are unified across all three sources, so tagging `street` on a webcam, a stream, and a feed cam groups all three under one `/tags/street` page.

---

## Escaping untrusted input

The visualizer escapes everything. Banner text such as the organization name and hostnames comes from scanned hosts and is untrusted, so every value is HTML-escaped before it reaches the page. Host folder names keep the dotted IP but pass a hex-and-dot allowlist, and feed folder names an `[A-Za-z0-9_.-]` allowlist, so a hostile value cannot escape the output directory. YouTube titles and channel names are escaped the same way, and a video-id slug is allowlisted to `[A-Za-z0-9_-]`.

---

## The world map

`/map`, in the header nav, is one baked SVG that plots every located camera across all three sources as a dot linking to its detail page. Shodan and feed cams carry coordinates already; YouTube publishes none, so `bun geo <video_id> <lat> <lng>` assigns one by hand (see [Curation](./curation.md#geo)). With JavaScript on you drag to pan and scroll to zoom; without it the map is a fixed world view whose dots are still plain links, each with a location tooltip.

---

## Feed syndication

Every build writes `rss.xml` (RSS 2.0) and `atom.xml` (Atom 1.0), each holding the 50 newest discovered hosts with the screenshot as an enclosure, and the header links both. A new camera the scheduled scraper finds shows up in your reader without a visit to the site.

---

## Project layout

```
src/
  core/           shared foundation, imported everywhere
    config.ts       query and tuning constants
    types.ts        screenshot, match, and row interfaces
    util.ts         escaping, screenshot extraction, row mapping
    cli.ts          shared argument parsing for the small curation CLIs
  db/             schema, inserts, and database-lifecycle commands
    db.ts           barrel re-exporting store/*
    store/          schema, inserts, reads, tags, featured, ytgeo, moderation
    initdb.ts       create and seed an empty database
    sync.ts         pull, push, or merge the database with the db-store release
    merge.ts        merge new webcam rows from one database into another
  scrape/         Shodan API acquisition
    shodan.ts       client factory and retry/backoff wrapper
    scraper.ts      fetch cameras from the Shodan API, dedupe, store
    preflight.ts    CI credit precheck: skip a scrape when no query credits remain
  ingest/         parse external inputs into rows
    ingest.ts       barrel re-exporting core/*, the shared ingest surface
    core/           per-source ingest: shared, shodan, youtube, mjpeg, hls, osiris
    shodan-source.ts normalize and filter raw Shodan JSON banners into rows
    mjpeg-source.ts classify an MJPEG cam URL by vendor (endpoint fingerprints)
    hls-source.ts   ingest a curated .m3u8 list as vendor-agnostic hls feed rows
    osiris-source.ts classify + snapshot Osiris cams; shared feed row builder
    yt-api.ts       YouTube Data API client, youtube.md parser, thumbnail fetch
    import.ts       unified importer CLI: --shodan | --youtube | --mjpeg | --hls
    osiris.ts       internal: re-ingest the one-off Osiris dump into feed
  fingerprint/    camera make/model derivation
    fingerprint.ts  derive camera make/model from a banner into the product field
    fingerprint-cli.ts  catch-up backfill that rebuilds the fingerprint table on demand
  curate/         database-editing commands
    blacklist.ts    drop a host and record it so scrapes skip it
    unblacklist.ts  reverse a blacklist entry
    remove.ts       delete a stored entry without blacklisting it
    reorder.ts      pin a host's card image to one port
    tag.ts          attach a free-form label to a cam, stream, or feed cam
    untag.ts        remove a tag from a cam, stream, or feed cam
    geo.ts          assign a YouTube stream's map coordinates (cams.lat/lng)
    feature.ts      add a cam or stream to the homepage featured set
    unfeature.ts    remove a cam or stream from the featured set
    superfeature.ts group feed cams into a one-off homepage event banner
    purge.ts        remove stored RDP/VNC rows that predate the ingest filter
  site/           database to static site
    render.ts       barrel re-exporting render/*
    render/         primitives, pager, shared, host, stream, feed, tags, map, pages, shell
    build.ts        orchestrator; build/* holds the image, meta, home, and page helpers
    build/          images, meta, home, pages
    urls.ts         the route layer: one place that decides every site path
    syndication.ts  render the newest hosts as rss.xml / atom.xml feeds
    tips.ts         the cam-hunting guide as pre-rendered HTML for the tips page
    worldmap.ts     pre-projected world-country outlines for the map page
    autotags.ts     derived auto-tags (transport kind, http) for the tag cloud
  server/         static and dev servers
    serve.ts        static file server for out/
    dev.ts          local dev server with right-click blacklist/reorder/tag
    dev-client/     browser editing UI (js and css), served from source
in/                curated inputs (gitignored)
  youtube.md       YouTube live-stream list, source for `bun import --youtube`
  mjpeg.md         MJPEG camera URL list, source for `bun import --mjpeg`
  *.json           raw Shodan JSON for `bun import --shodan`
  new/osiris-cameras.json  Osiris dump, source for the internal `bun run osiris`
camhunting.sqlite  generated database (gitignored)
out/               generated site (gitignored). Clean folder URLs: every page is a
                   folder holding index.html, with a co-located index.snippet.html for
                   htmx swaps. Bare landings (/hosts) mirror page 1 (/hosts/1).
  index.html          curated homepage (featured + newest cams and streams)
  gallery/{n}/        all-kinds gallery, newest-discovered first
  hosts/{n}/          paginated cams gallery
  hosts/<ip>/         one page per host (dotted IPv4, e.g. hosts/194.94.76.131)
  streams/{n}/        paginated YouTube streams gallery
  streams/yt-<id>/    one page per YouTube stream
  feeds/{n}/          paginated feeds gallery
  feeds/<slug>/       one page per feed (mjpeg-<ip> reads as feeds/<ip>)
  event/<slug>/       combined super-feature event page (grouped feeds + homepage banner)
  fingerprints/       make/model/count breakdown, each make linking its vendor gallery
  fingerprints/<vendor>/{n}/  per-vendor gallery of matching cams
  tags/               tag cloud, links to per-tag browse pages
  tags/<slug>/{n}/    one paginated browse page per tag
  map/                world map of every geolocated camera
  tips/               cam-hunting guide (baked from src/site/tips.ts, served at w3b.cam/tips)
  rss.xml             RSS 2.0 feed of the 50 newest discovered hosts
  atom.xml            Atom 1.0 feed of the same
  img/                extracted screenshots and thumbnails
  htmx.min.js         vendored htmx library
  hls.min.js          vendored hls.js, fetched on demand to play an HLS feed
  icons.svg           sprite sheet the nav and cards reference
  <assets>            favicons and the web manifest, copied verbatim from assets/
```
