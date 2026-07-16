# Importing data

> [!NOTE]
> `import` is one command that ingests every non-scraped source behind a type flag. This covers each type, the one-off `osiris` re-ingest, and the rate-limit controls the feed grabbers share.

> ### Table of Contents
> - [How import works](#how-import-works)
> - [Shodan](#shodan)
> - [YouTube](#youtube)
> - [MJPEG](#mjpeg)
> - [HLS](#hls)
> - [Osiris](#osiris)
> - [Rate limits and cool-off](#rate-limits-and-cool-off)

---

## How import works

`bun import` is one command that ingests non-scraped sources behind a type flag. Each type reads its own input and writes to the same `cams` table, so the gallery blends them. Re-running any import is safe. It refreshes existing rows rather than duplicating them, and a failed thumbnail grab never overwrites a good card with a blank. Pick exactly one type per run.

```
bun import --shodan  [dir]                                    raw Shodan JSON  -> kind='cam'
bun import --youtube [--url <url> [--label "Title"] | file]   YouTube streams  -> kind='stream'
bun import --mjpeg   [file]                                   curated MJPEG    -> kind='feed'
bun import --hls     [file] [--source Name]                   curated .m3u8    -> kind='feed'
```

The Osiris re-ingest is a separate command, `bun run osiris`, because its dump is large and rarely re-run.

---

## Shodan

**`bun import --shodan [dir]`.** Loads raw Shodan JSON files from a directory, defaulting to `./in`. It reads every `.json` file it finds, uses no API and no credits, and skips files it cannot parse with a warning. It stores only cameras that carry a screenshot, and accepts host lookups, search results, and single banners. These land as `kind='cam'`, the same shape `bun scrape` produces.

Shodan is the odd one out among the import types. Its screenshots are embedded in the JSON, so it grabs nothing over the network and takes none of the snapshot flags below.

---

## YouTube

**`bun import --youtube [--limit N]`.** Reads the local list at `in/youtube.md`, one `title <url>` per line, mixing `watch?v=`, `youtu.be/`, and `youtube.com/live/` forms. Both `in/` and `out/` are gitignored, so this list stays on your machine. It fetches each video's metadata and thumbnail from the YouTube Data API and upserts them into the unified `cams` table as `kind='stream'`, keyed on the video id. Re-running refreshes existing streams and picks up updated live thumbnails rather than duplicating them. `--limit N` processes only the first N unique entries for a quick test. Needs `YOUTUBE_API_KEY`.

**`bun import --youtube --url <url> [--label "Title"]`.** Adds or refreshes a single stream by URL without touching the file. This is how the `youtube` CI workflow ingests one stream at a time, since the bulk list is not committed. `--label` sets the display title; omit it to fall back to the video's own title.

Streams get their own gallery at `/streams`, reachable from the header nav. `bake` renders every stream as its own card, and each stream's detail page links the other streams from the same channel.

```sh
export YOUTUBE_API_KEY=your_api_key_here
bun import --youtube
bun bake
bun serve
```

---

## MJPEG

**`bun import --mjpeg [file] [--limit N] [--concurrency N] [--delay MS] [--skip-existing]`.** Reads a curated list of MJPEG camera URLs, one per line, defaulting to `in/mjpeg.md`. Blank lines and `#` comments are skipped, and an optional `label ` before the URL is kept. Like `in/youtube.md`, the list is gitignored and stays on your machine, so append to it and re-run as you hunt more cams. Each URL is classified by vendor from the endpoint fingerprints in [the cam-hunting guide](https://w3b.cam/tips), a still is baked with ffmpeg for the gallery card, and the cam is upserted into the unified `cams` table as `kind='feed'`. Re-running refreshes thumbnails rather than duplicating cams.

`--limit N` ingests only the first N unique cams. The snapshot flags `--concurrency`, `--delay`, and `--skip-existing` are shared with the other feed grabbers and covered in [Rate limits and cool-off](#rate-limits-and-cool-off).

The site is served over https, so how a cam plays depends on its feed. An https stream embeds live as a smooth Motion JPEG `<img>`; an https snapshot auto-refreshes; an http feed cannot embed, since browsers block mixed content, so it shows the baked still with a "View live" link that opens the feed in a new tab. Viewer-page URLs, such as Mobotix `guestimage.html`, Panasonic `CgiStart`, and Axis `#view`, are resolved to their real stream or snapshot endpoint so they still get a thumbnail. The cams join the feeds gallery at `/feeds`, labeled by vendor.

```sh
bun import --mjpeg
bun bake
bun serve
```

---

## HLS

**`bun import --hls [file] [--source Name] [--limit N] [--concurrency N] [--delay MS] [--cooldown SEC] [--skip-existing] [--abort-after N]`.** Reads a curated list of `.m3u8` playlist URLs, one per line, defaulting to `in/streams.md`, with the same `label <url>` format and `#` comments as the MJPEG list. Any HLS playlist works; nothing is tied to one provider. ffmpeg grabs a single poster frame for the card, and the cam is upserted as `kind='feed'` with `feed_kind='hls'`. The detail page embeds it as a `<video>` played through the vendored hls.js. `--source Name` tags provenance and defaults to `HLS`. The cams join the feeds gallery at `/feeds`.

HLS origins often cap how many streams one IP may pull before a temporary block, so the snapshot flags matter most here. See [Rate limits and cool-off](#rate-limits-and-cool-off).

```sh
bun import --hls in/streams.md --source 511PA
bun bake
bun serve
```

---

## Osiris

**`bun run osiris [file] [--limit N] [--source X] [--id a,b] [--concurrency N] [--delay MS] [--skip-existing]`.** Re-ingests the Osiris camera dump, defaulting to `in/new/osiris-cameras.json`, refreshing each cam's baked thumbnail and routing any YouTube cams to the streams table. It lives outside `bun import` on purpose, since the dump is large and this is a rare, hand-run maintenance command that CI invokes when the dump is committed. `--source X` limits to cams whose source contains `X`, and `--id a,b` limits to exact cam ids for a re-scrape or hand-patch.

---

## Rate limits and cool-off

The three feed grabbers, `--mjpeg`, `--hls`, and `bun run osiris`, share a set of snapshot flags because they all pull thumbnails over the network with ffmpeg. Each grab opens a real connection to the stream origin, so a large run against a single host can trip that host's per-IP limits.

**`--concurrency N`.** Parallel snapshot grabs. Defaults to 24 for MJPEG and Osiris, which fan out across many hosts, and 4 for HLS, whose streams usually share one origin.

**`--delay MS`.** Paces grab starts so the aggregate request rate stays under a per-IP window. Off by default. Raise it when a run targets a single capped origin.

**`--skip-existing`.** Skips cams that already have a thumbnail, so a re-run spends its budget only on the gaps. Cams that failed last time, showing a blank placeholder card, are retried rather than skipped.

Two more flags are HLS-only, since a global block detector fits a single-origin stream list but not a mixed dump:

**`--cooldown SEC`.** On a run of consecutive timeouts, sleep `SEC` and resume instead of aborting. Progress already grabbed is saved before the sleep, so an interrupted cool-off loses nothing.

**`--abort-after N`.** Consecutive timeouts that trip the rate-limit circuit breaker, defaulting to 5. Dead feeds fail fast as errors and never count toward it; only true hangs do.

Every feed grabber saves progress incrementally and upserts idempotently. An interrupted run keeps what it grabbed, a re-run fills the gaps, and a failed grab never blanks a card that already has a good image. So the pattern for a capped origin is to run, let it stop when the origin blocks you, switch IP, and run again with `--skip-existing`, which advances past everything already stored.

The Pittsburgh 511PA feeds are HLS behind exactly this kind of cap. Profiling the per-IP limit put the sweet spot at concurrency 2 with a 700 ms pace:

```sh
bun import --hls in/streams.md --source 511PA --concurrency 2 --delay 700 --skip-existing
```

Each fresh IP grabs roughly 30-40 streams before the block, so switch VPN endpoints between runs. For a large set like the statewide list, go hands-off and let one IP grind through the roughly hour-long blocks on its own:

```sh
bun import --hls in/streams-pa.md --source 511PA --concurrency 2 --delay 700 --cooldown 3600 --skip-existing
```
