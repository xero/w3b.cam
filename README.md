# Shodan Webcam Visualizer

> [!NOTE]
> A handful of Bun scripts around a local SQLite database. One scrapes webcam screenshots from the Shodan REST API, another catalogs YouTube live cams from a curated list, and a third bakes a paginated static site from it all; the rest import, curate, and publish the data.

---

> ### Table of Contents
> - [Requirements](#requirements)
> - [Setup](#setup)
> - [Getting the database](#getting-the-database)
> - [Usage](#usage)
> - [Editing locally](#editing-locally)
> - [How it works](#how-it-works)
> - [Query credits](#query-credits)
> - [Project layout](#project-layout)
> - [GitHub Actions](#github-actions)

---

## Requirements

- [Bun](https://bun.com) 1.3 or newer.
- A Shodan account with an API key. A paid membership is not required, but the free tier gives you very few query credits.
- Your API key exported as the `SHODANTOKEN` environment variable.

```sh
export SHODANTOKEN=your_api_key_here
```

To ingest YouTube streams you also need a YouTube Data API v3 key, exported as `YOUTUBE_API_KEY`. It reads public video metadata only; an API key cannot modify a channel (that needs OAuth, which this project never uses). Skip it if you only use the Shodan source.

```sh
export YOUTUBE_API_KEY=your_api_key_here
```

---

## Setup

```sh
bun install
```

That installs `shodan-ts` (the API client) and Bun's type definitions. SQLite is built into Bun, so there is nothing else to add.

Run `bun typecheck` at any point to type-check the sources with `tsc --noEmit`.

---

## Getting the database

The database is not in the repo. `camhunting.sqlite` runs to a few hundred MB and only grows, so it lives as an asset on a public prerelease named `db-store` rather than in git. You have two ways to get one: pull the published copy the live site builds from, or start fresh with an empty one.

**Pull the published database.** This is the exact database the site serves, ready to browse and edit.

```sh
bun sync --pull
```

It downloads `camhunting.sqlite` from the `db-store` release, overwrites your local copy, and removes the stale `-wal` and `-shm` sidecars so SQLite reads the fresh file cleanly. The repo is public, so any GitHub account works and you do not need to be a collaborator. Sync drives the `gh` CLI, so install and authenticate it first with `gh auth login`. See [Editing locally](#editing-locally) for the full edit loop.

**Download it without `gh`.** The release is public, so you can fetch the asset straight over HTTPS with no CLI and no login. Delete the sidecars yourself afterward, since a plain download skips that step.

```sh
curl -L -o camhunting.sqlite \
  https://github.com/xero/w3b.cam/releases/download/db-store/camhunting.sqlite
rm -f camhunting.sqlite-wal camhunting.sqlite-shm
```

**Start fresh instead.** To build your own database from an empty, seeded one rather than the published data, run `bun initdb` and populate it with `bun scrape` or `bun import`.

---

## Usage

The core pipeline is four commands. Cameras come from two sources: the Shodan API (`scrape`) or raw JSON files you already have (`import`). A separate command, `youtube`, adds YouTube live cams from a curated list. Every source writes to the same database, `bake` turns it into a static site, and `serve` hosts that site locally.

**`bun scrape [--pages N]`.** Fetches `N` search pages (default 1, 100 results per page) and saves new cameras to `camhunting.sqlite`. Re-running is safe; cameras already stored are skipped. Costs 1 query credit per page.

**`bun import [dir]`.** Loads raw Shodan JSON files into the database from a directory (default `./in`). It reads every `.json` file it finds, uses no API and no credits, skips files it cannot parse with a warning, and stores only cameras that have a screenshot. Accepts host lookups, search results, and single banners.

**`bun bake`.** Reads the database and writes a paginated static site to `out/`. It groups rows by IP into one entry per host, extracts each screenshot to a file under `out/img/`, and emits an index paginated 8 hosts to a page alongside a standalone page for every host. The `out/` directory is wiped and rebuilt on every run. Costs nothing and hits no API.

**`bun serve`.** Serves `out/` over HTTP at `http://localhost:1337`. The site needs a server because its htmx navigation fetches page fragments, and browsers block those requests over `file://`. Override the port with `PORT=3000 bun serve`.

```sh
bun scrape --pages 5
bun bake
bun serve
```

Then open `http://localhost:1337`.

You can override the search query with `--query "your query"`. The default is:

```
has_screenshot:1 screenshot.label:webcam -screenshot.label:desktop
```

That matches hosts with a screenshot labeled as a webcam, excluding desktop captures.

### YouTube streams

**`bun youtube [--limit N]`.** Reads the local list at `in/youtube.md` (one `title <url>` per line, mixing `watch?v=`, `youtu.be/`, and `youtube.com/live/` forms), the list living in the same `in/` dir the importer reads. Both `in/` and `out/` are gitignored, so this list stays on your machine. Fetches each video's metadata and thumbnail from the YouTube Data API and upserts them into a separate `youtube` table keyed on the video id. Re-running refreshes existing streams and picks up updated live thumbnails rather than duplicating them. `--limit N` processes only the first N unique entries for a quick test. Needs `YOUTUBE_API_KEY`.

**`bun youtube --url <url> [--label "Title"]`.** Adds or refreshes a single stream by URL without touching the file. This is how the `youtube` CI workflow ingests one stream at a time, since the bulk list is not committed. `--label` sets the display title; omit it to fall back to the video's own title.

Streams get their own gallery at `/streams.html`, reachable from the header nav. `bake` renders every stream as its own card, and each stream's detail page links the other streams from the same channel.

```sh
export YOUTUBE_API_KEY=your_api_key_here
bun youtube
bun bake
bun serve
```

### MJPEG camhunt cams

**`bun mjpeg [file] [--limit N] [--concurrency N]`.** Reads a curated list of MJPEG camera URLs, one per line, defaulting to `in/new/mjpeg.md`. Blank lines and `#` comments are skipped, and an optional `label ` before the URL is kept. Like `in/youtube.md`, the list is gitignored and stays on your machine, so append to it and re-run as you hunt more cams. Each URL is classified by vendor from the fingerprints in [tips.md](./tips.md), a still is baked with ffmpeg for the gallery card, and the cam is upserted into the shared `traffic` table. Re-running refreshes thumbnails rather than duplicating cams. `--limit N` ingests only the first N unique cams; `--concurrency N` sets the snapshot fan-out, defaulting to 24.

The site is served over https, so how a cam plays depends on its feed. An https stream embeds live as a smooth Motion JPEG `<img>`; an https snapshot auto-refreshes; an http feed cannot embed, since browsers block mixed content, so it shows the baked still with a "View live" link that opens the feed in a new tab. Viewer-page URLs, such as Mobotix `guestimage.html`, Panasonic `CgiStart`, and Axis `#view`, are resolved to their real stream or snapshot endpoint so they still get a thumbnail. The cams join the traffic gallery at `/traffic.html`, labeled by vendor.

```sh
bun mjpeg
bun bake
bun serve
```

---

## Editing locally

Curating the data (blacklisting a host, pinning its card image, or tagging it) once meant running a workflow from the Actions tab, which edits the published database in place. You can now do all of it on your own machine against a local copy, preview the result in a browser, and publish only once you are happy with it. The loop is three commands.

```sh
bun sync --pull   # copy the published database down, overwriting your local one
bun dev           # serve it locally and edit by right-clicking
bun sync --push   # publish your edits and rebuild the live site
```

**`bun sync --pull`.** Downloads `camhunting.sqlite` from the `db-store` release and overwrites your local copy, so you start from exactly what the site is serving. It removes the stale `-wal` and `-shm` sidecars afterward so SQLite reads the fresh file cleanly.

**`bun dev`.** Bakes a dev build of the site, serves it at `http://localhost:1337`, and opens your browser. Right-click a cam card or screenshot to blacklist the host, pin that port as the card image, or attach a tag; right-click a stream or traffic card, or its detail page, to tag it too. The Tag menu lists the entity's current tags as chips, each with an × to remove it, so you add and remove in one place. Each action writes straight to the local database. Changes apply in the page immediately with no rebuild, because re-extracting thousands of screenshots from a database of a few hundred MB takes tens of seconds. Run `bun bake` when you want the static `out/` regenerated. It never runs in CI and never touches the published database.

**`bun sync --push`.** Uploads your local database over the `db-store` asset and triggers the `build` workflow, so the live site rebuilds from your edits. It creates the `db-store` release on the first push if none exists yet.

Both directions overwrite a whole database, so each one prints a size and timestamp comparison of the two copies and asks you to confirm. It warns you when the copy you are about to overwrite is newer than the one replacing it, since the scheduled scraper refreshes the published database every six hours and a stale local push could clobber newer data. Pass `--yes` to skip the prompt. Sync drives the `gh` CLI, so you need it installed and authenticated.

> [!WARNING]
> `--pull` clobbers your local database and `--push` clobbers the published one and redeploys the site. Mind the direction. If your local copy holds edits you have not pushed, reach for `--merge` instead of `--pull` to pick up the store's new cameras without losing them.

**`bun sync --merge`.** Pulls the published database and folds its new cameras into your local copy in one step, for when your local copy holds edits you have not pushed. The scheduled scraper adds cameras to the store every six hours, and a plain `--pull` would clobber your unpushed work just to pick them up. It backs up your current database to a timestamped `camhunting.sqlite-<epoch>.bak`, downloads the store to a scratch file, merges the store's new rows into a copy of your local database, and swaps that copy in as the live one. Your database is never overwritten in place; it is only replaced once the merge succeeds, so an interrupted run leaves the original untouched. It runs unattended, with no prompt. The backup is kept; delete it once you are happy with the result.

**`bun merge <source> <target>`.** The merge that `--merge` runs, exposed on its own for when you already have two databases side by side. It folds the new cameras from the source into the target instead of overwriting either:

```sh
bun merge camhunting.sqlite.prod camhunting.sqlite
```

It diffs the two `webcams` tables by their `(ip_str, port)` primary key and inserts only the cameras the target is missing, copied verbatim, including each camera's original `first_seen` and any pin. Rows the target already has are left untouched, so your own pins, tags, and curation survive. Only the target is written; the source is opened read-only. Pass `--dry-run` to preview the delta and write nothing, or `--yes` to skip the confirmation prompt.

---

## How it works

The scraper pages through search results and stores one row per camera service, keyed on the IP and port. Because that pair is the primary key, a second run inserts only cameras it has not seen before. Each row keeps the location, network owner, the screenshot as base64, and the full raw match as JSON for later use.

A few details worth knowing:

- **Screenshots need `minify: false`.** Shodan truncates large fields by default, which drops the screenshot. The client always requests full records.
- **Requests are paced to roughly one per second.** `shodan-ts` does no throttling and does not retry rate-limit errors, so the scraper spaces its calls and backs off on `429` and `5xx` responses.
- **RDP and VNC screens are filtered.** Some hosts serve a remote-desktop or VNC login that Shodan labels as a webcam. The scraper and importer skip any product of `remote desktop protocol` or `vnc` as they ingest. That guard only blocks new rows, so `bun purge` retroactively drops any that predate it. Re-run `bun bake` afterward.
- **Removed hosts stay removed.** `bun blacklist <ip-or-hostname>` deletes every matching row and records the entry in a blacklist table; the scraper and importer skip anything listed, so a host you drop never comes back on a later run. An IP matches exactly (every port); a hostname or domain matches itself and any subdomain, so `bun blacklist cloudzy.com` also drops `cam.node.cloudzy.com`. IPs live in a `blacklist` table, hostnames in a `host_blacklist` table. Reverse either with `bun unblacklist <ip-or-hostname>`, then re-run `bun scrape` to fetch the host again. A fresh database starts with a built-in list of blacklisted hostnames; IPs start empty.
- **You pick a host's card image.** A host seen on several ports has several screenshots, and its gallery card shows the most recent one by default. `bun reorder <ip> <port>` pins one port so its screenshot leads instead, and `bun reorder <ip> --clear` reverts to the default. The pin lives in a `preferred` column that the scraper and importer never overwrite, so it survives later runs. Re-run `bun bake` to rebuild the site.
- **Tags are unified across all three sources.** `bun tag <cam|stream|traffic> <ref> <tag>` attaches a free-form label to a cam (by IP), a stream (by video id), or a traffic cam (by id), stored in one `tags` table keyed on `(kind, ref, tag)`. The same tag spans every source, so tagging `street` on a webcam, a stream, and a traffic cam groups all three under it. Tags are normalized to lowercase and deduplicated, and an entity can carry several. They show on each detail page, size a tag cloud at `/tags.html` in the header nav, and each tag links to a paginated browse page mixing every entity that carries it. Remove one with `bun untag <cam|stream|traffic> <ref> <tag>`, or in `bun dev` by clicking the × on a tag chip in the right-click Tag menu. Existing `ip_tags` rows migrate into the new table automatically on first run, as `kind='cam'`; the old table is kept untouched as `ip_tags_migrated`. Re-run `bun bake` to rebuild the site.
- **YouTube streams live in their own table.** `bun youtube` reads `in/youtube.md`, pulls metadata and a thumbnail per video from the YouTube Data API, and stores them in a `youtube` table keyed on the video id, apart from the Shodan `webcams` table because the metadata differs. The thumbnail is the screenshot; YouTube keeps a 24/7 live cam's thumbnail current, so a re-run refreshes it. They render as a flat gallery at `/streams.html`, one card per stream, and each stream's page links the other streams sharing its channel.
- **MJPEG cams come from a curated URL list.** `bun mjpeg` reads `in/new/mjpeg.md`, one camera URL per line, and classifies each by vendor using the endpoint fingerprints in [tips.md](./tips.md). It bakes a still with ffmpeg for the card and upserts into the shared `traffic` table, distinguished by a per-vendor `source`. Because the site is https, only https feeds embed live, a smooth Motion JPEG `<img>` for streams and an auto-refreshing `<img>` for snapshots; http feeds are mixed-content-blocked, so they store as a `link` kind that shows the baked still plus a "View live" link. Viewer-page URLs resolve to their real media endpoint so they still yield a thumbnail. Re-run `bun bake` to rebuild the site.
- **The homepage is a curated mix.** `index.html` is a landing page, not page one of the index: it shows a cams row and a streams row, each two pinned cards followed by the two newest of that kind. `bun feature <cam|stream> <slot> <ref>` sets one of two slots per kind — an IP for a cam, a video id for a stream — stored in a `featured` table keyed on `(kind, slot)`. A pin whose row is gone is skipped and backfilled from the newest, so the page always fills four and four. The full paginated galleries are unchanged: cams move to `/page001.html`, streams stay at `/streams.html`, both reachable from the header nav. Re-run `bun bake` to rebuild the site.
- **The visualizer escapes everything.** Banner text such as the organization name and hostnames comes from scanned hosts and is untrusted, so every value is HTML-escaped before it reaches the page. IP-derived filenames are slugified against a hex allowlist, so a hostile value cannot escape the output directory. YouTube titles and channel names are escaped the same way, and a video-id slug is allowlisted to `[A-Za-z0-9_-]`.
- **Every geolocated camera plots on a world map.** `/map.html`, in the header nav, is one baked SVG that plots every located camera across all three sources as a dot linking to its detail page. Shodan and traffic cams carry coordinates already; YouTube publishes none, so `bun geo <video_id> <lat> <lng>` assigns one by hand into a `yt_geo` table (seeded with best-guess coordinates for the streams whose titles name a place). With JavaScript on you drag to pan and scroll to zoom; without it the map is a fixed world view whose dots are still plain links, each with a location tooltip. Re-run `bun bake` to rebuild the site.

- **The site works without JavaScript.** Every index page and per-host page is a real file with plain links, so it stays browsable on its own. When JavaScript is on, htmx intercepts those links and swaps only the page body, which skips reloading the shell and shared assets. Each page is generated in two forms, the full document and a body-only snippet, from a single source string so the two cannot drift.

---

## Query credits

> [!CAUTION]
> Search costs credits. Every filtered query spends 1 query credit per page, including the first. `scrape --pages N` spends about `N`. Checking the result count and your balance is free. Free accounts have a small monthly allowance, so start with one page and scale up once a run looks right.

---

## Project layout

```
src/
  initdb.ts       create and seed an empty database
  config.ts       query and tuning constants
  types.ts        screenshot, match, and row interfaces
  util.ts         escaping, screenshot extraction, row mapping
  shodan.ts       client factory and retry/backoff wrapper
  yt-api.ts       YouTube Data API client, youtube.md parser, thumbnail fetch
  db.ts           schema, open/close, and inserts
  scraper.ts      fetch cameras from the Shodan API, dedupe, store
  youtube.ts      fetch YouTube live-stream metadata + thumbnails, store
  import.ts       load cameras from raw Shodan JSON files, no API
  mjpeg.ts        ingest a curated MJPEG URL list into the traffic table
  mjpeg-source.ts classify an MJPEG cam URL by vendor (see tips.md)
  blacklist.ts    drop a host and record it so scrapes skip it
  unblacklist.ts  reverse a blacklist entry
  reorder.ts      pin a host's card image to one port
  tag.ts          attach a free-form label to a cam, stream, or traffic cam
  untag.ts        remove a tag from a cam, stream, or traffic cam
  feature.ts      pin a cam or stream to a homepage slot
  geo.ts          assign a YouTube stream's map coordinates (yt_geo)
  purge.ts        remove stored RDP/VNC rows that predate the ingest filter
  render.ts       pure HTML rendering (grouping, pager, pages, shell)
  worldmap.ts     pre-projected world-country outlines for the map page
  build.ts        database to static site (orchestrator)
  serve.ts        static file server for out/
  dev.ts          local dev server with right-click blacklist/reorder/tag
  dev-client/     browser editing UI (js and css), served from source
  sync.ts         pull, push, or merge the database with the db-store release
  merge.ts        merge new webcam rows from one database into another
in/                curated inputs (gitignored)
  youtube.md       YouTube live-stream list, source for `bun youtube`
  *.json           raw Shodan JSON for `bun import`
  new/mjpeg.md     MJPEG camera URL list, source for `bun mjpeg`
camhunting.sqlite  generated database (gitignored)
out/               generated site (gitignored)
  index.html    curated homepage (featured + newest cams and streams)
  page001.html  page 1 of the paginated cams gallery
  page002.html  full cams pages 2..N
  streams.html  page 1 of the YouTube streams gallery
  streams002.html  full streams pages 2..N
  <ip>.html     one page per host (dots become hyphens)
  yt-<id>.html  one page per YouTube stream
  traffic.html  page 1 of the traffic cams gallery
  traffic002.html  full traffic pages 2..N
  t-<id>.html   one page per traffic cam
  tags.html     tag cloud, links to per-tag browse pages
  tag-<slug>.html  one paginated browse page per tag
  map.html      world map of every geolocated camera
  img/          extracted screenshots and thumbnails
  snips/        body-only snippets for htmx swaps
  htmx.min.js   vendored htmx library
```

---

## GitHub Actions

Ten workflows in `.github/workflows/` run the same commands in CI. The site builds and deploys to GitHub Pages on its own, the scraper runs on a schedule, and adding a YouTube stream plus blacklist, reorder, tag, untag, feature, and geo edits happen from the Actions tab without a local checkout.

**`build`.** Bakes the database into `out/` and deploys it to GitHub Pages. It is reusable, so the other workflows call it after they change the data. Run it on its own to redeploy without scraping.

**`scrape`.** Runs every six hours (`0 */6 * * *`), or on demand with a page count. It restores the database, fetches new cameras, saves the database, then calls `build`. This is the only workflow that uses the `SHODANTOKEN` secret.

**`youtube`.** Adds or refreshes one stream on demand. Give it a YouTube URL and an optional label; it restores the database, fetches that video's metadata and thumbnail, saves the database, then calls `build`. This is the only workflow that uses the `YOUTUBE_API_KEY` secret, and it installs no extra binaries. The bulk list at `in/youtube.md` is not committed, so ingest many at once locally with `bun youtube` followed by `bun sync --push`.

**`blacklist`.** Takes an IP or a hostname, removes the matching cameras, saves the database, then calls `build` so the site drops them.

**`unblacklist`.** Takes an IP or a hostname and clears it from the blacklist. It does not rebuild, because no camera data changes until the next scrape re-adds the host.

**`reorder`.** Takes an IP and a port, pins that port's screenshot as the host's gallery card, saves the database, then calls `build` so the new card appears on the site.

**`tag`.** Takes a kind (cam, stream, or traffic), a ref (an IP, a video id, or a cam id), and a tag, attaches the label to that entity, saves the database, then calls `build` so the tag appears on the site.

**`untag`.** Takes the same kind, ref, and tag as `tag` and removes that label from the entity, saves the database, then calls `build` so the tag drops from the site.

**`feature`.** Takes a kind (cam or stream), a slot (1 or 2), and a ref (an IP for a cam, a video id for a stream), pins it to that homepage slot, saves the database, then calls `build` so the homepage updates.

**`geo`.** Takes a video id, a latitude, and a longitude, assigns that stream's map coordinates in the `yt_geo` table, saves the database, then calls `build` so the stream appears on the map.

### The database store

`camhunting.sqlite` is too large for git (a few hundred MB, and it only grows), so it lives as an asset on a prerelease named `db-store` instead of in the repo. Every workflow that changes the database restores it from that release first and uploads the new copy when it finishes. `build` reads it without saving. All the writing workflows share one concurrency group (`db-write`), so a scheduled scrape, the YouTube ingester, and a manual blacklist can never run at the same time and clobber each other. `bun sync` moves that same asset to and from your machine, which is how edits you make locally reach the site; see [Editing locally](#editing-locally).

### Running a workflow

Open the Actions tab, pick the workflow, and choose "Run workflow". `scrape` takes an optional page count (default 2). `youtube` takes a video URL and an optional label. `blacklist` and `unblacklist` each take an IP or a hostname, `reorder` takes an IP and a port, `tag` and `untag` each take a kind, a ref, and a label, and `feature` takes a kind, a slot, and a ref. Invalid input fails the run immediately.

### One-time setup

Before the first run:

1. **Enable Pages.** Settings → Pages → Source = GitHub Actions.
2. **Add the secrets.** Create a repo secret named `SHODANTOKEN`, and `YOUTUBE_API_KEY` too if you want the YouTube ingester.
3. **Seed the DB store.** Upload your local database from your machine. If you have no database yet, run `bun initdb` first to create a fresh, seeded `camhunting.sqlite`, then upload that.

```sh
bun initdb   # optional: creates a seeded, empty camhunting.sqlite
gh release create db-store --prerelease --title "SQLite store" --notes "camhunting.sqlite db. DO NOT DELETE!"
gh release upload db-store camhunting.sqlite
```

> [!WARNING]
> Skip step 3 and CI builds the database up from empty instead.

The `uses:` actions are pinned to commit SHAs. Refresh them with `actions-up`.
