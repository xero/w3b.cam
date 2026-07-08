# Shodan Webcam Visualizer

> [!NOTE]
> A handful of Bun scripts around a local SQLite database. One scrapes webcam screenshots from the Shodan REST API into the database; another bakes a paginated static site from it, and the rest import, curate, and publish the data.

---

> ### Table of Contents
> - [Requirements](#requirements)
> - [Setup](#setup)
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

---

## Setup

```sh
bun install
```

That installs `shodan-ts` (the API client) and Bun's type definitions. SQLite is built into Bun, so there is nothing else to add.

Run `bun typecheck` at any point to type-check the sources with `tsc --noEmit`.

---

## Usage

The core pipeline is four commands. Cameras come from two sources: the Shodan API (`scrape`) or raw JSON files you already have (`import`). Both write to the same database, `bake` turns it into a static site, and `serve` hosts that site locally.

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

---

## Editing locally

Curating the data (blacklisting a host, pinning its card image, or tagging it) once meant running a workflow from the Actions tab, which edits the published database in place. You can now do all of it on your own machine against a local copy, preview the result in a browser, and publish only once you are happy with it. The loop is three commands.

```sh
bun sync --pull   # copy the published database down, overwriting your local one
bun dev           # serve it locally and edit by right-clicking
bun sync --push   # publish your edits and rebuild the live site
```

**`bun sync --pull`.** Downloads `camhunting.sqlite` from the `db-store` release and overwrites your local copy, so you start from exactly what the site is serving. It removes the stale `-wal` and `-shm` sidecars afterward so SQLite reads the fresh file cleanly.

**`bun dev`.** Bakes a dev build of the site, serves it at `http://localhost:1337`, and opens your browser. Right-click any card or screenshot to blacklist the host, pin that port as the card image, or attach a tag; each action writes straight to the local database. Changes apply in the page immediately with no rebuild, because re-extracting thousands of screenshots from a database of a few hundred MB takes tens of seconds. Run `bun bake` when you want the static `out/` regenerated. It never runs in CI and never touches the published database.

**`bun sync --push`.** Uploads your local database over the `db-store` asset and triggers the `build` workflow, so the live site rebuilds from your edits. It creates the `db-store` release on the first push if none exists yet.

Both directions overwrite a whole database, so each one prints a size and timestamp comparison of the two copies and asks you to confirm. It warns you when the copy you are about to overwrite is newer than the one replacing it, since the scheduled scraper refreshes the published database every six hours and a stale local push could clobber newer data. Pass `--yes` to skip the prompt. Sync drives the `gh` CLI, so you need it installed and authenticated.

> [!WARNING]
> `--pull` clobbers your local database and `--push` clobbers the published one and redeploys the site. Mind the direction, and back up the local file first if it holds edits you have not pushed.

---

## How it works

The scraper pages through search results and stores one row per camera service, keyed on the IP and port. Because that pair is the primary key, a second run inserts only cameras it has not seen before. Each row keeps the location, network owner, the screenshot as base64, and the full raw match as JSON for later use.

A few details worth knowing:

- **Screenshots need `minify: false`.** Shodan truncates large fields by default, which drops the screenshot. The client always requests full records.
- **Requests are paced to roughly one per second.** `shodan-ts` does no throttling and does not retry rate-limit errors, so the scraper spaces its calls and backs off on `429` and `5xx` responses.
- **RDP and VNC screens are filtered.** Some hosts serve a remote-desktop or VNC login that Shodan labels as a webcam. The scraper and importer skip any product of `remote desktop protocol` or `vnc` as they ingest. That guard only blocks new rows, so `bun purge` retroactively drops any that predate it. Re-run `bun bake` afterward.
- **Removed hosts stay removed.** `bun blacklist <ip-or-hostname>` deletes every matching row and records the entry in a blacklist table; the scraper and importer skip anything listed, so a host you drop never comes back on a later run. An IP matches exactly (every port); a hostname or domain matches itself and any subdomain, so `bun blacklist cloudzy.com` also drops `cam.node.cloudzy.com`. IPs live in a `blacklist` table, hostnames in a `host_blacklist` table. Reverse either with `bun unblacklist <ip-or-hostname>`, then re-run `bun scrape` to fetch the host again. A fresh database starts with a built-in list of blacklisted hostnames; IPs start empty.
- **You pick a host's card image.** A host seen on several ports has several screenshots, and its gallery card shows the most recent one by default. `bun reorder <ip> <port>` pins one port so its screenshot leads instead, and `bun reorder <ip> --clear` reverts to the default. The pin lives in a `preferred` column that the scraper and importer never overwrite, so it survives later runs. Re-run `bun bake` to rebuild the site.
- **You can tag a host.** `bun tag <ip> <tag>` attaches a free-form label to an IP, stored in an `ip_tags` table and shown on the host's page. Tags are normalized to lowercase and deduplicated, and a host can carry several. Re-run `bun bake` to rebuild the site.
- **The visualizer escapes everything.** Banner text such as the organization name and hostnames comes from scanned hosts and is untrusted, so every value is HTML-escaped before it reaches the page. IP-derived filenames are slugified against a hex allowlist, so a hostile value cannot escape the output directory.
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
  db.ts           schema, open/close, and inserts
  scraper.ts      fetch cameras from the Shodan API, dedupe, store
  import.ts       load cameras from raw Shodan JSON files, no API
  blacklist.ts    drop a host and record it so scrapes skip it
  unblacklist.ts  reverse a blacklist entry
  reorder.ts      pin a host's card image to one port
  tag.ts          attach a free-form label to a host
  purge.ts        remove stored RDP/VNC rows that predate the ingest filter
  render.ts       pure HTML rendering (grouping, pager, pages, shell)
  build.ts        database to static site (orchestrator)
  serve.ts        static file server for out/
  dev.ts          local dev server with right-click blacklist/reorder/tag
  dev-client/     browser editing UI (js and css), served from source
  sync.ts         pull/push the database to and from the db-store release
camhunting.sqlite  generated database (gitignored)
out/               generated site (gitignored)
  index.html   page 1 of the paginated index
  page002.html full index pages 2..N
  <ip>.html    one page per host (dots become hyphens)
  img/         extracted screenshots
  snips/       body-only snippets for htmx swaps
  htmx.min.js  vendored htmx library
```

---

## GitHub Actions

Six workflows in `.github/workflows/` run the same commands in CI. The site builds and deploys to GitHub Pages on its own, the scraper runs on a schedule, and blacklist, reorder, and tag edits happen from the Actions tab without a local checkout.

**`build`.** Bakes the database into `out/` and deploys it to GitHub Pages. It is reusable, so the other workflows call it after they change the data. Run it on its own to redeploy without scraping.

**`scrape`.** Runs every six hours (`0 */6 * * *`), or on demand with a page count. It restores the database, fetches new cameras, saves the database, then calls `build`. This is the only workflow that uses the `SHODANTOKEN` secret.

**`blacklist`.** Takes an IP or a hostname, removes the matching cameras, saves the database, then calls `build` so the site drops them.

**`unblacklist`.** Takes an IP or a hostname and clears it from the blacklist. It does not rebuild, because no camera data changes until the next scrape re-adds the host.

**`reorder`.** Takes an IP and a port, pins that port's screenshot as the host's gallery card, saves the database, then calls `build` so the new card appears on the site.

**`tag`.** Takes an IP and a tag, attaches the label to the host, saves the database, then calls `build` so the tag appears on the site.

### The database store

`camhunting.sqlite` is too large for git (a few hundred MB, and it only grows), so it lives as an asset on a prerelease named `db-store` instead of in the repo. Every workflow that changes the database restores it from that release first and uploads the new copy when it finishes. `build` reads it without saving. All three writing workflows share one concurrency group, so a scheduled scrape and a manual blacklist can never run at the same time and clobber each other. `bun sync` moves that same asset to and from your machine, which is how edits you make locally reach the site; see [Editing locally](#editing-locally).

### Running a workflow

Open the Actions tab, pick the workflow, and choose "Run workflow". `scrape` takes an optional page count (default 2). `blacklist` and `unblacklist` each take an IP or a hostname, `reorder` takes an IP and a port, and `tag` takes an IP and a label. Invalid input fails the run immediately.

### One-time setup

Before the first run:

1. **Enable Pages.** Settings → Pages → Source = GitHub Actions.
2. **Add the secret.** Create a repo secret named `SHODANTOKEN`.
3. **Seed the DB store.** Upload your local database from your machine. If you have no database yet, run `bun initdb` first to create a fresh, seeded `camhunting.sqlite`, then upload that.

```sh
bun initdb   # optional: creates a seeded, empty camhunting.sqlite
gh release create db-store --prerelease --title "SQLite store" --notes "camhunting.sqlite db. DO NOT DELETE!"
gh release upload db-store camhunting.sqlite
```

> [!WARNING]
> Skip step 3 and CI builds the database up from empty instead.

The `uses:` actions are pinned to commit SHAs. Refresh them with `actions-up`.
