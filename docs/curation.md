# Curation

> [!NOTE]
> The database-editing commands: blacklist (by IP, host, or image hash), remove, pin a card image, tag, feature, super-feature, geolocate, and purge. Each writes straight to `camhunting.sqlite`; re-run `bun bake` afterward to rebuild the site. The same edits are available by right-click in [`bun dev`](./editing-locally.md).

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
> - [unsuperfeature](#unsuperfeature)
> - [geo](#geo)
> - [purge](#purge)

---

## blacklist

**`bun blacklist <ip | hostname | image-hash>`.** Deletes every matching row and records the entry so the scraper and every importer skip it, meaning what you drop never comes back on a later run. The argument type is auto-detected:

- **IP.** Matches exactly, every port. Stored in a `blacklist` table.
- **Hostname or domain.** Matches itself and any subdomain, so `bun blacklist cloudzy.com` also drops `cam.node.cloudzy.com`. Stored in a `host_blacklist` table.
- **Image hash.** The 16-hex hash from an image URL, the `<hash>` in `/img/<hash>.jpg`. Blocks by screenshot content rather than by host. It removes that exact image from every camera serving it and skips it on future ingest, whatever IP carries it. Stored in an `image_blacklist` table. Reach for this when a spam host rotates IPs but reuses one static image, where an IP or host block is whack-a-mole.

The image block is enforced as rows are written, so it covers every source at once: `scrape`, `import`, and `osiris`. A fresh database starts with a built-in list of blacklisted hostnames; IPs and image hashes start empty.

```sh
bun blacklist 203.0.113.7        # one host, every port
bun blacklist cloudzy.com        # a domain and its subdomains
bun blacklist 1e5a6c3a27892c05   # one screenshot, across every host that serves it
```

---

## unblacklist

**`bun unblacklist <ip | hostname | image-hash>`.** Reverses a blacklist entry of any of the three kinds, auto-detected the same way. Clear it, then re-run `bun scrape` or re-ingest its source to fetch it again. It does not rebuild on its own, because no camera data changes until the next ingest re-adds the target.

---

## remove

**`bun remove [--kind cam|stream|feed|image] <ref>`.** Deletes a stored entry without blacklisting it. Unlike `blacklist`, nothing is recorded to keep it out, so a removed entry returns the next time its source is re-ingested by `scrape`, `import`, or `osiris`. Removing also clears the entry's tags and featured pins.

- **cam (default).** `<ref>` is an IP (matched exactly, every port) or a hostname/domain (matches itself and any subdomain, like `blacklist`).
- **stream or feed.** `<ref>` is the stored id (video id or feed id).
- **image.** `<ref>` is the 16-hex image hash from an `/img/<hash>.jpg` URL. Every camera serving that exact screenshot is dropped, across all hosts.

Reach for `blacklist` instead when you want a host or image gone for good.

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

The first feed listed is the primary. Its image and name drive the banner and the combined page's title. The pins live in the `meta` table (`type='superfeature'`, `value=<key>`), so re-running is idempotent. A feed id with no stored cam is recorded anyway with a warning and shows once that feed is ingested. When the event is over, `bun unsuperfeature <event-key>` takes it back down.

```sh
bun superfeature i376-demolition pacast-i376-demolition mjpeg-511pa-6381
bun bake
```

---

## unsuperfeature

**`bun unsuperfeature <event-key> [<feed-id> ...]`.** Pulls a completed event's group off the homepage banner and removes its combined `/event/<key>` page. The inverse of `superfeature`. With no feed ids it removes the whole event; with feed ids it drops only those from the group and leaves the rest. The feed cams themselves are untouched: they keep rendering as ordinary feeds, no longer grouped as an event, so they rejoin the normal feeds gallery.

```sh
bun unsuperfeature i376-demolition                    # event over: drop the whole banner + /event page
bun unsuperfeature i376-demolition mjpeg-511pa-6381   # or drop just one feed from the group
bun bake
```

---

## geo

**`bun geo <video_id> <lat> <lng>`.** Assigns a YouTube stream's map coordinates, stored inline on its `cams` row (`lat` between -90 and 90, `lng` between -180 and 180). Shodan and feed cams carry coordinates already; YouTube publishes none, so this is the hand-entered best guess from the place named in the stream's title. One coordinate per video; re-running replaces it. The stream then plots on `/map`.

---

## purge

**`bun purge`.** Removes stored RDP and VNC rows that predate the ingest filter. Some hosts serve a remote-desktop or VNC login that Shodan labels as a webcam; the scraper and importer now skip those, but that guard only blocks new rows. Purge retroactively drops any that slipped in before it existed. Re-run `bun bake` afterward.
