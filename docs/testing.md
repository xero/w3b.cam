# Testing

> [!NOTE]
> A layered suite over the generator: `bun test` for units and integration, Playwright for the built site. Everything runs offline against a throwaway database, so your real `camhunting.sqlite` and `out/` are never touched. See [tests/README.md](../tests/README.md) for the layout.

---

## Run

```sh
bun run test       # unit + integration, then a coverage-gaps banner
bun run test:e2e   # Playwright over the built site
```

First e2e run only:

```sh
bunx playwright install chromium
```

`bun typecheck` stays the fast pre-commit gate.

---

## What each run covers

`bun run test` covers the pure modules, the database layer, and every `package.json` script (each run as a subprocess against a temp database), plus `bake` and `serve`. The network-bound scripts (`scrape`, `preflight`, `sync`, `osiris`, and the non-Shodan imports) are covered at the argument and error level only, since running them for real needs credentials, ffmpeg, or live services.

The run ends with a banner naming any missing capability (`SHODANTOKEN`, `YOUTUBE_API_KEY`, `ffmpeg`, network) so you know what was not exercised end to end. It never fails the run for that.

`bun run test:e2e` bakes the fixture site and drives it in a browser: navigation, the htmx swaps, the no-JS fallback, a broken-link crawl, and the pager.

---

## Isolate the targets

The suite self-isolates to temp dirs, but set throwaway targets too so a stray default can never touch the real database or `out/`:

```sh
DB_PATH="$(mktemp -d)/db.sqlite" OUT_DIR="$(mktemp -d)/out" bun run test
```

When running a single test file directly, pass its absolute path, not a relative one. A relative path can break subprocess spawning inside the test, so a script under test looks like it produced no output when it actually ran.

```sh
bun test "$PWD/tests/integration/foo.test.ts"
```
