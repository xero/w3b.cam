# Agent Instructions: w3b.cam safari

Development contract for AI-assisted work on this repo. Read in full before starting any task.

---

## What This Project Is

A handful of Bun scripts around a local SQLite database. Scrapes webcam screenshots from the Shodan REST API, catalogs YouTube live cams, and other feed cam sources, then bakes a paginated static site from it all; the rest import, curate, and publish the data.

---

## Ground Rules

- Never commit. I review the unstaged diffs of your changes before committing and GPG signing.

## Code Style

- **Tabs, not spaces**
- **Unix line endings** (see `.gitattributes`)
- **Terse over verbose**: inline conditionals, short variable names,
  no unnecessary intermediates
- **TAGS OVER CLASSES**: relay on sematic html tags in your css over adding styles to the tags
- **No comments that restate code**: comments explain *why*, not *what*
- **NEVER use emdashes or endashes**: rewrite the sentence or use
  different punctuation. Ranges use a regular hyphen.
- **Keep `bun typecheck` clean**; type errors aren't the reviewer's problem.

---

## Architecture Constraints

- Static site built using HTMX.
- Gracefully supporting non-javascript clients
- adhearance to the "web-style" skill
    - Semantic html tags
    - css3 nesting & vars

---

## Definition of Done

A task is complete when **all** are true:

1. `bun typecheck` run, no errors remain
2. Any public API addition, removal, or signature change has matching
   doc updates in the README.md

---

## When You're Unsure

Ask. I am in the loop and quick to answer, so a short question beats a wrong
assumption on anything that matters: an API decision, a schema change, or a
destructive action. For low-stakes data a sensible best-guess is fine, for
example the hand-assigned approximate lat/lng that place YouTube streams on the
map. Just say what you assumed so I can check it in the diff.
