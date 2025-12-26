# Background Processing Architecture

## Overview

The application processes files through a digest pipeline that runs in the background. This document describes the architecture for coordinating between API requests, file system changes, and digest processing.

## Components

### 1. DigestCoordinator

Orchestrates digest processing for individual files. Key features:

- **Dual-layer lock protection** prevents duplicate processing:
  1. In-memory `activeProcessingFiles` Set (same-process protection)
  2. Database `processing_locks` table (cross-process protection)
- Processes digesters sequentially per file
- Handles cascading resets when upstream digesters complete

Location: `app/.server/digest/coordinator.ts`

### 2. DigestSupervisor

Background polling loop that finds and processes files needing digestion:

- Runs on configurable interval (default: 10 seconds)
- Queries for files with pending/failed digests
- Processes one file at a time
- Automatically picks up work from any trigger source

Location: `app/.server/digest/supervisor.ts`

### 3. FileSystemWatcher

Monitors DATA_ROOT for file changes using chokidar:

- Detects new files, modifications, and deletions
- Uses 500ms stabilization threshold to ensure writes complete
- Calls `ensureAllDigesters()` for new files
- Emits `inbox-changed` notifications for UI updates

Location: `app/.server/scanner/fs-watcher.ts`

### 4. API Endpoints

Upload endpoints trigger immediate digest processing:

- `api/inbox` - Direct file uploads
- `api/upload/finalize` - TUS chunked upload completion

Both call `ensureAllDigesters()` after saving files.

## Processing Flow

```
User Upload
    │
    ▼
API Endpoint ──────────────────┐
    │                          │
    │ saveToInbox()            │ ensureAllDigesters()
    │                          │
    ▼                          ▼
Filesystem ◄────────── Digest placeholders created
    │                          │
    │ chokidar detects         │
    ▼                          │
FileSystemWatcher              │
    │                          │
    │ ensureAllDigesters()     │
    │ (duplicate, skipped)     │
    ▼                          │
DigestSupervisor ◄─────────────┘
    │
    │ polls for pending digests
    ▼
DigestCoordinator
    │
    │ acquires lock, processes
    ▼
Digesters execute
```

## Duplicate Processing Prevention

Multiple sources can trigger digest processing for the same file:

1. **API endpoint** - Immediate call after file save
2. **FileSystemWatcher** - Detects new file after ~500ms
3. **DigestSupervisor** - Periodic polling finds pending digests
4. **User action** - Manual re-digest request

All paths are safe because:

1. `ensureAllDigesters()` only creates placeholder records if missing (idempotent)
2. `DigestCoordinator.processFile()` checks in-memory Set first (fast path)
3. Falls back to database lock check (cross-process safety)
4. Digests with `in-progress` status are skipped

## Search Indexing

Search indexing (Meilisearch, Qdrant) uses direct async function calls:

- `indexInMeilisearch(documentIds)` - Keyword search indexing
- `indexInQdrant(documentIds)` - Semantic search indexing
- `deleteFromMeilisearch(documentIds)` - Remove from keyword index
- `deleteFromQdrant(documentIds)` - Remove from semantic index

These are called from digesters (`search-keyword`, `search-semantic`) and file deletion.

Location: `app/.server/search/meili-tasks.ts`, `app/.server/search/qdrant-tasks.ts`

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Supervisor interval | 10s | Polling frequency for pending digests |
| FS watcher stability | 500ms | Wait time before processing new files |
| Max digest attempts | 3 | Retry limit before permanent failure |
| Lock timeout | 5min | Stale lock detection threshold |
