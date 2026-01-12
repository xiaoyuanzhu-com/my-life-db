# Filesystem Service Architecture

**Date:** 2026-01-12
**Status:** Design Document
**Related:** [FS Worker Optimization Plan](./fs-worker-optimization-plan.md)

---

## Overview

The Filesystem Service (`backend/fs/`) is the **single coordinator** for all filesystem operations in MyLifeDB. It replaces the current "worker" pattern with a proper service that handles read, write, delete, and metadata operations while maintaining concurrency safety and data consistency.

---

## Design Principles

### 1. **Single Entry Point, Parallel Execution**
- All filesystem operations go through `fs.Service`
- Operations on **different files** execute in parallel
- Operations on the **same file** are serialized via per-file locks
- No global serialization bottleneck

### 2. **Separation of Concerns**
```
FS Service Responsibilities:
✅ File CRUD operations (create, read, update, delete)
✅ Metadata computation (hash, text preview)
✅ Filesystem watching (fsnotify)
✅ Periodic scanning
✅ Database synchronization for file records
✅ Concurrency control (per-file locks)

NOT Responsible For:
❌ Digest processing (handled by digest.Service)
❌ Search indexing (handled by search.Service)
❌ Vector embeddings (handled by digest.Service → HAID)
❌ Authentication (handled by auth package)
```

### 3. **Dependency Injection**
```go
// FS Service depends on:
- db.Service      // Database operations
- notifications.Service  // SSE notifications

// Other services depend on FS:
- digest.Service  // Triggered by FS for new/changed files
- api.Router      // Uses FS for file operations
```

### 4. **Atomic Operations**
```go
// Before: Multi-step, non-atomic
os.WriteFile(path, data)           // Step 1
metadata := computeHash(path)      // Step 2
db.UpsertFile(record)              // Step 3
db.UpdateFileField("text_preview") // Step 4
notify.Send(event)                 // Step 5

// After: Single atomic operation
fs.WriteFile(ctx, WriteRequest{
    Path: path,
    Content: data,
    ComputeMetadata: true,
})
// Internally: write → metadata → single DB upsert → notify
```

---

## Architecture

### Module Structure

```
backend/fs/
├── service.go          # Main FS Service coordinator
├── operations.go       # File operations (Write, Read, Delete, Move)
├── metadata.go         # Hash + text preview computation
├── watcher.go          # fsnotify event handling
├── scanner.go          # Periodic directory scanning
├── locks.go            # Per-file locking mechanism
├── types.go            # Request/Response types
└── README.md           # Package documentation
```

### Service Interface

```go
package fs

import (
    "context"
    "io"
    "sync"

    "github.com/xiaoyuanzhu-com/my-life-db/db"
    "github.com/xiaoyuanzhu-com/my-life-db/notifications"
)

// Service coordinates all filesystem operations
type Service struct {
    // Configuration
    dataRoot string

    // Sub-components
    watcher   *Watcher
    scanner   *Scanner
    processor *MetadataProcessor

    // Dependencies (injected)
    db     *db.Service
    notify *notifications.Service

    // Concurrency control
    fileLocks     sync.Map  // map[string]*sync.Mutex
    processing    sync.Map  // map[string]bool (for duplicate detection)

    // Lifecycle
    stopChan chan struct{}
    wg       sync.WaitGroup
}

// NewService creates a new filesystem service
func NewService(cfg Config) *Service {
    s := &Service{
        dataRoot: cfg.DataRoot,
        db:       cfg.DB,
        notify:   cfg.Notify,
        stopChan: make(chan struct{}),
    }

    s.watcher = newWatcher(s)
    s.scanner = newScanner(s)
    s.processor = newMetadataProcessor(s)

    return s
}

// Start begins background processes (watching, scanning)
func (s *Service) Start() error

// Stop gracefully shuts down the service
func (s *Service) Stop() error

// WriteFile creates or updates a file with content
func (s *Service) WriteFile(ctx context.Context, req WriteRequest) (*WriteResult, error)

// ReadFile reads a file's content
func (s *Service) ReadFile(ctx context.Context, path string) (io.ReadCloser, error)

// DeleteFile removes a file from filesystem and database
func (s *Service) DeleteFile(ctx context.Context, path string) error

// MoveFile moves a file from src to dst
func (s *Service) MoveFile(ctx context.Context, src, dst string) error

// GetFileInfo retrieves file metadata
func (s *Service) GetFileInfo(ctx context.Context, path string) (*db.FileRecord, error)

// ProcessMetadata computes hash and text preview for existing file
func (s *Service) ProcessMetadata(ctx context.Context, path string) (*MetadataResult, error)

// ValidatePath checks if path is valid and not excluded
func (s *Service) ValidatePath(path string) error

// SetFileChangeHandler registers callback for file changes (used by digest service)
func (s *Service) SetFileChangeHandler(handler FileChangeHandler)
```

### Request/Response Types

```go
// WriteRequest specifies how to write a file
type WriteRequest struct {
    Path            string    // Relative path from data root
    Content         io.Reader // File content
    MimeType        string    // Optional, auto-detected if empty
    Source          string    // "api", "upload", "external" (for logging)
    ComputeMetadata bool      // Compute hash + preview immediately?
    Sync            bool      // Wait for metadata or async?
}

// WriteResult contains information about the write operation
type WriteResult struct {
    Record       *db.FileRecord // Database record
    IsNew        bool           // Was this a new file?
    HashComputed bool           // Was hash computed?
    Error        error          // Any non-fatal errors (e.g., metadata computation failed)
}

// MetadataResult contains computed file metadata
type MetadataResult struct {
    Hash        string  // SHA-256 hex
    TextPreview *string // First 60 lines of text (if applicable)
    Size        int64   // File size in bytes
}

// FileChangeEvent notifies about file system changes
type FileChangeEvent struct {
    FilePath       string
    IsNew          bool
    ContentChanged bool // Hash differs from previous
    Trigger        string // "fsnotify", "api", "scan"
}

// FileChangeHandler is called when files change (used by digest service)
type FileChangeHandler func(event FileChangeEvent)
```

---

## Core Operations

### Write Operation Flow

```go
func (s *Service) WriteFile(ctx context.Context, req WriteRequest) (*WriteResult, error) {
    // 1. Validate path
    if err := s.ValidatePath(req.Path); err != nil {
        return nil, err
    }

    // 2. Acquire per-file lock (allows concurrent writes to different files)
    mu := s.acquireFileLock(req.Path)
    mu.Lock()
    defer mu.Unlock()

    // 3. Get existing record (for change detection)
    existing, _ := s.db.Files.GetByPath(req.Path)

    // 4. Write to filesystem
    fullPath := filepath.Join(s.dataRoot, req.Path)
    if err := s.writeFileAtomic(fullPath, req.Content); err != nil {
        return nil, err
    }

    // 5. Compute metadata (if requested)
    var metadata *MetadataResult
    var metadataErr error

    if req.ComputeMetadata {
        if req.Sync {
            // Synchronous: compute now, block until done
            metadata, metadataErr = s.processor.ComputeMetadata(ctx, req.Path)
        } else {
            // Asynchronous: start computation, don't wait
            go s.processor.ComputeMetadata(context.Background(), req.Path)
        }
    }

    // 6. Create/update database record (SINGLE upsert with all fields)
    record := s.buildFileRecord(req.Path, existing, metadata)
    isNew, err := s.db.Files.Upsert(record)
    if err != nil {
        // Rollback: delete file if DB upsert failed
        os.Remove(fullPath)
        return nil, err
    }

    // 7. Detect content change
    contentChanged := s.detectContentChange(existing, metadata)

    // 8. Notify digest service if content changed
    if contentChanged && s.changeHandler != nil {
        s.changeHandler(FileChangeEvent{
            FilePath:       req.Path,
            IsNew:          isNew,
            ContentChanged: true,
            Trigger:        req.Source,
        })
    }

    // 9. Send SSE notification for text preview
    if metadata != nil && metadata.TextPreview != nil {
        s.notify.NotifyPreviewUpdated(req.Path, "text")
    }

    return &WriteResult{
        Record:       record,
        IsNew:        isNew,
        HashComputed: metadata != nil,
        Error:        metadataErr, // Non-fatal metadata errors
    }, nil
}
```

### Read Operation Flow

```go
func (s *Service) ReadFile(ctx context.Context, path string) (io.ReadCloser, error) {
    // 1. Validate path
    if err := s.ValidatePath(path); err != nil {
        return nil, err
    }

    // 2. Check file exists in database
    record, err := s.db.Files.GetByPath(path)
    if err != nil || record == nil {
        return nil, ErrFileNotFound
    }

    // 3. Open file from filesystem
    fullPath := filepath.Join(s.dataRoot, path)
    return os.Open(fullPath)
}
```

### Delete Operation Flow

```go
func (s *Service) DeleteFile(ctx context.Context, path string) error {
    // 1. Acquire lock
    mu := s.acquireFileLock(path)
    mu.Lock()
    defer mu.Unlock()

    // 2. Begin transaction
    return s.db.Transaction(func(tx *db.Tx) error {
        // 3. Delete from filesystem
        fullPath := filepath.Join(s.dataRoot, path)
        if err := os.Remove(fullPath); err != nil && !os.IsNotExist(err) {
            return err
        }

        // 4. Delete from database (in transaction)
        if err := tx.Files.Delete(path); err != nil {
            return err
        }

        // 5. Delete related records (digests, pins)
        if err := tx.Digests.DeleteForFile(path); err != nil {
            return err
        }

        if err := tx.Pins.Remove(path); err != nil {
            return err
        }

        return nil
    })

    // Transaction committed: all or nothing
}
```

---

## Concurrency Control

### Per-File Locking

```go
// locks.go

// acquireFileLock returns the mutex for a specific file path
// Each file has its own mutex, allowing parallel operations on different files
func (s *Service) acquireFileLock(path string) *sync.Mutex {
    muInterface, _ := s.fileLocks.LoadOrStore(path, &sync.Mutex{})
    return muInterface.(*sync.Mutex)
}

// releaseFileLock removes the lock for a file (garbage collection)
// Called after file is deleted
func (s *Service) releaseFileLock(path string) {
    s.fileLocks.Delete(path)
}

// isProcessing checks if file is currently being processed
func (s *Service) isProcessing(path string) bool {
    _, exists := s.processing.Load(path)
    return exists
}

// markProcessing marks a file as being processed
func (s *Service) markProcessing(path string) bool {
    _, loaded := s.processing.LoadOrStore(path, true)
    return !loaded // true if we got the mark
}

// unmarkProcessing removes processing mark
func (s *Service) unmarkProcessing(path string) {
    s.processing.Delete(path)
}
```

### Concurrency Examples

```go
// Example 1: Parallel writes to different files (✅ NO blocking)
go fs.WriteFile(ctx, WriteRequest{Path: "inbox/file1.txt", ...})
go fs.WriteFile(ctx, WriteRequest{Path: "inbox/file2.txt", ...})
go fs.WriteFile(ctx, WriteRequest{Path: "inbox/file3.txt", ...})
// All three execute concurrently

// Example 2: Sequential operations on same file (✅ Properly serialized)
go fs.WriteFile(ctx, WriteRequest{Path: "inbox/file1.txt", ...})
go fs.WriteFile(ctx, WriteRequest{Path: "inbox/file1.txt", ...})
// Second call waits for first to complete

// Example 3: Write + Delete same file (✅ Properly serialized)
go fs.WriteFile(ctx, WriteRequest{Path: "inbox/file1.txt", ...})
go fs.DeleteFile(ctx, "inbox/file1.txt")
// Delete waits for write to complete

// Example 4: Scan + API write (✅ Deduplication)
go fs.scanner.ScanDirectory(dataRoot)  // Discovers file1.txt
go fs.WriteFile(ctx, WriteRequest{Path: "inbox/file1.txt", ...})
// First to acquire lock processes, second detects already processing and skips
```

---

## Background Processes

### Filesystem Watcher (fsnotify)

```go
// watcher.go

type Watcher struct {
    service  *Service
    watcher  *fsnotify.Watcher
    stopChan chan struct{}
}

func (w *Watcher) Start() error {
    // Watch data directory recursively
    w.watchRecursive(w.service.dataRoot)

    // Process events
    go w.eventLoop()
}

func (w *Watcher) eventLoop() {
    for {
        select {
        case event := <-w.watcher.Events:
            w.handleEvent(event)
        case <-w.stopChan:
            return
        }
    }
}

func (w *Watcher) handleEvent(event fsnotify.Event) {
    relPath := toRelativePath(event.Name)

    // Skip excluded paths
    if w.service.isExcluded(relPath) {
        return
    }

    // Handle based on event type
    switch {
    case event.Op&fsnotify.Create != 0:
        w.handleCreate(relPath)
    case event.Op&fsnotify.Write != 0:
        w.handleWrite(relPath)
    case event.Op&fsnotify.Remove != 0:
        w.handleDelete(relPath)
    case event.Op&fsnotify.Rename != 0:
        w.handleRename(relPath)
    }
}

func (w *Watcher) handleCreate(path string) {
    // Check if already processing (API might have just created it)
    if w.service.isProcessing(path) {
        log.Debug().Str("path", path).Msg("file already being processed, skipping fsnotify create event")
        return
    }

    // Process external file creation (e.g., AirDrop)
    w.service.processExternalFile(path, "fsnotify")
}
```

### Periodic Scanner

```go
// scanner.go

type Scanner struct {
    service  *Service
    interval time.Duration
    stopChan chan struct{}
}

func (s *Scanner) Start() error {
    // Initial scan after 10 seconds
    time.AfterFunc(10*time.Second, func() {
        s.scan()
    })

    // Periodic scans every hour
    ticker := time.NewTicker(s.interval)
    go func() {
        for {
            select {
            case <-ticker.C:
                s.scan()
            case <-s.stopChan:
                return
            }
        }
    }()
}

func (s *Scanner) scan() {
    log.Info().Msg("starting periodic filesystem scan")

    var filesToProcess []string

    // 1. Walk filesystem
    filepath.Walk(s.service.dataRoot, func(path string, info os.FileInfo, err error) error {
        if err != nil || info.IsDir() {
            return nil
        }

        relPath := toRelativePath(path)

        // Skip excluded paths
        if s.service.isExcluded(relPath) {
            return nil
        }

        // Check if file needs processing
        needsProcessing := s.checkNeedsProcessing(relPath, info)
        if needsProcessing {
            filesToProcess = append(filesToProcess, relPath)
        }

        return nil
    })

    // 2. Process files that need updates (in parallel with bounded concurrency)
    log.Info().Int("count", len(filesToProcess)).Msg("processing files needing updates")

    // Use worker pool to limit concurrency (e.g., 10 at a time)
    sem := make(chan struct{}, 10)
    var wg sync.WaitGroup

    for _, path := range filesToProcess {
        wg.Add(1)
        go func(p string) {
            defer wg.Done()
            sem <- struct{}{}        // Acquire
            defer func() { <-sem }() // Release

            s.service.ProcessMetadata(context.Background(), p)
        }(path)
    }

    wg.Wait()
    log.Info().Msg("periodic scan complete")
}

func (s *Scanner) checkNeedsProcessing(path string, info os.FileInfo) bool {
    // Get database record
    record, err := s.service.db.Files.GetByPath(path)
    if err != nil {
        return true // File not in DB, needs processing
    }

    // Check if hash is missing
    if record.Hash == nil || *record.Hash == "" {
        return true
    }

    // Check if modified_at differs (file changed externally)
    fileModTime := info.ModTime().UTC().Format(time.RFC3339)
    if record.ModifiedAt != fileModTime {
        return true
    }

    // Check if text preview is missing (and file type supports it)
    if record.TextPreview == nil && isTextFile(path) {
        return true
    }

    return false // File is up to date
}
```

---

## Metadata Processing

### Hash Computation

```go
// metadata.go

type MetadataProcessor struct {
    service *Service
}

func (p *MetadataProcessor) ComputeMetadata(ctx context.Context, path string) (*MetadataResult, error) {
    fullPath := filepath.Join(p.service.dataRoot, path)

    file, err := os.Open(fullPath)
    if err != nil {
        return nil, err
    }
    defer file.Close()

    info, err := file.Stat()
    if err != nil {
        return nil, err
    }

    // Compute hash and text preview concurrently
    hashChan := make(chan string, 1)
    previewChan := make(chan *string, 1)
    errChan := make(chan error, 2)

    // Hash computation
    go func() {
        hash, err := computeHash(file)
        if err != nil {
            errChan <- err
            return
        }
        hashChan <- hash
    }()

    // Text preview computation (if applicable)
    go func() {
        if !isTextFile(path) {
            previewChan <- nil
            return
        }

        file.Seek(0, 0) // Reset file pointer
        preview, err := extractTextPreview(file)
        if err != nil {
            errChan <- err
            return
        }
        previewChan <- preview
    }()

    // Wait for results
    select {
    case err := <-errChan:
        return nil, err
    case hash := <-hashChan:
        preview := <-previewChan
        return &MetadataResult{
            Hash:        hash,
            TextPreview: preview,
            Size:        info.Size(),
        }, nil
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

func computeHash(r io.Reader) (string, error) {
    h := sha256.New()
    if _, err := io.Copy(h, r); err != nil {
        return "", err
    }
    return hex.EncodeToString(h.Sum(nil)), nil
}

func extractTextPreview(r io.Reader) (*string, error) {
    // Read first 10MB or until 60 lines
    const maxBytes = 10 * 1024 * 1024
    const maxLines = 60

    limited := io.LimitReader(r, maxBytes)
    scanner := bufio.NewScanner(limited)

    var lines []string
    for scanner.Scan() && len(lines) < maxLines {
        lines = append(lines, scanner.Text())
    }

    if len(lines) == 0 {
        return nil, nil
    }

    preview := strings.Join(lines, "\n")
    return &preview, nil
}

func isTextFile(path string) bool {
    ext := strings.ToLower(filepath.Ext(path))
    textExts := []string{".txt", ".md", ".json", ".yaml", ".yml", ".log", ".csv"}

    for _, textExt := range textExts {
        if ext == textExt {
            return true
        }
    }

    return false
}
```

---

## Integration with Other Services

### Digest Service Integration

```go
// The digest service registers a callback with the FS service
func (ds *digest.Service) Start() error {
    // Register for file change notifications
    ds.fsService.SetFileChangeHandler(func(event fs.FileChangeEvent) {
        if event.IsNew || event.ContentChanged {
            ds.queueForProcessing(event.FilePath)
        }
    })

    return nil
}
```

### API Handler Integration

```go
// api/inbox.go (BEFORE)
func CreateTextFile(c *gin.Context) {
    // Direct filesystem + DB operations
    os.WriteFile(fullPath, data)
    db.UpsertFile(...)
    fsWorker.ProcessFile(path) // Async
}

// api/inbox.go (AFTER)
func CreateTextFile(c *gin.Context) {
    // Single call to FS service
    result, err := fsService.WriteFile(c.Request.Context(), fs.WriteRequest{
        Path:            req.Path,
        Content:         strings.NewReader(req.Content),
        Source:          "api",
        ComputeMetadata: false, // Compute async
        Sync:            false,
    })

    if err != nil {
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }

    c.JSON(200, result.Record)
}
```

---

## Error Handling

### Retry Strategy

```go
// Retry metadata computation with exponential backoff
func (s *Service) scheduleMetadataRetry(path string, attempt int) {
    if attempt > 5 {
        log.Error().Str("path", path).Msg("metadata computation failed after 5 attempts, giving up")

        // Mark as permanently failed
        s.db.Files.UpdateField(path, "hash_failed_at", db.NowUTC())
        return
    }

    // Exponential backoff: 1min, 2min, 4min, 8min, 16min
    delay := time.Duration(1<<uint(attempt-1)) * time.Minute

    time.AfterFunc(delay, func() {
        _, err := s.ProcessMetadata(context.Background(), path)
        if err != nil {
            s.scheduleMetadataRetry(path, attempt+1)
        }
    })
}
```

### Partial Failures

```go
// WriteFile returns success even if metadata computation fails
result, err := fs.WriteFile(ctx, req)
if err != nil {
    // Critical error: file not written
    return err
}

if result.Error != nil {
    // Non-critical: file written but metadata computation failed
    log.Warn().Err(result.Error).Str("path", req.Path).Msg("metadata computation failed, will retry")
    fs.scheduleMetadataRetry(req.Path, 1)
}

return result.Record // File is usable, metadata will be computed later
```

---

## Testing Strategy

### Unit Tests

```go
// service_test.go
func TestWriteFileConcurrency(t *testing.T) {
    fs := NewService(testConfig())

    // Write same file 100 times concurrently
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func(n int) {
            defer wg.Done()
            fs.WriteFile(ctx, WriteRequest{
                Path:    "test.txt",
                Content: strings.NewReader(fmt.Sprintf("content-%d", n)),
            })
        }(i)
    }
    wg.Wait()

    // Verify: file exists with one of the contents
    record, _ := fs.GetFileInfo(ctx, "test.txt")
    assert.NotNil(t, record)
    assert.NotNil(t, record.Hash)
}

func TestMetadataPreservation(t *testing.T) {
    fs := NewService(testConfig())

    // Write file with metadata
    fs.WriteFile(ctx, WriteRequest{
        Path:            "test.txt",
        Content:         strings.NewReader("hello world"),
        ComputeMetadata: true,
        Sync:            true,
    })

    // Get record
    record, _ := fs.GetFileInfo(ctx, "test.txt")
    originalHash := *record.Hash
    originalPreview := *record.TextPreview

    // Trigger scan (should NOT overwrite metadata)
    fs.scanner.scan()

    // Verify metadata preserved
    record, _ = fs.GetFileInfo(ctx, "test.txt")
    assert.Equal(t, originalHash, *record.Hash)
    assert.Equal(t, originalPreview, *record.TextPreview)
}
```

### Integration Tests

```go
// integration_test.go
func TestFileLifecycle(t *testing.T) {
    // Setup services
    dbSvc := db.NewService(testDataDir)
    notifySvc := notifications.NewService()
    fsSvc := fs.NewService(fs.Config{
        DataRoot: testDataDir,
        DB:       dbSvc,
        Notify:   notifySvc,
    })

    // 1. Write file
    result, err := fsSvc.WriteFile(ctx, fs.WriteRequest{
        Path:            "test.txt",
        Content:         strings.NewReader("hello world"),
        ComputeMetadata: true,
        Sync:            true,
    })
    assert.NoError(t, err)
    assert.True(t, result.IsNew)
    assert.True(t, result.HashComputed)

    // 2. Read file
    reader, err := fsSvc.ReadFile(ctx, "test.txt")
    assert.NoError(t, err)
    content, _ := io.ReadAll(reader)
    assert.Equal(t, "hello world", string(content))

    // 3. Update file
    result, err = fsSvc.WriteFile(ctx, fs.WriteRequest{
        Path:            "test.txt",
        Content:         strings.NewReader("updated content"),
        ComputeMetadata: true,
        Sync:            true,
    })
    assert.NoError(t, err)
    assert.False(t, result.IsNew)

    // 4. Delete file
    err = fsSvc.DeleteFile(ctx, "test.txt")
    assert.NoError(t, err)

    // 5. Verify deletion
    _, err = fsSvc.GetFileInfo(ctx, "test.txt")
    assert.Error(t, err)
}
```

---

## Migration Path

### Phase 1: Create Service Interface (Non-Breaking)
```
✅ Create backend/fs/ directory structure
✅ Implement Service with all methods
✅ Keep existing workers/fs/ functioning
✅ Add feature flag to switch between old/new
```

### Phase 2: Migrate API Handlers
```
✅ Update api/inbox.go to use fs.Service
✅ Update api/files.go to use fs.Service
✅ Update api/upload.go to use fs.Service
✅ Test each migration thoroughly
```

### Phase 3: Migrate Digest Service
```
✅ Update digest.Service to use fs.Service for file reads
✅ Remove direct filesystem access from digest workers
```

### Phase 4: Deprecate Old Worker
```
✅ Remove workers/fs/ directory
✅ Remove feature flag
✅ Update all imports
```

---

## Known Issues & TODOs

### Critical Issues (Must Fix During Refactor)

#### 1. ✅ text_preview Data Loss (FIXED)
**Status:** Fixed in `db/files.go` line 165
**Issue:** `BatchUpsertFiles` was missing `text_preview` in ON CONFLICT clause, causing periodic scans to NULL out text previews
**Verification Needed:** Test that periodic scans preserve text_preview after refactor

#### 2. Race Condition in Hash Computation and Digest Triggering
**File:** `workers/fs/worker.go:267-378`
**Issue:** Hash change detection reads old hash, computes new hash, then checks for changes - but another goroutine could update hash in between
**Fix in Refactor:** Per-file locking eliminates this race condition

#### 3. text_preview Update Race Condition
**Files:** `workers/fs/worker.go:342-353`, `514-525`
**Issue:** text_preview updated in separate DB call after UpsertFile
**Fix in Refactor:** Single atomic upsert with ALL fields including text_preview

#### 4. BatchUpsertFiles Race Condition
**File:** `db/files.go:120-189`
**Issue:** Checks for existing files OUTSIDE transaction
**Fix in Refactor:** Move existence check inside transaction or use CTE

#### 5. Missing Hash in scanDirectory Initial Upsert
**File:** `workers/fs/worker.go:429-504`
**Issue:** Files upserted twice: first without hash, then with hash
**Fix in Refactor:** Single upsert with all metadata computed beforehand

### Design Issues (Address During Refactor)

#### 6. Inconsistent text_preview Handling Pattern
**Issue:** Three different patterns across API uploads, FS events, and scans
**Fix in Refactor:** Single `WriteFile` method with consistent behavior

#### 7. Fragile Hash Change Detection
**Issue:** `oldHash == ""` means both "file is new" and "hash computation failed"
**Fix in Refactor:** Explicit state tracking with `hash_failed_at` field

#### 8. Duplicate File Processing in scanDirectory
**Issue:** New files get upserted twice
**Fix in Refactor:** Eliminated by single-pass processing

#### 9. text_preview Overwrite Bug in scanDirectory
**Issue:** Second UpsertFile NULLs out text_preview
**Fix in Refactor:** Single upsert pattern eliminates this

### Race Conditions (Eliminate During Refactor)

#### 10. Multiple Concurrent ProcessFile Calls
**Issue:** No synchronization between API, FS watcher, and scans
**Fix in Refactor:** Per-file locks + processing marks

#### 11. UpsertFile isNewInsert Race Window
**Issue:** Checks if file exists OUTSIDE transaction
**Fix in Refactor:** Wrap in transaction or accept eventual consistency

#### 12. handleEvent Directory/File Race
**Issue:** Calls os.Stat() twice on same file
**Fix in Refactor:** Single stat call in new event handling

### Data Consistency (Improve During Refactor)

#### 13. Missing Hash Computation Fallback
**Issue:** If hash computation fails, never retried
**Fix in Refactor:** Add retry mechanism with exponential backoff

#### 14. screenshot_sqlar Handling Fragility
**Issue:** Relies on implicit SQLite preservation
**Fix in Refactor:** Explicit COALESCE or separate update function

### Architectural Improvements (Implement During Refactor)

#### 15. No Atomicity Between File Metadata and Database
**Issue:** Process crashes leave inconsistent state
**Fix in Refactor:** Add reconciliation job, health checks

#### 16. Cascading Updates from Separate text_preview Updates
**Issue:** Multiple writes for single logical operation
**Fix in Refactor:** Single atomic upsert eliminates this

#### 17. No Idempotency Guarantees
**Issue:** Repeated operations have undefined behavior
**Fix in Refactor:** Document and enforce idempotency contracts

#### 18. Missing Transactional Boundaries
**Issue:** Partial failures leave inconsistent state
**Fix in Refactor:** Wrap operations in transactions where appropriate

### Post-Refactor Verification Tasks

- [ ] Run full test suite with new fs.Service
- [ ] Verify no text_preview data loss during scans
- [ ] Load test with 1000 concurrent file uploads
- [ ] Verify no race conditions in hash computation
- [ ] Test external file addition (AirDrop) detection
- [ ] Verify digest processing triggered correctly
- [ ] Test metadata retry mechanism
- [ ] Verify transaction rollbacks work correctly
- [ ] Performance benchmark vs old worker implementation
- [ ] Memory usage analysis (check for lock leaks)

---

## Performance Considerations

### Concurrent Operations
```
Old: Sequential scan → 10,000 files × 100ms = 1000 seconds
New: Parallel scan → 10,000 files / 10 workers × 100ms = 100 seconds
```

### Per-File Locking Overhead
```
Lock acquisition: ~100ns (sync.Map lookup)
Lock contention: Only for same file (rare)
Memory: ~100 bytes per file being processed
```

### Metadata Computation
```
Small files (<1MB): ~10ms (hash + preview)
Large files (>100MB): ~1000ms (streaming hash)
Text preview: First 60 lines or 10MB (whichever comes first)
```

---

## Monitoring & Observability

### Metrics to Add
```go
// Operation counters
fs_operations_total{operation="write|read|delete", status="success|error"}

// Concurrency metrics
fs_locks_active{} // Number of files currently locked
fs_processing_active{} // Number of files being processed

// Performance metrics
fs_operation_duration_seconds{operation="write|read|delete"}
fs_metadata_computation_duration_seconds{}

// Error metrics
fs_metadata_failures_total{reason="hash_failed|preview_failed"}
fs_retry_attempts_total{operation="metadata"}
```

### Logging
```go
// Structured logging with zerolog
log.Info().
    Str("operation", "write").
    Str("path", path).
    Int64("size", size).
    Bool("is_new", isNew).
    Dur("duration", duration).
    Msg("file written successfully")

log.Error().
    Err(err).
    Str("operation", "metadata").
    Str("path", path).
    Int("retry_attempt", attempt).
    Msg("metadata computation failed")
```

---

## Security Considerations

### Path Validation
```go
// Prevent directory traversal attacks
func (s *Service) ValidatePath(path string) error {
    // No absolute paths
    if filepath.IsAbs(path) {
        return ErrInvalidPath
    }

    // No .. components
    if strings.Contains(path, "..") {
        return ErrInvalidPath
    }

    // No leading /
    if strings.HasPrefix(path, "/") {
        return ErrInvalidPath
    }

    // Check against exclusion patterns
    if s.isExcluded(path) {
        return ErrExcludedPath
    }

    return nil
}
```

### File Size Limits
```go
// Enforce max file size in WriteFile
const MaxFileSize = 10 * 1024 * 1024 * 1024 // 10GB

func (s *Service) WriteFile(ctx context.Context, req WriteRequest) (*WriteResult, error) {
    // Wrap reader with size limiter
    limited := io.LimitReader(req.Content, MaxFileSize+1)

    // Write and check size
    n, err := writeToFile(limited)
    if n > MaxFileSize {
        return nil, ErrFileTooLarge
    }

    // ...
}
```

---

## Conclusion

The new Filesystem Service architecture provides:

✅ **Single entry point** for all filesystem operations
✅ **Concurrent execution** without serialization bottleneck
✅ **Atomic operations** eliminating race conditions
✅ **Consistent patterns** across all code paths
✅ **Proper error handling** with retry mechanisms
✅ **Testable design** with clear interfaces
✅ **Observability** with metrics and structured logging

This design eliminates all 18 known issues while maintaining high performance and setting the foundation for future scalability.
