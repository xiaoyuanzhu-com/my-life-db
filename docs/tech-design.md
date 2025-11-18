# Technical Design Document: MyLifeDB

## Table of Contents

- [Technical Design Document: MyLifeDB](#technical-design-document-mylifedb)
  - [Table of Contents](#table-of-contents)
  - [1. Design Principles](#1-design-principles)
  - [2. System Architecture](#2-system-architecture)
    - [2.1 Layered Flow](#21-layered-flow)
    - [2.2 Module Responsibilities](#22-module-responsibilities)
  - [3. Technology Stack](#3-technology-stack)
  - [4. Data Models](#4-data-models)
  - [5. API Specifications](#5-api-specifications)
  - [6. Design Decisions](#6-design-decisions)
  - [7. Feature Designs](#7-feature-designs)
    - [7.1 Inbox](#71-inbox)
    - [7.2 Library](#72-library)
    - [7.3 Digesters](#73-digesters)
    - [7.4 Search](#74-search)
    - [7.5 File System Scan](#75-file-system-scan)
    - [7.6 Task Queue](#76-task-queue)
    - [7.7 Misc](#77-misc)
  - [8. UI Overview](#8-ui-overview)

---

## 1. Design Principles

- **Filesystem as truth:** `MY_DATA_DIR` hosts inbox + library folders; SQLite mirrors metadata and can be recomputed at any time.
- **Derived data is disposable:** Digests, search documents, and cache rows can be rebuilt, so recovery is always deterministic.
- **Local-first performance:** Next.js API routes run on the same machine as the data, eliminating network hops while still supporting background work.
- **Transparent modules:** Each service (scanner, digesters, task queue, search bridge) is discoverable under `src/lib/*`.
- **Progressive UX:** Core flows (capture, browse, inspect files) work without AI; digesters and search are additive layers.

---

## 2. System Architecture

### 2.1 Layered Flow

```mermaid
graph LR
    subgraph L1["Experience Layer"]
        OmniInput["OmniInput"]
        InboxUI["Inbox"]
        LibraryUI["Library"]
        FileInspector["File Inspector"]
        SearchUI["Search Overlay"]
    end

    subgraph L2["Next.js App Router"]
        ApiRoutes["API Routes"]
        ServerActions["Server Actions"]
    end

    subgraph L3["Domain + Background"]
        FileCatalog["File Catalog Service"]
        DigestCoordinator["Digesters"]
        SearchBridge["Search Bridge"]
        TaskRuntime["Task Queue Worker"]
    end

    subgraph L4["Storage & Infra"]
        FileSystem["Filesystem (inbox, library)"]
        SQLiteDB["SQLite (better-sqlite3)"]
        SQLAR["SQLAR Archives"]
        Meili["Meilisearch"]
    end

    OmniInput --> ApiRoutes
    InboxUI --> ApiRoutes
    LibraryUI --> ApiRoutes
    FileInspector --> ApiRoutes
    SearchUI --> ApiRoutes

    ApiRoutes --> FileCatalog
    ApiRoutes --> DigestCoordinator
    ApiRoutes --> SearchBridge
    ApiRoutes --> TaskRuntime

    FileCatalog --> FileSystem
    FileCatalog --> SQLiteDB
    DigestCoordinator --> SQLiteDB
    DigestCoordinator --> SQLAR
    TaskRuntime --> SQLiteDB
    SearchBridge --> Meili
    SearchBridge --> SQLiteDB

    DigestCoordinator --> TaskRuntime
    TaskRuntime --> DigestCoordinator
```

### 2.2 Module Responsibilities

- **Experience layer:** React 19 components (OmniInput, inbox cards, library tree, file inspector, search overlay) fetch JSON from API routes and keep minimal local state.
- **App Router layer:** Handles routing, validation, and streaming responses. API routes live beside the UI and call into domain services.
- **Domain + background layer:** `src/lib/db/*` exposes catalog queries, `src/lib/digest/*` registers digesters, `src/lib/search/*` syncs with Meilisearch, and `src/lib/task-queue/*` powers background execution.
- **Storage & infra layer:** User directories hold raw files, SQLite + SQLAR hold metadata and binary digests, and Meilisearch indexes the rebuildable textual view.

---

## 3. Technology Stack

Single stack across client and server: Next.js 15 App Router with React 19 + TypeScript, Tailwind + shadcn UI primitives, Node 20 runtime with better-sqlite3 + Drizzle for SQLite access, optional Meilisearch for keyword search, and zero additional backend services.

---

## 4. Data Models

Entries, spaces, clusters, insights, and principles no longer exist. The database now mirrors the filesystem (`files`), digest output (`digests` + `sqlar`), search replicas (`meili_documents`), operational state (`tasks`), user preferences (`settings`), and schema tracking (`schema_version`).

```mermaid
classDiagram
    class Files {
      path PK
      name
      is_folder
      size
      mime_type
      hash
      modified_at
      created_at
      last_scanned_at
    }

    class Digests {
      id PK
      file_path FK
      digest_type
      status
      content
      sqlar_name
      error
      created_at
      updated_at
    }

    class Sqlar {
      name PK
      mode
      mtime
      sz
      data
    }

    class Tasks {
      id PK
      type
      payload_json
      status
      attempts
      priority
      run_after
      result_json
      error
      created_at
      updated_at
      completed_at
    }

    class MeiliDocuments {
      document_id PK
      file_path FK
      source_type
      full_text
      content_hash
      word_count
      content_type
      metadata_json
      meili_status
      meili_task_id
      meili_indexed_at
      meili_error
      created_at
      updated_at
    }

    class Settings {
      key PK
      value_json
      updated_at
    }

    class SchemaVersion {
      version PK
      applied_at
      description
    }

    Digests --> Files : references
    Sqlar --> Digests : stores binary outputs
    Tasks --> Digests : payload references
    MeiliDocuments --> Files : references
```

- **Files:** Rebuildable catalog of every folder and file under `MY_DATA_DIR`, including hashes for sub-10MB files.
- **Digests:** Status tracker for every enrichment a file has undergone (summary, tags, slug, screenshot, OCR, etc.).
- **SQLAR:** Stores binary digest payloads such as screenshots or OCR bundles without polluting the user filesystem.
- **Tasks:** Durable queue with retry tracking; payloads mention file paths or digest IDs instead of legacy item IDs.
- **Meili documents:** Mirror the textual view of each file to Meilisearch; rows are regenerated whenever digests change.
- **Settings:** Holds local configuration such as search host overrides, log level, and vendor credentials.
- **Schema version:** Records applied migrations so schema evolution can be coordinated with scanners/digesters.

---

## 5. API Specifications

| Endpoint | Description | Notes |
|----------|-------------|-------|
| `GET /api/inbox` | Lists top-level inbox files/folders with selected digest summaries. | Uses `listFilesWithDigests` and optional pagination parameters. |
| `POST /api/inbox` | Saves text and/or uploaded files into the `inbox/` folder. | Streams multipart uploads straight to disk, then records metadata. |
| `GET /api/library/tree` | Returns a filtered directory tree for any library folder. | Skips reserved/hidden entries and normalizes paths to stay within `MY_DATA_DIR`. |
| `GET /api/library/file` | Streams file contents (text JSON or binary download). | Honors `download=true` and content-type inference; no “size opt” flag is exposed. |
| `GET /api/library/file-info` | Returns metadata plus every digest for a file. | Drives the file inspector page to show enrichment status. |
| `GET /api/digest/[...path]` | Reports digest status for any file path. | Wraps `getDigestStatusView` for UI polling. |
| `POST /api/digest/[...path]` | Forces digesters to run for a specific file. | Instantiates `DigestCoordinator` and enqueues/runs applicable digesters. |
| `GET /api/search` | Keyword search backed by Meilisearch + digest metadata. | Supports query, pagination, optional MIME/path filters, and returns enriched file payloads. |
| `GET/POST /api/tasks` | Lists, creates, or updates tasks for background work. | Used internally by digesters and by the settings UI for manual retries. |
| `GET /api/tasks/stats` and `/api/tasks/worker/*` | Operational endpoints to inspect/pause/resume the worker. | Provides visibility into background processing. |
| `GET/PUT /api/settings` | Reads or updates local configuration. | Captures data root, vendor settings, and UI preferences. |

---

## 6. Design Decisions

| Topic | Options Considered | Decision (with rationale) |
|-------|--------------------|---------------------------|
| Source of truth | Keep legacy `items` table vs. rely on filesystem | Filesystem chosen: simpler mental model, avoids ID drift, and lets other tools edit data without migrations. |
| Digest storage | Sidecar folders, object storage, or SQLAR | SQLAR keeps derived artifacts in SQLite so they can be vacuumed, compressed, and versioned atomically. |
| Search replica | SQLite FTS, Meilisearch, or hybrid | Dedicated Meilisearch index offers BM25 scoring + highlighting while SQLite remains the authoritative catalog. |
| App data folder | Hidden `.app/` vs. visible `app/` | Visible `app/` directory reinforces transparency and makes debugging easy. |
| Task infrastructure | External worker (BullMQ, Temporal) vs. embedded queue | Embedded queue fits offline-first needs, keeps dependencies local, and persists in SQLite. |
| Hash strategy | Always hash vs. size-only vs. adaptive | Adaptive hashing (<10MB) balances change detection accuracy with scan performance for large binaries. |

---

## 7. Feature Designs

### 7.1 Inbox

- `POST /api/inbox` calls `saveToInbox`, writes files into `data/inbox/`, and immediately indexes the top-level folder/file in `files`.
- `GET /api/inbox` filters `listFilesWithDigests('inbox/')` to only show top-level entries, attaches short text previews via `readPrimaryText`, and returns screenshot digests when available.
- Digest recompute buttons (via `/api/digest/...`) work because every row is addressed by path rather than synthetic IDs, so renames and slugging remain traceable.

### 7.2 Library

- The stateful library page (`src/app/library/page.tsx`) keeps `openedFiles`, `activeFile`, and expanded folder sets in `localStorage` (`library:*` keys) to survive reloads.
- `FileTree` lazily fetches nodes through `/api/library/tree`, `FileViewer` streams content via `/api/library/file`, and `FileTabs` mirrors open documents so users can treat the page like a mini IDE.
- Deep linking (`/library?open=notes/foo.md`) preloads tabs, and every interaction calls `expandParentFolders` to auto-open the correct tree nodes.

### 7.3 Digesters

- **Architecture:** Registry-based sequential executor. `DigesterRegistry` stores implementations (URL crawler → summary → tagging → slugging) and each digester self-filters via `canDigest`.
- **Interface:** Every digester exposes `id`, `produces`, optional `requires`, and `digest()` returning the digests it created. Binary outputs land in SQLAR with the `{path_hash}/{digest_type}/filename.ext` convention.
- **Coordinator flow:** `DigestCoordinator.processFile()` loads file metadata + existing digests, loops over registered digesters, skips already enriched rows, marks the current target as `enriching`, then runs the digester. Results persist immediately so partial progress survives crashes.
- **Worker loop:** The task runner repeatedly asks `findFilesNeedingDigestion(...limit=1)` for the oldest pending/failed file, processes it through the entire digester chain, and immediately repeats. When no files remain it sleeps (e.g., 60s) before polling again, so the worker stays simple while still reacting quickly when new work appears.
- **Status + completion:** Digest rows follow `pending → enriching → enriched/failed/skipped`. A file stops being selected when every produced digest is terminal (`enriched` or `skipped`). Selection query: `SELECT DISTINCT file_path FROM digests WHERE status IN ('pending','failed') ORDER BY updated_at ASC LIMIT ?`.
- **Backfill + evolution:** `initializeDigesters()` registers the current set, `syncNewDigesters()` inserts pending digests when new processors ship, and the lazy-insert model ensures only files that need work get rows. Adding a new digester is as simple as placing it in `src/lib/digest/digesters`, registering it, and restarting; the worker loop will pick up the new pending rows automatically.

### 7.4 Search

- Unified search lives at `/api/search` and `/components/search-results.tsx`.
- All behavioral details (ranking, debounce strategy, UX flows) are specified in [docs/search-design.md](./search-design.md); this document only tracks how search integrates with the file-centric data model.

### 7.5 File System Scan

- `startPeriodicScanner()` runs `scanLibrary()` to walk every non-reserved folder, hash sub-10MB files, and upsert `files` rows with timestamps.
- Scans skip hidden folders, respect reserved names (e.g., `app/`, `.git`), and reuse stored hashes to avoid reading unchanged binaries.
- Manual rescans can pass `force=true` to refresh metadata when users rewire directories outside the app.

### 7.6 Task Queue

- The embedded queue (`src/lib/task-queue/*`) stores tasks in SQLite, exposes HTTP endpoints for inspection, and runs a worker loop inside the Next.js server process.
- Tasks transition through `pending → enriching → enriched/failed/skipped`, mirroring digest statuses so the UI can show unified progress bars.
- Retry logic uses exponential backoff with jitter, and handlers (e.g., `digest_url_crawl`, `digest_url_slug`) are pure functions that can be re-run without side effects because inputs are file paths.

### 7.7 Misc

- **Schema evolution:** Migrations append to `schema_version`, and UI badges draw attention to stale records so users can trigger re-processing.
- **Settings + vendors:** `/api/settings` persists data dir overrides, Meilisearch hosts, AI vendor preferences, and log levels; initialization (`src/lib/init.ts`) reads them to configure services.
- **App initialization:** `initializeApp()` (wired through instrumentation) ensures digesters, task queue, scanner, database migrations, and search indices come online exactly once per server boot.

---

## 8. UI Overview

- **Home (`src/app/page.tsx`):** Chat-like interface with two-container layout: (1) scrollable feed area displaying either `InboxFeed` or `SearchResults` based on search state, and (2) fixed `OmniInput` at bottom with border-top separator. The feed shows newest items at bottom (chat-style ordering) with smart timestamps ("16:04", "Yesterday 23:10", "10/16 09:33") centered above each card. Infinite scroll loads older items in batches when scrolling up. Cards use intrinsic sizing without fixed aspect ratios, adapting to content naturally. Search seamlessly replaces inbox when user types 2+ characters.
- **OmniInput (`src/components/omni-input.tsx`):** Compact 1-line composer (40px min-height) that persists text in `sessionStorage`, detects input type, performs adaptive debounce search, accepts drag-and-drop files, and notifies parent of search state changes via callback. Input stays visible while feed scrolls independently above it.
- **Inbox feed (`src/components/inbox-feed.tsx`):** Scrollable feed that fetches inbox items in batches (20 per load) via `/api/inbox`, displays them in reverse chronological order (newest at bottom), and implements infinite scroll upwards to load older items. Each card shows timestamps and adapts to content size.
- **Inbox page (`src/app/inbox/page.tsx`):** Alternative inbox view that groups files by local date, renders cards with snippets via `FileCard`, and keeps sticky day headers so long timelines remain scannable even while digest statuses update.
- **Library (`src/app/library/page.tsx` + `src/components/library/*`):** IDE-style split view with persistent tabs, expandable tree, and footer metadata. Local state survives reloads, and each viewer tab can stream binary or text files without leaving the page.
- **File inspector (`src/app/file/[...path]/page.tsx`):** Standalone page showing rich metadata, digest cards, status icons, error traces, and manual re-digest controls for any path.
- **Search overlay (`src/components/search-results.tsx`):** Scrollable feed that replaces inbox when search is active, showing results with timestamps in the same chat-like layout. Displays loading states, error messages, and empty states in centered position. Supports pagination with "load more" button.
- **Settings (`src/app/settings/[[...tab]]`):** Tabbed layout powered by React context that surfaces storage info, vendor credentials, and task queue controls while calling `/api/settings` and `/api/tasks/worker/*`.
- **Shared chrome:** `Header`, `BottomNav`, `Footer` (hidden on homepage), and `ThemeToggle` live under `src/components/`, keep navigation consistent, and respect design tokens defined in `globals.css`. `FileCard` supports optional timestamps and intrinsic sizing via `showTimestamp` prop.

The UI deliberately keeps controls minimal (few borders, subtle hover states) while exposing operational context such as digest status, search matches, and task counts so power users can understand system health at a glance.
