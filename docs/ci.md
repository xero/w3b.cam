# GitHub Actions

> [!NOTE]
> The workflows in `.github/workflows/` run the same commands in CI. The site builds and deploys on its own, the scraper runs on a schedule, and most curation happens from the Actions tab without a local checkout.

> ### Table of Contents
> - [Workflows](#workflows)
> - [The database store](#the-database-store)
> - [Running a workflow](#running-a-workflow)
> - [One-time setup](#one-time-setup)

---

## Workflows

**test.** Runs on every pull request and on pushes to `main` as the quality gate: `bun typecheck`, the unit and integration suite, then the Playwright run over the built site. It is fully offline (the tests seed a throwaway database and bake a fixture site), so it needs no secrets and no database restore. Add it to `main`'s branch protection as a required status check to block merges on a red run.

**build.** Bakes the database into `out/` and deploys it to GitHub Pages. It is reusable, so the other workflows call it after they change the data. Run it on its own to redeploy without scraping.

**scrape.** Runs every six hours (`0 */6 * * *`), or on demand with a page count (default 2). It restores the database, fetches new cameras, saves the database, then calls `build`. This is the only workflow that uses the `SHODANTOKEN` secret.

**youtube.** Adds or refreshes one stream on demand. Give it a YouTube URL and an optional label; it restores the database, fetches that video's metadata and thumbnail, saves the database, then calls `build`. This is the only workflow that uses the `YOUTUBE_API_KEY` secret, and it installs no extra binaries. The bulk list at `in/youtube.md` is not committed, so ingest many at once locally with `bun import --youtube` followed by `bun sync --push`.

**feeds.** Re-ingests the Osiris feed cams on demand, refreshing each cam's baked card thumbnail, then saves the database and calls `build`. It takes an optional dump path, a cam limit, and a source filter. The dump lives under `in/` and is gitignored, so CI can only ingest a copy committed to the checkout; the simpler path is to run `bun run osiris` locally and publish with `bun sync --push`. Either way the live detail feeds stay current on their own; only the gallery thumbnails go stale between refreshes.

**blacklist.** Takes an IP or a hostname, removes the matching cameras, saves the database, then calls `build` so the site drops them.

**unblacklist.** Takes an IP or a hostname and clears it from the blacklist. It does not rebuild, because no camera data changes until the next scrape re-adds the host.

**remove.** Takes a kind (cam, stream, or feed) and a target, deletes the matching entry without blacklisting it, saves the database, then calls `build` so the site drops it. A removed entry returns on the next re-ingest; use `blacklist` to keep a host out for good.

**reorder.** Takes an IP and a port, pins that port's screenshot as the host's gallery card, saves the database, then calls `build` so the new card appears on the site.

**tag.** Takes a kind (cam, stream, or feed), a ref (an IP, a video id, or a cam id), and a tag, attaches the label to that entity, saves the database, then calls `build` so the tag appears on the site.

**untag.** Takes the same kind, ref, and tag as `tag` and removes that label from the entity, saves the database, then calls `build` so the tag drops from the site.

**feature and unfeature.** `feature` takes a kind (cam or stream) and a ref (an IP for a cam, a video id for a stream) and adds it to the homepage featured set; `unfeature` takes the same pair and removes it. Each saves the database, then calls `build` so the homepage updates. The `feature` CLI also accepts `feed`, but the workflow's picker offers only cam and stream; feature a feed cam locally instead.

**geo.** Takes a video id, a latitude, and a longitude, assigns that stream's map coordinates on its `cams` row, saves the database, then calls `build` so the stream appears on the map.

---

## The database store

`camhunting.sqlite` is too large for git, so it lives as an asset on a prerelease named `db-store` instead of in the repo. Every workflow that changes the database restores it from that release first and uploads the new copy when it finishes; `build` reads it without saving. All the writing workflows share one concurrency group (`db-write`), so they can never run at the same time and clobber each other. `bun sync` moves that same asset to and from your machine; see [Database](./database.md#the-database-store).

---

## Running a workflow

Open the Actions tab, pick the workflow, and choose "Run workflow".

- **scrape** takes an optional page count (default 2).
- **youtube** takes a video URL and an optional label.
- **feeds** takes an optional dump path, cam limit, and source filter.
- **blacklist** and **unblacklist** each take an IP or a hostname.
- **remove** takes a kind and a target (an IP or hostname for a cam, the stored id for a stream or feed).
- **reorder** takes an IP and a port.
- **tag** and **untag** each take a kind, a ref, and a label.
- **feature** and **unfeature** each take a kind and a ref.
- **geo** takes a video id, a latitude, and a longitude.

Invalid input fails the run immediately.

---

## One-time setup

Before the first run:

- **Enable Pages.** Settings, then Pages, then Source = GitHub Actions.
- **Add the secrets.** Create a repo secret named `SHODANTOKEN`, and `YOUTUBE_API_KEY` too if you want the YouTube ingester.
- **Seed the DB store.** Upload your local database from your machine. If you have no database yet, run `bun initdb` first to create a fresh, seeded `camhunting.sqlite`, then upload that.

```sh
bun initdb   # optional: creates a seeded, empty camhunting.sqlite
gh release create db-store --prerelease --title "SQLite store" --notes "camhunting.sqlite db. DO NOT DELETE!"
gh release upload db-store camhunting.sqlite
```

> [!WARNING]
> Skip the DB store step and CI builds the database up from empty instead.

The `uses:` actions are pinned to commit SHAs. Refresh them with `actions-up`.
