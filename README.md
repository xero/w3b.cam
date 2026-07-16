# w3b.cam

[![MIT Licensed](https://img.shields.io/github/license/xero/w3b.cam?logo=wikiversity&logoColor=979da4&labelColor=262a2e&color=b1a268)](https://github.com/xero/w3b.cam/blob/main/LICENSE.txt)
[![Latest Test Suite](https://github.com/xero/w3b.cam/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/xero/w3b.cam/actions/workflows/test.yml)
[![Latest Deployment](https://img.shields.io/github/deployments/xero/w3b.cam/github-pages?logo=githubactions&logoColor=979da4&label=Pages%20Deployment&labelColor=262a2e)](https://github.com/xero/w3b.cam/actions/workflows/build.yml)
[![Latest Wiki Build](https://img.shields.io/badge/success-success?logo=gitbook&logoColor=979da4&labelColor=262a2e&label=Wiki%20Deployment)](https://github.com/xero/w3b.cam/wiki)
[![Powered by Bun](https://img.shields.io/badge/Bun-Bun?labelColor=262a2e&logo=bun&logoColor=f9f1e1&label=Powered%20by&color=e47ab4&link=https%3A%2F%2Fbun.js)](https://bun.com)

[![Preview](https://raw.githubusercontent.com/wiki/xero/w3b.cam/preview.png)](https://w3b.cam)

> Database and static website gallery generator of open webcams, with tool suites for fingerprinting, scraping, and manual cam hunting.

## Quick start

You need Bun 1.3 or newer and a Shodan API key. Full prerequisites are in [Setup](./docs/setup.md).

```sh
export SHODANTOKEN=your_api_key_here
bun install
bun scrape --pages 5   # fetch fresh cameras from Shodan
bun bake               # build the static site into ./out
bun serve              # view it at http://localhost:1337
```

Want the published public database? Pull it and edit locally instead:

```sh
bun sync --pull        # download the live database
bun dev                # serve it with right-click editing
bun sync --push        # publish your edits and redeploy
```

---

## Documentation

**[Setup](./docs/setup.md).** Requirements, install, and getting a database to work against.

**[Scraping](./docs/scraping.md).** `scrape` and `preflight`, the Shodan pipeline, and query credits.

**[Importing data](./docs/importing.md).** `import` for Shodan JSON, YouTube, MJPEG, and HLS, the `osiris` re-ingest, and the rate-limit controls.

**[Curation](./docs/curation.md).** Blacklist, remove, pin a card image, tag, feature, geolocate, and purge.

**[Fingerprinting](./docs/fingerprinting.md).** Deriving each camera's make and model from its banner.

**[Database](./docs/database.md).** `initdb`, the `db-store` model, and moving the database with `sync` and `merge`.

**[Editing locally](./docs/editing-locally.md).** The pull, edit, publish loop with `bun dev`.

**[Building the site](./docs/building.md).** `bake` and `serve`, and how the static site is generated.

**[Testing](./docs/testing.md).** The unit, integration, and Playwright suite.

**[GitHub Actions](./docs/ci.md).** The CI workflows that scrape, curate, and deploy.

**[Internals](./docs/internals.md).** The data model, cross-cutting site features, and the project layout.

---

## Command reference

| Command | What it does | Guide |
| - | - | - |
| `bun initdb` | Create and seed an empty database | [Database](./docs/database.md#initdb) |
| `bun scrape` | Fetch cameras from the Shodan API | [Scraping](./docs/scraping.md#scrape) |
| `bun preflight` | CI credit precheck; spends nothing | [Scraping](./docs/scraping.md#preflight) |
| `bun import` | Ingest a non-scraped source (`--shodan` / `--youtube` / `--mjpeg` / `--hls`) | [Importing](./docs/importing.md) |
| `bun run osiris` | Re-ingest the Osiris feed dump | [Importing](./docs/importing.md#osiris) |
| `bun blacklist` / `bun unblacklist` | Drop a host for good, or reverse it | [Curation](./docs/curation.md#blacklist) |
| `bun remove` | Delete an entry without blacklisting it | [Curation](./docs/curation.md#remove) |
| `bun reorder` | Pin a host's card image to one port | [Curation](./docs/curation.md#reorder) |
| `bun tag` / `bun untag` | Attach or remove a tag | [Curation](./docs/curation.md#tag) |
| `bun feature` / `bun unfeature` | Add or remove a homepage featured pin | [Curation](./docs/curation.md#feature) |
| `bun superfeature` | Group feeds into a one-off event banner | [Curation](./docs/curation.md#superfeature) |
| `bun geo` | Set a YouTube stream's map coordinates | [Curation](./docs/curation.md#geo) |
| `bun purge` | Drop stored RDP/VNC rows | [Curation](./docs/curation.md#purge) |
| `bun fingerprint` | Backfill camera make and model labels | [Fingerprinting](./docs/fingerprinting.md) |
| `bun sync` | Pull, push, or merge with the `db-store` release | [Database](./docs/database.md#sync) |
| `bun merge` | Merge new cams from one database into another | [Database](./docs/database.md#merge) |
| `bun bake` | Build the static site into `out/` | [Building](./docs/building.md#bake) |
| `bun serve` | Host `out/` locally | [Building](./docs/building.md#serve) |
| `bun dev` | Serve with right-click editing | [Editing locally](./docs/editing-locally.md#bun-dev) |
| `bun test` / `bun test:e2e` | Run the test suite | [Testing](./docs/testing.md) |
| `bun typecheck` | Type-check with `tsc --noEmit` | [Testing](./docs/testing.md) |

---

## Icon attribution

[cctv icons](https://thenounproject.com/browse/collection-icon/cctv-glyph-172739/) by [heyrabbit](https://thenounproject.com/creator/heyrabbit/)

## License

All files and scripts in this repo are released [MIT](https://github.com/xero/w3b.cam/blob/main/LICENSE) / [kopimi](https://kopimi.com)! In the spirit of _freedom of information_, I encourage you to fork, modify, change, share, or do whatever you like with this project! `^c^v`
