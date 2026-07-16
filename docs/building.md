# Building the site

> [!NOTE]
> Turning the database into a static site with `bake`, and hosting it locally with `serve`. For the editing build, see [Editing locally](./editing-locally.md).

> ### Table of Contents
> - [bake](#bake)
> - [serve](#serve)
> - [The static site model](#the-static-site-model)

---

## bake

**`bun bake`.** Reads the database and writes a paginated static site to `out/`. It groups rows by IP into one entry per host, extracts each screenshot to a file under `out/img/`, and emits an index paginated 8 hosts to a page alongside a standalone page for every host. The `out/` directory is wiped and rebuilt on every run. Costs nothing and hits no API.

Every write to the database is a draft until you bake. The curation commands, imports, and scrapes all change rows; `bake` is what turns those rows into the pages the site serves.

---

## serve

**`bun serve`.** Serves `out/` over HTTP at `http://localhost:1337`. The site needs a server because its htmx navigation fetches page fragments, and browsers block those requests over `file://`. Override the port with `PORT=3000 bun serve`.

```sh
bun scrape --pages 5
bun bake
bun serve
```

Then open `http://localhost:1337`.

---

## The static site model

The build reads the database and writes clean folder URLs into `out/`: every page is a folder holding `index.html`, with a co-located `index.snippet.html` for htmx swaps. Bare landings like `/hosts` mirror page 1 (`/hosts/1`). See [Internals](./internals.md#project-layout) for the full `out/` tree.

**The site works without JavaScript.** Every index page and per-host page is a real file with plain links, so it stays browsable on its own. When JavaScript is on, htmx intercepts those links and swaps only the page body, which skips reloading the shell and shared assets. Each page is generated in two forms, the full document and a body-only snippet, from a single source string so the two cannot drift.

**The homepage is a curated mix.** `index.html` is a landing page, not page one of the index. It shows a cams row, a streams row, and a feeds row, each up to two featured cards followed by the newest of that kind. The full paginated galleries live at `/hosts`, `/streams`, and `/feeds`, reachable from the header nav alongside a combined `/gallery` of every kind. A super-feature event promotes a banner above everything and adds a combined `/event/<key>` page; see [Curation](./curation.md#superfeature).

**Feeds are included in the build.** RSS 2.0 (`rss.xml`) and Atom 1.0 (`atom.xml`) each carry the 50 newest discovered hosts with the screenshot as an enclosure, and the header links both. See [Internals](./internals.md) for the escaping, map, and syndication details.
