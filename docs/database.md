# Database

> [!NOTE]
> Creating a database, and moving it between your machine and the published store with `sync` and `merge`. For the day-to-day edit loop, see [Editing locally](./editing-locally.md).

> ### Table of Contents
> - [initdb](#initdb)
> - [The database store](#the-database-store)
> - [sync](#sync)
> - [merge](#merge)

---

## initdb

**`bun initdb`.** Creates and seeds an empty `camhunting.sqlite`. Use it to start your own database from scratch rather than pulling the published one, then populate it with `bun scrape` or `bun import`.

The seed is small and hand-curated. A fresh database ships with a built-in host blacklist, a handful of seeded tags (`graffiti`, `games`, `backrooms`), and a few featured pins for the homepage. Each seed applies only when its table is empty, so an entry you later remove by hand never comes back.

---

## The database store

`camhunting.sqlite` is too large for git (a few hundred MB, and it only grows), so it lives as an asset on a prerelease named `db-store` instead of in the repo. Every workflow that changes the database restores it from that release first and uploads the new copy when it finishes; `build` reads it without saving.

All the writing workflows share one concurrency group (`db-write`), so a scheduled scrape, the YouTube ingester, and a manual blacklist can never run at the same time and clobber each other. `bun sync` moves that same asset to and from your machine, which is how edits you make locally reach the site.

---

## sync

`bun sync` moves the database between your local copy and the `db-store` release, git-style. It drives the `gh` CLI, so you need it installed and authenticated with `gh auth login`.

**`bun sync --pull`.** Downloads `camhunting.sqlite` from the `db-store` release and overwrites your local copy, so you start from exactly what the site is serving. It removes the stale `-wal` and `-shm` sidecars afterward so SQLite reads the fresh file cleanly.

**`bun sync --push`.** Uploads your local database over the `db-store` asset and triggers the `build` workflow, so the live site rebuilds from your edits. It creates the `db-store` release on the first push if none exists yet.

**`bun sync --merge`.** Pulls the published database and folds its new cameras into your local copy in one step, for when your local copy holds edits you have not pushed. See [Editing locally](./editing-locally.md#staying-in-sync-while-you-edit) for when to reach for it.

Both `--pull` and `--push` overwrite a whole database, so each prints a size and timestamp comparison of the two copies and asks you to confirm. It warns you when the copy you are about to overwrite is newer than the one replacing it, since the scheduled scraper refreshes the published database every six hours and a stale local push could clobber newer data. Pass `--yes` (or `-y` / `-f`) to skip the prompt.

> [!WARNING]
> `--pull` clobbers your local database and `--push` clobbers the published one and redeploys the site. Mind the direction. If your local copy holds edits you have not pushed, reach for `--merge` instead of `--pull` to pick up the store's new cameras without losing them.

> [!NOTE]
> To download the db without the `gh` command, fetch the asset straight over HTTPS with no login.

```bash
curl -L -o camhunting.sqlite \
  https://github.com/xero/w3b.cam/releases/download/db-store/camhunting.sqlite
# clean up
rm -f camhunting.sqlite-wal camhunting.sqlite-shm
```

---

## merge

**`bun merge <source> <target>`.** The merge that `sync --merge` runs, exposed on its own for when you already have two databases side by side. It folds the new cameras from the source into the target instead of overwriting either.

```sh
bun merge camhunting.sqlite.prod camhunting.sqlite
```

It diffs the source and target `cams` tables (the `kind='cam'` rows) by their `(ip_str, port)` and inserts only the cameras the target is missing, copied verbatim, including each camera's original `first_seen` and any pin. Rows the target already has are left untouched, so your own pins, tags, and curation survive. Only the target is written; the source is opened read-only. Pass `--dry-run` to preview the delta and write nothing, or `--yes` to skip the confirmation prompt.

