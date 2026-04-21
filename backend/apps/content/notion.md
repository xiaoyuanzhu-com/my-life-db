# Notion

Pages, databases, and workspaces — Notion's official export covers most of it, with some structural caveats.

## What you can export

- All pages (as Markdown or HTML)
- All databases (as CSV + per-row Markdown)
- Attached files and images
- Nested page hierarchy (preserved as nested folders)

What you lose:
- Inter-page links become file paths (may break if you rename).
- Synced blocks, linked databases, and some view configurations flatten.
- Comments (export strips them).

## Option 1 — Workspace export (recommended)

One-shot, covers everything. Must be done from the web app, not mobile.

1. Open Notion in a browser → **Settings & members** → **Settings** → **Export all workspace content**.
2. Export format:
   - **Markdown & CSV** — best for reading + indexing in this DB.
   - **HTML** — preserves styling (tables, callouts) but harder to grep.
   - **PDF** — archival only.
3. Check **Include subpages** and **Create folders for subpages**.
4. Click **Export**. For workspaces >1GB, Notion emails the download link.
5. Unzip and drop the folder into this data page.

[Start with agent →](mld:Help me import my Notion workspace export. I have the Markdown & CSV zip downloaded. Unpack it under imports/notion/, and suggest a plan for flattening or reorganizing if the folder depth is excessive.)

## Option 2 — Per-page export

For exporting a single page + its subpages without dumping the whole workspace.

1. Open the page → **···** (top-right) → **Export** → choose Markdown & CSV.
2. Rest same as Option 1 but scoped to one tree.

## Option 3 — Notion API sync

For incremental sync via the official API. Requires an integration token.

1. Go to `notion.so/my-integrations` → create an internal integration → copy the token.
2. Share specific pages / databases with the integration.
3. Agent scaffolds a script using `@notionhq/client` or `notion-client` (Python) to pull content as Markdown.

[Start with agent →](mld:Help me set up a Notion API sync. I have an integration token and a list of pages to export. Scaffold a script that pulls them as Markdown into imports/notion/ and re-runs incrementally.)

## Where it lands

`imports/notion/` — preserves Notion's folder-per-page structure.
