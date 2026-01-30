# Digest System

The digest system processes files to extract content, metadata, and generate embeddings.

## Architecture

```
File Change Event
    ↓
Digest Worker (3 parallel goroutines)
    ↓
Digester Registry (selects appropriate digester)
    ↓
├── Markdown Digester
├── PDF Digester
├── EPUB Digester
└── Image Digester (vision API)
    ↓
Store results in database
    ↓
Notify UI via SSE
```

## Key Components

| Location | Purpose |
|----------|---------|
| `backend/workers/digest/worker.go` | Worker pool, queue management |
| `backend/workers/digest/registry.go` | Digester plugin registry |
| `backend/workers/digest/digesters/` | Individual digester implementations |
| `backend/db/digests.go` | Database operations for digests |

## Worker Architecture

```go
type Worker struct {
    db          *db.DB
    notif       *notifications.Service
    queue       chan string        // File paths to process
    digesters   []Digester         // Registered digesters
}
```

The worker runs 3 parallel goroutines that pull from the queue.

### Event Flow

```go
// FS Service detects file change
fsService.SetFileChangeHandler(func(event FileChangeEvent) {
    digestWorker.OnFileChange(event.Path, event.Type)
})

// Worker queues the file
func (w *Worker) OnFileChange(path string, eventType string) {
    select {
    case w.queue <- path:
        // Queued successfully
    default:
        log.Warn().Msg("digest queue full")
    }
}
```

## Digester Interface

```go
type Digester interface {
    // Name returns the digester identifier
    Name() string

    // CanDigest returns true if this digester handles the file
    CanDigest(path string, mimeType string) bool

    // Digest processes the file and returns results
    Digest(ctx context.Context, path string) (*DigestResult, error)
}

type DigestResult struct {
    Content    string            // Extracted text content
    Metadata   map[string]any    // File-specific metadata
    Embeddings []float32         // Optional vector embeddings
}
```

## Registry Pattern

Digesters register themselves at init time:

```go
// backend/workers/digest/digesters/markdown.go
func init() {
    digest.RegisterDigester(&MarkdownDigester{})
}

// backend/workers/digest/registry.go
func RegisterDigester(d Digester) {
    registry = append(registry, d)
}

func GetDigesterFor(path, mimeType string) Digester {
    for _, d := range registry {
        if d.CanDigest(path, mimeType) {
            return d
        }
    }
    return nil
}
```

## Adding a New Digester

1. Create file in `backend/workers/digest/digesters/`
2. Implement the `Digester` interface
3. Register via `init()` function
4. Import in `backend/workers/digest/digesters/init.go`

Example:

```go
// backend/workers/digest/digesters/docx.go
package digesters

import "mylifedb/backend/workers/digest"

type DocxDigester struct{}

func init() {
    digest.RegisterDigester(&DocxDigester{})
}

func (d *DocxDigester) Name() string {
    return "docx"
}

func (d *DocxDigester) CanDigest(path, mimeType string) bool {
    return strings.HasSuffix(path, ".docx") ||
           mimeType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}

func (d *DocxDigester) Digest(ctx context.Context, path string) (*digest.DigestResult, error) {
    // Extract text from docx
    // Return DigestResult
}
```

## Database Schema

```sql
CREATE TABLE digests (
    file_path TEXT PRIMARY KEY,
    digester TEXT,           -- Which digester processed this
    content TEXT,            -- Extracted text
    metadata TEXT,           -- JSON metadata
    status TEXT,             -- pending, processing, completed, failed
    error TEXT,              -- Error message if failed
    created_at DATETIME,
    updated_at DATETIME
);
```

## Supervisor

A supervisor goroutine ensures pending digests eventually get processed:

```go
// Periodically checks for pending digests
// Re-queues files that were missed or failed
func (w *Worker) runSupervisor() {
    ticker := time.NewTicker(5 * time.Minute)
    for {
        select {
        case <-ticker.C:
            w.requeuePending()
        case <-w.ctx.Done():
            return
        }
    }
}
```

## Common Modifications

### Modifying digest output format
- Update `DigestResult` struct
- Update database schema if adding new fields
- Update queries in `db/digests.go`

### Adding metadata extraction
- Modify the relevant digester's `Digest()` method
- Add fields to `Metadata` map
- Frontend can access via API

### Changing processing priority
- Currently FIFO via channel
- For priority queue, replace channel with heap-based queue
