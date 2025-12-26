# Background Processing Architecture

## Overview

All background processing runs in the **main Node.js process** alongside the Express server. There is no separate worker thread or process - background services share the event loop with API request handling.

## Architecture

```mermaid
graph TB
    subgraph "Main Process"
        subgraph "API Layer"
            API[Express Server]
            INBOX[api/inbox]
            UPLOAD[api/upload/finalize]
        end

        subgraph "Background Services"
            FSW[FileSystemWatcher]
            SUP[DigestSupervisor]
            SCAN[LibraryScanner]
        end

        subgraph "Core"
            COORD[DigestCoordinator]
            DB[(SQLite)]
            NOTIFY[NotificationService]
        end

        subgraph "External Services"
            MEILI[Meilisearch]
            QDRANT[Qdrant]
        end
    end

    API --> INBOX
    API --> UPLOAD
    INBOX --> |saveToInbox| DB
    UPLOAD --> |saveToInbox| DB
    INBOX --> |ensureAllDigesters| COORD
    UPLOAD --> |ensureAllDigesters| COORD

    FSW --> |file events| DB
    FSW --> |ensureAllDigesters| COORD
    FSW --> |inbox-changed| NOTIFY

    SUP --> |polls pending| DB
    SUP --> |processFile| COORD

    SCAN --> |upsertFileRecord| DB

    COORD --> |read/write digests| DB
    COORD --> |index| MEILI
    COORD --> |embed| QDRANT
```

## Service Lifecycle

```mermaid
sequenceDiagram
    participant Server as Express Server
    participant Init as initializeApp()
    participant FSW as FileSystemWatcher
    participant SUP as DigestSupervisor
    participant SCAN as LibraryScanner

    Server->>Init: startup
    Init->>Init: initializeDigesters()
    Init->>FSW: startFileSystemWatcher()
    Init->>SCAN: startPeriodicScanner()
    Init->>SUP: startDigestSupervisor()
    Init->>Init: registerShutdownHooks()

    Note over FSW,SUP: Services run until shutdown

    Server->>Init: SIGTERM/SIGINT
    Init->>SUP: stopDigestSupervisor()
    Init->>FSW: stopFileSystemWatcher()
    Init->>SCAN: stopPeriodicScanner()
```

## Background Services

| Service | Trigger | Interval | Purpose |
|---------|---------|----------|---------|
| FileSystemWatcher | chokidar events | realtime (500ms stability) | Detect file changes, update DB, trigger digests |
| DigestSupervisor | setInterval | 10 seconds | Poll for pending digests, process sequentially |
| LibraryScanner | setInterval | 1 hour | Full filesystem scan for missed files |

## Digest Processing Flow

```mermaid
flowchart TD
    subgraph "Trigger Sources"
        A1[API Upload] --> |immediate| E
        A2[FileSystemWatcher] --> |~500ms delay| E
        A3[DigestSupervisor] --> |polling| P
    end

    E[ensureAllDigesters]
    E --> |create placeholders| DB[(digests table)]

    P[processFile]
    DB --> |query pending| P

    subgraph "DigestCoordinator"
        P --> L{Lock acquired?}
        L --> |no| SKIP[Skip - already processing]
        L --> |yes| PROC[Process digesters]
        PROC --> REL[Release lock]
    end

    subgraph "Lock Protection"
        MEM[In-memory Set]
        DBL[processing_locks table]
        L --> MEM
        MEM --> DBL
    end
```

## Duplicate Processing Prevention

Multiple sources trigger digest processing for the same file:

1. **API endpoint** - Immediate `ensureAllDigesters()` after file save
2. **FileSystemWatcher** - Detects file after ~500ms stabilization
3. **DigestSupervisor** - Polls every 10s for pending digests

**Protection layers:**

| Layer | Scope | Speed | Purpose |
|-------|-------|-------|---------|
| `ensureAllDigesters()` | Placeholder creation | Fast | Only creates if missing (idempotent) |
| `activeProcessingFiles` Set | Same process | O(1) | Skip if already processing this file |
| `processing_locks` table | Cross-process | DB query | Prevent concurrent processing across instances |
| Digest status check | Per-digester | DB query | Skip `in-progress` or `completed` digests |

## Search Indexing

Search indexing runs as digesters within the coordinator:

```mermaid
flowchart LR
    COORD[DigestCoordinator] --> SK[search-keyword digester]
    COORD --> SS[search-semantic digester]

    SK --> |indexInMeilisearch| MEILI[Meilisearch]
    SS --> |indexInQdrant| QDRANT[Qdrant]

    DEL[File Deletion] --> |deleteFromMeilisearch| MEILI
    DEL --> |deleteFromQdrant| QDRANT
```

Direct async function calls (no queue):
- `indexInMeilisearch(documentIds)`
- `indexInQdrant(documentIds)`
- `deleteFromMeilisearch(documentIds)`
- `deleteFromQdrant(documentIds)`

## Configuration

| Setting | Default | Location |
|---------|---------|----------|
| Supervisor interval | 10s | `supervisor.ts` |
| FS watcher stability | 500ms | `fs-watcher.ts` |
| Library scanner interval | 1 hour | `library-scanner.ts` |
| Max digest attempts | 3 | `constants.ts` |

## Future: Worker Thread Isolation

The current single-process design is simple but has tradeoffs:

**Current (single process):**
- ✅ Simple architecture, shared SQLite connection
- ✅ No IPC overhead
- ⚠️ Heavy digest processing can delay API responses
- ⚠️ All work shares the event loop

**Potential worker thread design:**
- Move DigestCoordinator + DigestSupervisor to worker thread
- Main thread only handles API requests
- Communication via `postMessage()` / `parentPort`
- Requires careful handling of SQLite (better-sqlite3 is sync)
