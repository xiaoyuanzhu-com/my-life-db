# Three-Tab Navigation Redesign

**Date:** 2026-04-06
**Status:** Approved

## Goal

Simplify the app from its current multi-section navigation (Home, Library, Agent, People, Settings) into a clean three-tab architecture: **Data**, **Agent**, **Me**.

- **Data** — all user data, file browsing, search
- **Agent** — AI computation (Claude Code sessions, unchanged)
- **Me** — personal settings (replaces Settings)

## What Gets Removed

| Removed | Reason |
|---------|--------|
| Inbox / Inbox Feed | No longer needed; users file directly to folders |
| Home page (`/`) | Replaced by Data as the landing page |
| People page (`/people`) | Not needed at this stage |
| Library dual-pane editor | Replaced by simpler browse → detail flow |
| Standalone Inbox route (`/inbox`) | Removed with Inbox concept |

## Data Page

### Interaction Model (unified across desktop and mobile)

**Layer 1 — Browse:**
- File/folder grid view (responsive: larger cards on desktop)
- Top search bar
- Three-dot menu (top right): upload, refresh, and other common actions
- Upload requires user to choose a target folder (manual categorization)
- Future: "auto-archive" upload option powered by Agent (not in this iteration)

**Layer 2 — Detail:**
- Click a file → navigate to a detail sub-page or open a popup modal
- Shows file content, metadata, digest info
- Desktop and mobile share the same interaction pattern

### Desktop vs Mobile Differences

Only visual density differs — desktop gets a larger grid with more columns. The interaction flow (browse grid → click → detail) is identical.

## Agent Page

No changes. Keeps current Claude Code session list + chat interface.

## Me Page

Replaces the current Settings page. Same content (general, data sources, digests, AI model, danger zone), new name and navigation position.

## Navigation UI

### Mobile
- Bottom tab bar with 3 tabs: Data, Agent, Me
- Icons + labels

### Desktop
- Header or sidebar with 3 navigation items: Data, Agent, Me

## Routes (new)

```
/                → Data (file browser grid + search)
/file/*          → File detail view
/agent           → Agent sessions list
/agent/:id       → Agent session detail
/me              → Me (settings)
/me/*            → Settings sub-pages
/share/:token    → Public shared page (unchanged)
```

## Routes (removed)

```
/inbox
/inbox/:id
/library
/library/browse
/people
/people/:id
/settings/*      → moved to /me/*
```
