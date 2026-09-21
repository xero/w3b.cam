# Scraping

> [!NOTE]
> Fetching webcams from the Shodan REST API with `scrape`, the CI credit precheck `preflight`, and how query credits are spent.

> ### Table of Contents
> - [scrape](#scrape)
>   - [The default query](#the-default-query)
> - [preflight](#preflight)
> - [How the scraper works](#how-the-scraper-works)
> - [Query credits](#query-credits)

---

## scrape

**`bun scrape [--pages N] [--query "..."]`.** Fetches `N` search pages (default 1, 100 results per page) and saves new cameras to `camhunting.sqlite`. Re-running is safe; cameras already stored are skipped. Costs 1 query credit per page.

```sh
bun scrape --pages 5
```

Cameras land as `kind='cam'` rows keyed on the IP and port. The run prints a per-page tally (matches, new, refreshed, blacklisted, image-blocked, no-screenshot, gif skipped, decoy skipped, rdp/vnc skipped) and a closing summary with the credit balance before and after.

The scraper never plans to spend more credits than you hold. It reads your balance and the query's result count up front, then fetches the smaller of the pages you asked for, the pages that exist, and the credits you have. A credits-out or nothing-new run stays green and emits a neutral stop signal so CI skips the rebuild.

### The default query

Override the search query with `--query "your query"`. The default is:

```
has_screenshot:1 screenshot.label:webcam -screenshot.label:desktop
```

That matches hosts with a screenshot labeled as a webcam, excluding desktop captures.

---

## preflight

**`bun preflight`.** A CI-only credit precheck that spends nothing. It reads your Shodan balance through `getApiInfo` and sets a `has_credits` output, so the `scrape` workflow can skip downloading the database and scraping when no query credits remain. The job still exits green. You rarely run this by hand; it exists so a scheduled scrape does no wasted work.

---

## How the scraper works

The scraper pages through search results and stores one row per camera service, keyed on the IP and port. Because that pair is the primary key, a second run inserts only cameras it has not seen before. Each row keeps the location, network owner, the screenshot as base64, and the full raw match as JSON for later use.

A few details worth knowing:

**Screenshots need `minify: false`.** Shodan truncates large fields by default, which drops the screenshot. The client always requests full records.

**Requests are paced to roughly one per second, and retried on transient failures.** `shodan-ts` does no throttling and no retries, so the scraper spaces its calls and backs off on `429`, `5xx`, and transport errors; a timed-out or aborted fetch is retried, not fatal. A search page carries about 100 base64 screenshots and can run several MB, so the client allows a 60-second timeout. If a page still fails after its retries, the scraper stops early and saves what it already fetched instead of discarding the whole run, so a mid-run blip costs one page, not the batch.

**GIF screenshots are refused.** No camera answers with a GIF; JPEG and MJPEG are the standard. The GIFs Shodan hands out, labeled `image/jpeg`, are multi-megabyte animated desktop grabs and meme spam, and in September 2026 they alone pushed the store past GitHub's 2 GiB asset ceiling. The scraper and importer detect the format from the bytes, not the label, skip the banner, and count it in the tally as `gif skipped`.

**Decoy banners are refused.** The same spam campaign earns Shodan's `Generic IP camera` fingerprint by copying an embedded camera web server's headers (`Server: Boa/0.94.14rc21`) over a one-byte 200 body, then serving a meme from the snapshot path. A real camera's root answers with a login page or a viewer, never nothing. Any banner whose HTTP module shows a Boa server header, a 200 status, and a present-but-empty body is skipped and counted as `decoy skipped`. The rule is pinned to Boa because a few real Hikvisions also answer 200 with an empty body, and it requires the body field to be present so a banner with no HTTP module passes. Across the whole database that rule matches every one of the 634 spam rows and none of the 257 real Boa cams. Since a spammer can drop the tell, the campaign's addresses are also on the IP blacklist.

**RDP and VNC screens are filtered.** Some hosts serve a remote-desktop or VNC login that Shodan labels as a webcam. The scraper and importer skip any product of `remote desktop protocol` or `vnc` as they ingest. That guard only blocks new rows, so `bun purge` retroactively drops any that predate it. Re-run `bun bake` afterward. See [Curation](./curation.md#purge).

**Blacklisted screenshots are skipped.** A screenshot whose image hash sits in the `image_blacklist` never enters the database, from any source. The check runs as each row is written, so a spam image reused across rotating IPs is caught whatever host carries it. Add one with `bun blacklist <image-hash>`. See [Curation](./curation.md#blacklist).

---

## Query credits

> [!CAUTION]
> Search costs credits. Every filtered query spends 1 query credit per page, including the first. `scrape --pages N` spends about `N`. Checking the result count and your balance is free. Free accounts have a small monthly allowance, so start with one page and scale up once a run looks right.
