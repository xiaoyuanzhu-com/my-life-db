# Filesystem Service

The FS service monitors the user's data directory for changes and triggers downstream processing.

## Architecture

```
User Data Directory
    ↓
┌─────────────────────────────────┐
│         FS Service              │
├─────────────────────────────────┤
│  Watcher (fsnotify, real-time)  │
│  Scanner (periodic, hourly)     │
│  Validator (path/name rules)    │
│  Processor (metadata extraction)│
└─────────────────────────────────┘
    ↓
FileChangeEvent callback
    ↓
├── Digest Worker
└── Notifications Service
```

## Key Components

| Location | Purpose |
|----------|---------|
| `backend/fs/service.go` | Main service, coordinates components |
| `backend/fs/watcher.go` | fsnotify wrapper for real-time changes |
| `backend/fs/scanner.go` | Periodic full directory scan |
| `backend/fs/validator.go` | Path and filename validation |
| `backend/fs/processor.go` | Basic metadata extraction |

## Service Structure

```go
type Service struct {
    cfg          *Config
    db           DBAdapter        // Database interface (not direct *db.DB)
    validator    *Validator
    processor    *Processor
    watcher      *Watcher
    scanner      *Scanner

    changeHandler func(FileChangeEvent)  // Callback for downstream
}
```

## Event Types

```go
type FileChangeEvent struct {
    Path      string    // Relative path from data root
    Type      string    // "create", "modify", "delete"
    Timestamp time.Time
}
```

## Callback Pattern

The service doesn't directly call digest worker or notifications. Instead, a callback is set during server initialization:

```go
// backend/server/server.go
s.fsService.SetFileChangeHandler(func(event fs.FileChangeEvent) {
    s.digestWorker.OnFileChange(event.Path, event.Type)
    if isInboxPath(event.Path) {
        s.notifService.NotifyInboxChanged()
    }
})
```

**DO**: Use the callback for downstream actions
**DON'T**: Import digest worker or notifications directly in fs package

## Watcher (Real-time)

Uses fsnotify to detect file changes immediately:

```go
func (w *Watcher) Start() {
    w.watcher.Add(w.dataDir)  // Watch root
    // Recursively add subdirectories

    for {
        select {
        case event := <-w.watcher.Events:
            w.handleEvent(event)
        case err := <-w.watcher.Errors:
            log.Error().Err(err).Msg("watcher error")
        case <-w.ctx.Done():
            return
        }
    }
}
```

### Debouncing

Rapid file changes are debounced to avoid redundant processing:

```go
// Multiple rapid writes to same file → single event after 100ms quiet period
```

## Scanner (Periodic)

Catches changes that watcher might miss (network drives, external modifications):

```go
func (s *Scanner) Start() {
    ticker := time.NewTicker(1 * time.Hour)
    for {
        select {
        case <-ticker.C:
            s.scanAll()
        case <-s.ctx.Done():
            return
        }
    }
}

func (s *Scanner) scanAll() {
    filepath.WalkDir(s.dataDir, func(path string, d fs.DirEntry, err error) error {
        // Check if file is new or modified since last scan
        // Emit FileChangeEvent if needed
    })
}
```

## Validator

Validates paths and filenames before processing:

```go
func (v *Validator) IsValidPath(path string) bool {
    // No path traversal (..)
    // No hidden files (starting with .)
    // Within allowed directories
}

func (v *Validator) IsValidFilename(name string) bool {
    // No special characters
    // Reasonable length
}
```

## Database Adapter

The FS service uses an interface instead of direct db.DB dependency:

```go
type DBAdapter interface {
    GetFileByPath(path string) (*models.File, error)
    UpsertFile(file *models.File) error
    DeleteFile(path string) error
}
```

This allows testing without a real database.

## Common Modifications

### Adding new watched directories
- Update `Config` in `backend/fs/config.go`
- Add directory to watcher in `watcher.go`

### Changing scan interval
- Modify ticker duration in `scanner.go`
- Consider making configurable via environment variable

### Adding file type filtering
- Modify `validator.go` to add extension checks
- Or filter in the change handler callback

### Handling new event types
- Add case in `watcher.handleEvent()`
- Extend `FileChangeEvent.Type` if needed
- Update callback handler in server.go

## Files to Modify

| Task | Files |
|------|-------|
| Change watch behavior | `backend/fs/watcher.go` |
| Change scan behavior | `backend/fs/scanner.go` |
| Add validation rules | `backend/fs/validator.go` |
| Modify event handling | `backend/server/server.go` (callback) |
