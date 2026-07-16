# Curation

> [!NOTE]
> The database-editing commands: blacklist, remove, pin a card image, tag, feature, geolocate, and purge. Each writes straight to `camhunting.sqlite`; re-run `bun bake` afterward to rebuild the site. The same edits are available by right-click in [`bun dev`](./editing-locally.md).

> ### Table of Contents
> - [blacklist](#blacklist)
> - [unblacklist](#unblacklist)
> - [remove](#remove)
> - [reorder](#reorder)
> - [tag](#tag)
> - [untag](#untag)
> - [feature](#feature)
> - [unfeature](#unfeature)
> - [superfeature](#superfeature)
> - [geo](#geo)
> - [purge](#purge)

---

## blacklist

**`bun blacklist <ip-or-hostname>`.** Deletes every matching row and records the entry in a blacklist table so the scraper and importer skip it, meaning a host you drop never comes back on a later run. An IP matches exactly, every port; a hostname or domain matches itself and any subdomain, so `bun blacklist cloudzy.com` also drops `cam.node.cloudzy.com`. IPs live in a `blacklist` table, hostnames in a `host_blacklist` table.

A fresh database starts with a built-in list of blacklisted hostnames; IPs start empty.

---

## unblacklist

**`bun unblacklist <ip-or-hostname>`.** Reverses a blacklist entry. Clear the host, then re-run `bun scrape` to fetch it again. It does not rebuild on its own, because no camera data changes until the next scrape re-adds the host.

---

## remove

**`bun remove [--kind cam|stream|feed] <ref>`.** Deletes a stored entry without blacklisting it. Unlike `blacklist`, nothing is recorded to keep it out, so a removed entry returns the next time its source is re-ingested by `scrape`, `import`, or `osiris`. Removing also clears the entry's tags and featured pins.

- **cam (default).** `<ref>` is an IP (matched exactly, every port) or a hostname/domain (matches itself and any subdomain, like `blacklist`).
- **stream or feed.** `<ref>` is the stored id (video id or feed id).

Reach for `blacklist` instead when you want a host gone for good.

---

## reorder

**`bun reorder <ip> <port>`.** Pins one port so its screenshot leads the host's gallery card. A host seen on several ports has several screenshots, and its card shows the most recent one by default; this overrides that. **`bun reorder <ip> --clear`** reverts to the default. The pin lives in a `preferred` column that the scraper and importer never overwrite, so it survives later runs.

---

## tag

**`bun tag <cam|stream|feed> <ref> <tag>`.** Attaches a free-form label to a cam (by IP), a stream (by video id), or a feed cam (by id), stored in the `meta` table (`type='tag'`) keyed on `(kind, ref, type, value)`. The same tag spans every source, so tagging `street` on a webcam, a stream, and a feed cam groups all three under it. Tags are normalized to lowercase and deduplicated, and an entity can carry several.

Tags show on each detail page, size a tag cloud at `/tags` in the header nav, and each links to a paginated browse page at `/tags/<slug>` mixing every entity that carries it.

---

## untag

**`bun untag <cam|stream|feed> <ref> <tag>`.** Removes one tag from a cam, stream, or feed cam. You can also remove a tag in `bun dev` by clicking the × on its chip in the right-click Tag menu.

---

## feature

**`bun feature <cam|stream|feed> <ref>`.** Adds an entry to the homepage featured set, stored in the `meta` table (`type='featured'`) keyed on `(kind, ref)`: an IP for a cam, a video id for a stream, a feed id for a feed cam. The set is unbounded, and each build randomly picks two per kind to show, so the homepage rotates on its own. A featured entry whose row is gone is skipped and backfilled from the newest, so each row always fills.

---

## unfeature

**`bun unfeature <cam|stream|feed> <ref>`.** Removes an entry from the featured set. You can also unfeature in `bun dev` by right-clicking a card and choosing Unfeature.

---

## superfeature

**`bun superfeature <event-key> <feed-id> [<feed-id> ...]`.** Groups one or more feed cams under an event key so they render together on a combined `/event/<key>` page and get a banner promoted above everything on the homepage. It is meant for one-off events, like a bridge demolition streamed hi-res on one source and as a low-res traffic cam on another.

The first feed listed is the primary. Its image and name drive the banner and the combined page's title. The pins live in the `meta` table (`type='superfeature'`, `value=<key>`), so re-running is idempotent. A feed id with no stored cam is recorded anyway with a warning and shows once that feed is ingested.

```sh
bun superfeature i376-demolition pacast-i376-demolition mjpeg-511pa-6381
bun bake
```

---

## geo

**`bun geo <video_id> <lat> <lng>`.** Assigns a YouTube stream's map coordinates, stored inline on its `cams` row (`lat` between -90 and 90, `lng` between -180 and 180). Shodan and feed cams carry coordinates already; YouTube publishes none, so this is the hand-entered best guess from the place named in the stream's title. One coordinate per video; re-running replaces it. The stream then plots on `/map`.

---

## purge

**`bun purge`.** Removes stored RDP and VNC rows that predate the ingest filter. Some hosts serve a remote-desktop or VNC login that Shodan labels as a webcam; the scraper and importer now skip those, but that guard only blocks new rows. Purge retroactively drops any that slipped in before it existed. Re-run `bun bake` afterward.
