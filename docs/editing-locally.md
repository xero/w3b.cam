# Editing locally

> [!NOTE]
> Curate the data on your own machine against a local copy of the database, preview it in a browser, and publish only once you are happy. The loop is three commands.

> ### Table of Contents
> - [The loop](#the-loop)
> - [bun dev](#bun-dev)
> - [Fast restarts with --index-only](#fast-restarts-with---index-only)
> - [Staying in sync while you edit](#staying-in-sync-while-you-edit)

---

## The loop

Curating the data (blacklisting a host, pinning its card image, or tagging it) once meant running a workflow from the Actions tab, which edits the published database in place. You can now do all of it locally.

```sh
bun sync --pull   # copy the published database down, overwriting your local one
bun dev           # serve it locally and edit by right-clicking
bun sync --push   # publish your edits and rebuild the live site
```

`sync --pull` and `sync --push` are covered in [Database](./database.md#sync). The middle step is `bun dev`.

---

## bun dev

**`bun dev`.** Bakes a dev build of the site, serves it at `http://localhost:1337`, and opens your browser. Override the port with `PORT=3000 bun dev`.

Right-click a cam card or screenshot to blacklist the host, pin that port as the card image, or attach a tag; right-click a stream or feed card, or its detail page, to tag it too. The Tag menu lists the entity's current tags as chips, each with an × to remove it, so you add and remove in one place. These are the same operations the [curation](./curation.md) commands run from the CLI.

Each action writes straight to the local database. Changes apply in the page immediately with no rebuild, because re-extracting thousands of screenshots from a database of a few hundred MB takes tens of seconds. Run `bun bake` when you want the static `out/` regenerated. Dev mode never runs in CI and never touches the published database.

---

## Fast restarts with --index-only

**`bun dev --index-only`.** Rebuilds only `index.html` and reuses the rest of `out/` from your last full bake, so startup drops from tens of seconds to about one. Every full bake writes an image manifest (`out/.img-manifest.json`) that lets this path pull the homepage's images off disk instead of re-extracting all of them.

The tradeoff is freshness. The galleries, detail pages, and the homepage's own "newest" cards reflect the last full bake, not any database changes since, so run a plain `bun dev` when you need those current. If the manifest is missing, it falls back to a full build once. Use it for fast restarts while iterating on homepage layout or featured picks.

---

## Staying in sync while you edit

The scheduled scraper adds cameras to the store every six hours, and a plain `sync --pull` would clobber your unpushed work just to pick them up. Reach for `sync --merge` instead.

**`bun sync --merge`.** Pulls the published database and folds its new cameras into your local copy in one step. It backs up your current database to a timestamped `camhunting.sqlite-<epoch>.bak`, downloads the store to a scratch file, merges the store's new rows into a copy of your local database, and swaps that copy in as the live one. Your database is never overwritten in place; it is only replaced once the merge succeeds, so an interrupted run leaves the original untouched. It runs unattended, with no prompt. The backup is kept; delete it once you are happy with the result.

For merging two databases you already have side by side, use the standalone `bun merge <source> <target>`. See [Database](./database.md#merge).
