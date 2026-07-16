# Setup

> [!NOTE]
> What you need to run w3b.cam, how to install it, and how to get a database to work against.

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

## Install

```sh
bun install
```

That installs `shodan-ts` (the API client) and Bun's type definitions. SQLite is built into Bun, so there is nothing else to add.

Run `bun typecheck` at any point to type-check the sources with `tsc --noEmit`.

---

## Getting the database

The database is not in the repo. `camhunting.sqlite` runs to a few hundred MB and only grows, so it lives as an asset on a public prerelease named `db-store` rather than in git. You have two ways to get one: pull the published copy the live site builds from, or start fresh with an empty one. See [Database](./database.md) for the full store model.

### Pull the published database

This is the exact database the site serves, ready to browse and edit.

```sh
bun sync --pull
```

It downloads `camhunting.sqlite` from the `db-store` release, overwrites your local copy, and removes the stale `-wal` and `-shm` sidecars so SQLite reads the fresh file cleanly. The repo is public, so any GitHub account works and you do not need to be a collaborator. Sync drives the `gh` CLI, so install and authenticate it first with `gh auth login`. See [Editing locally](./editing-locally.md) for the full edit loop.

### Download it without `gh`

The release is public, so you can fetch the asset straight over HTTPS with no CLI and no login. Delete the sidecars yourself afterward, since a plain download skips that step.

```sh
curl -L -o camhunting.sqlite \
  https://github.com/xero/w3b.cam/releases/download/db-store/camhunting.sqlite
rm -f camhunting.sqlite-wal camhunting.sqlite-shm
```

### Start fresh instead

To build your own database from an empty, seeded one rather than the published data, run `bun initdb` and populate it with `bun scrape` or `bun import`. See [Database](./database.md#initdb) for what the seed includes.
