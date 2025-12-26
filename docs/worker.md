# Worker Thread Architecture

## Overview

The application uses worker threads to isolate background processing from the API server:

```mermaid
graph TB
    subgraph "Main Thread"
        API[Express API]
        NS[NotificationService]
        DB1[(SQLite conn)]
    end

    subgraph "FS Worker"
        FSW[FileSystemWatcher]
        SCAN[LibraryScanner]
        DB2[(SQLite conn)]
    end

    subgraph "Digest Worker"
        SUP[DigestSupervisor]
        COORD[DigestCoordinator]
        DB3[(SQLite conn)]
    end

    subgraph "External Services"
        MEILI[Meilisearch]
        QDRANT[Qdrant]
        OPENAI[OpenAI]
        HOMELAB[Homelab AI]
    end

    API -->|requestDigest| SUP
    FSW -->|file-change| SUP
    FSW -->|inbox-changed| API
    API --> NS

    COORD --> MEILI
    COORD --> QDRANT
    COORD --> OPENAI
    COORD --> HOMELAB
```

## Workers

### FS Worker
**Purpose:** File system monitoring and scanning

**Components:**
- FileSystemWatcher - realtime file change detection (chokidar)
- LibraryScanner - periodic full filesystem scan (hourly)

**Messages received:**
| Type | Payload | Description |
|------|---------|-------------|
| `shutdown` | - | Graceful shutdown |

**Messages sent:**
| Type | Payload | Description |
|------|---------|-------------|
| `ready` | - | Worker initialized |
| `inbox-changed` | `{ timestamp }` | File added/removed in inbox |
| `file-change` | `{ filePath, isNew, contentChanged }` | File changed (forwarded to digest worker) |
| `shutdown-complete` | - | Shutdown done |

---

### Digest Worker
**Purpose:** All digest processing

**Components:**
- DigestSupervisor - orchestrates processing loop
- DigestCoordinator - processes files through digesters

**Digesters:**
1. `doc-to-screenshot` - Render document to image
2. `doc-to-markdown` - Convert doc to markdown
3. `image-captioning` - AI caption (Homelab)
4. `image-objects` - Object detection (Homelab)
5. `image-ocr` - OCR text extraction
6. `speech-recognition` - Whisper transcription
7. `speaker-embedding` - Speaker diarization
8. `speech-recognition-cleanup` - Transcript cleanup (OpenAI)
9. `speech-recognition-summary` - Summary (OpenAI)
10. `url-crawler` - Fetch and parse URLs
11. `url-crawl-summary` - Summarize crawled content (OpenAI)
12. `tags` - Generate tags (OpenAI)
13. `search-keyword` - Index to Meilisearch
14. `search-semantic` - Embed to Qdrant

**Messages received:**
| Type | Payload | Description |
|------|---------|-------------|
| `digest` | `{ filePath, reset? }` | Process file through digesters |
| `file-change` | `{ filePath, isNew, contentChanged }` | From FS worker |
| `shutdown` | - | Graceful shutdown |

**Messages sent:**
| Type | Payload | Description |
|------|---------|-------------|
| `ready` | - | Worker initialized |
| `digest-started` | `{ filePath }` | Processing started |
| `digest-complete` | `{ filePath, success }` | Processing finished |
| `shutdown-complete` | - | Shutdown done |

---

## SQLite Strategy

Each worker creates its own database connection. The `app/.server/db/` module provides all typed functions - only the connection initialization differs per worker.

```typescript
// Each worker calls once at startup
import { initDatabase } from '~/.server/db/client';
initDatabase();

// Then uses existing functions normally
import { getFileByPath, upsertFileRecord } from '~/.server/db/files';
```

**SQLite configuration for concurrent access:**
```sql
PRAGMA journal_mode = WAL;      -- Write-ahead logging
PRAGMA busy_timeout = 5000;     -- Wait up to 5s for locks
PRAGMA synchronous = NORMAL;    -- Balance durability/speed
```

---

## Message Flow

### File Upload
```mermaid
sequenceDiagram
    participant Client
    participant API as Main Thread
    participant DW as Digest Worker

    Client->>API: POST /api/inbox
    API->>API: saveToInbox()
    API->>DW: { type: 'digest', filePath }
    API-->>Client: 201 Created

    Note over DW: Processes async
    DW->>DW: DigestCoordinator.processFile()
```

### File Detected by Watcher
```mermaid
sequenceDiagram
    participant FS as Filesystem
    participant FW as FS Worker
    participant API as Main Thread
    participant DW as Digest Worker

    FS->>FW: chokidar 'add' event
    FW->>FW: upsertFileRecord()
    FW->>API: { type: 'inbox-changed' }
    FW->>DW: { type: 'file-change', filePath }
    API->>API: notificationService.notify()

    Note over DW: Processes async
    DW->>DW: DigestCoordinator.processFile()
```

---

## Startup Sequence

```mermaid
sequenceDiagram
    participant Server as Express Server
    participant Main as Main Thread
    participant FW as FS Worker
    participant DW as Digest Worker

    Server->>Main: initializeApp()
    Main->>Main: initDatabase()
    Main->>FW: new Worker('fs-worker.js')
    Main->>DW: new Worker('digest-worker.js')

    FW->>FW: initDatabase()
    FW->>FW: startFileSystemWatcher()
    FW->>FW: startPeriodicScanner()
    FW-->>Main: { type: 'ready' }

    DW->>DW: initDatabase()
    DW->>DW: initializeDigesters()
    DW->>DW: startDigestSupervisor()
    DW-->>Main: { type: 'ready' }

    Main->>Main: All workers ready
```

---

## File Structure

```
app/.server/
├── workers/
│   ├── fs-worker.ts        # FS worker entry point
│   ├── fs-client.ts        # Main thread client for FS worker
│   ├── digest-worker.ts    # Digest worker entry point
│   ├── digest-client.ts    # Main thread client for digest worker
│   └── types.ts            # Shared message types
├── db/
│   └── client.ts           # Updated for multi-connection
└── init.ts                 # Updated to start workers
```
