# Tests

> [!NOTE]
> A layered suite over the w3b.cam generator: `bun test` for units and integration, Playwright for the built site. Everything runs offline against a throwaway database seeded with a few entries per kind, so your real `camhunting.sqlite` and `out/` are never touched.

> ### Table of Contents
> - [Run](#run)
> - [Layout](#layout)
> - [How the fixture works](#how-the-fixture-works)
> - [Coverage of network-bound scripts](#coverage-of-network-bound-scripts)

---

## Run

```sh
bun run test              # unit + integration, then a coverage-gaps banner
bun run test:unit         # pure modules only
bun run test:integration  # DB, every CLI, bake, serve
bun run test:e2e          # Playwright (needs the browser, see below)
```

First e2e run only:

```sh
bunx playwright install chromium
```

Optional live check (spends no credits), when a real Shodan token is present:

```sh
TEST_LIVE=1 SHODANTOKEN=... bun run test
```

For the day-to-day workflow and the isolation flags, see [docs/testing.md](../docs/testing.md).

---

## Layout

**`unit/`.** Pure functions. `urls.ts` slugs (traversal safety, IPv6 folding) and `util.ts` (HTML escaping, the Shodan row builder, the RDP/VNC filter).

**`integration/`.** Each `package.json` script run as a subprocess against a temp DB, plus the DB layer, `bake` output, and `serve`.

**`e2e/`.** Playwright drives the served site: shell and nav, htmx swap and Back, no-JS parity, a broken-link crawl, and the pager.

**`helpers/`.** Temp dirs, the subprocess runner, capability probes, the fixture builder, and the run-end banner.

**`fixtures/`.** A small Shodan JSON (embedded base64 screenshots) and hand-built feed and stream rows.

---

## How the fixture works

`DB_PATH` and `OUT_DIR` are env-overridable, so each test targets a fresh temp DB and bakes into a temp dir. Cams go in through the real `import --shodan` path, offline with no network. Feeds and streams need network, ffmpeg, and a YouTube key to ingest for real, so they are upserted straight through the exported inserters instead.

---

## Coverage of network-bound scripts

`scrape`, `preflight`, `sync`, `osiris`, and `import --youtube/--mjpeg/--hls` need credentials, ffmpeg, or live services, so they are covered only at the argument and error level. The run ends with a banner listing any missing capability (`SHODANTOKEN`, `YOUTUBE_API_KEY`, `ffmpeg`, network) so you know what was not exercised end to end. It never fails the run.
