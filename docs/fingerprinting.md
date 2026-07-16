# Fingerprinting

> [!NOTE]
> Deriving a camera's real make and model from its banner. Fingerprinting runs automatically at ingest; `bun fingerprint` is the catch-up backfill for when you add a new rule.

---

## How it works

Shodan's own `product` is often empty or just the web server (`nginx`, `Boa`) rather than the camera. Fingerprinting mines the full banner through a highest-confidence-first cascade and derives the real make and model into the `product` field the site renders as "Fingerprint". The signals, in order: the page title, the Hikvision block, cpe23, the HTTP `Server:` header, HTML endpoint paths, and the RTSP banner.

Fingerprinting runs at ingestion time. The cam and feed upserters wire the classifiers in, so every scrape, import, and dev-mode paste writes the derived `product` and its `fingerprints` audit row at insert. The `/fingerprints` page in the header nav is the make, model, and count breakdown built from those labels, each make linking a gallery of its matching cams.

---

## fingerprint

**`bun fingerprint [--apply] [--force]`.** The catch-up backfill. It re-derives the whole `cams` table on demand and rebuilds the `fingerprints` audit table from scratch. Run it after adding a fingerprint rule, since ingest only touches a row when that row is next re-ingested, so a new rule reaches already-stored rows only through this backfill. It reuses the same decision logic the ingest path does, so the two cannot drift.

It is a dry run by default, printing a report and recording every decision in a reviewable `fingerprints` table without writing `product`. Pass `--apply` to write the `product` column.

The command refuses to touch the production `camhunting.sqlite`, so run it against a copy:

```sh
cp camhunting.sqlite camhunting.fp.sqlite
DB_PATH=camhunting.fp.sqlite bun fingerprint          # dry run: audit and report only
DB_PATH=camhunting.fp.sqlite bun fingerprint --apply  # write cams.product too
```

Pass `--force` to override the production guard. Re-run `bun bake` after an `--apply` to rebuild the site.

The report is worth reading before you apply. It breaks decisions down by action and confidence tier, flags any downgrade of an existing good label (which must be zero), calls out single-host inflation where one IP contributes many ports, and samples the rows it could only floor to "Generic IP camera", which are your candidates for a new rule.
