# File System Worker & Database Files Module - Optimization Plan

**Date:** 2026-01-12
**Status:** Analysis Complete, Implementation Pending

---

## Executive Summary

The FS worker and database files module contain **18 identified issues** ranging from critical race conditions to design fragility. The root cause is a **multi-step, non-atomic pattern** for file processing that creates consistency windows and race conditions.

**Most Critical Issue:** The `text_preview` separate update pattern (Issues #2, #3, #9) causes data loss during periodic scans and creates race conditions.

---

## Critical Bugs (Must Fix)

### 1. Race Condition in Hash Computation and Digest Triggering
**File:** `backend/workers/fs/worker.go:267-378` (createFileRecord)

**Problem:** Hash change detection reads old hash, computes new hash, then checks for changes - but another goroutine could update the hash in between, causing incorrect digest triggering.

**Impact:** High - Digest processing may not trigger when files actually change

**Fix:**
```go
// Option A: Use transaction with SELECT FOR UPDATE
tx, _ := db.GetDB().Begin()
existing := getFileByPathForUpdate(tx, relPath) // Lock row
metadata := ProcessFileMetadata(relPath)
contentChanged := existing.Hash != metadata.Hash
upsertInTransaction(tx, record)
tx.Commit()
if contentChanged {
    w.onChange(...)
}

// Option B: Use atomic compare-and-swap pattern
// Store old hash in a separate field, update both atomically
```

---

### 2. text_preview Update Race Condition ⭐ **HIGHEST PRIORITY**
**Files:**
- `backend/workers/fs/worker.go:342-353` (createFileRecord)
- `backend/workers/fs/worker.go:514-525` (scanDirectory)

**Problem:** `text_preview` is updated in a separate DB call after `UpsertFile`, creating a window where:
1. File exists with hash but no text_preview
2. Another process could read incomplete data
3. Failed updates leave file permanently without text_preview
4. Periodic scans NULL out text_preview, then restore it (causes the bug you just experienced)

**Impact:** Critical - Causes periodic data loss, user-visible bugs

**Fix:**
```go
// Compute metadata first, THEN upsert with everything
metadata, err := ProcessFileMetadata(relPath)
if err != nil {
    return err
}

// Single atomic upsert with ALL fields
_, err = db.UpsertFile(&db.FileRecord{
    Path:         relPath,
    Hash:         &metadata.Hash,
    TextPreview:  metadata.TextPreview, // Include in upsert!
    // ... other fields
})

// Remove separate UpdateFileField call
```

**Additional Change Required in `db/files.go`:**
- Ensure `text_preview = excluded.text_preview` is in ON CONFLICT clause ✅ (already fixed)
- Remove the two-step update pattern everywhere

---

### 3. text_preview Overwrite Bug in scanDirectory
**File:** `backend/workers/fs/worker.go:494-504`

**Problem:** Second `UpsertFile` in `scanDirectory` doesn't include text_preview, causing ON CONFLICT to set it to NULL.

**Impact:** High - Causes data loss during periodic scans

**Fix:** See fix for Issue #2 above (same root cause)

---

### 4. BatchUpsertFiles Race Condition
**File:** `backend/db/files.go:120-189`

**Problem:** Checks for existing files OUTSIDE the transaction, then uses that info INSIDE transaction. Another process could insert files in between.

**Impact:** Medium - Incorrect `newInserts` list sent to digest worker

**Fix:**
```go
func BatchUpsertFiles(records []*FileRecord) (newInserts []string, err error) {
    tx, err := GetDB().Begin()
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    // Create temp table with new records
    _, err = tx.Exec(`CREATE TEMP TABLE IF NOT EXISTS new_files_temp (
        path TEXT PRIMARY KEY,
        ...
    )`)

    // Insert all new records into temp table
    // ...

    // Identify truly new files in single query
    rows, err := tx.Query(`
        SELECT t.path
        FROM new_files_temp t
        LEFT JOIN files f ON t.path = f.path
        WHERE f.path IS NULL
    `)
    // Collect newInserts

    // Batch upsert from temp table
    _, err = tx.Exec(`
        INSERT INTO files SELECT * FROM new_files_temp
        ON CONFLICT(path) DO UPDATE SET ...
    `)

    // Drop temp table
    tx.Exec(`DROP TABLE new_files_temp`)

    return newInserts, tx.Commit()
}
```

---

### 5. Missing Hash in scanDirectory Initial Upsert
**File:** `backend/workers/fs/worker.go:429-504`

**Problem:** Files are upserted twice: first without hash, then with hash. Second upsert triggers ON CONFLICT unnecessarily and can cause timestamp/data issues.

**Impact:** Medium - Inefficient, creates consistency windows

**Fix:**
```go
// Option A: Compute hash before batch upsert (slower but atomic)
var records []*db.FileRecord
for _, fileInfo := range files {
    metadata := ProcessFileMetadata(relPath)
    records = append(records, &db.FileRecord{
        Hash: &metadata.Hash,
        TextPreview: metadata.TextPreview,
        // ...
    })
}
db.BatchUpsertFiles(records)

// Option B: Only compute hash for new files (faster)
newInserts, _ := db.BatchUpsertFiles(basicRecords)
for _, newPath := range newInserts {
    // Compute and update hash only for new files
}
```

---

## Design Issues (High Priority)

### 6. Inconsistent text_preview Handling Pattern
**Files:** Multiple locations

**Problem:** Three different patterns for handling text_preview across API uploads, FS events, and scans.

**Impact:** High - Makes system hard to reason about, prone to bugs

**Fix:** Create unified file processing function:
```go
// ProcessFileComplete handles ALL file processing consistently
func (w *Worker) ProcessFileComplete(relPath string, trigger string) (*ProcessResult, error) {
    // 1. Check if already processing (prevent concurrent access)
    if !w.acquireProcessingLock(relPath) {
        return nil, ErrAlreadyProcessing
    }
    defer w.releaseProcessingLock(relPath)

    // 2. Get existing record
    existing, _ := db.GetFileByPath(relPath)

    // 3. Compute metadata (hash + text preview)
    metadata, err := ProcessFileMetadata(relPath)
    if err != nil {
        return nil, err
    }

    // 4. Single atomic upsert with ALL fields
    isNew, err := db.UpsertFile(&db.FileRecord{
        Path:         relPath,
        Hash:         &metadata.Hash,
        TextPreview:  metadata.TextPreview,
        // ...
    })

    // 5. Determine if content changed
    contentChanged := existing == nil ||
                      existing.Hash == nil ||
                      *existing.Hash != metadata.Hash

    // 6. Trigger digest if needed
    if contentChanged && w.onChange != nil {
        w.onChange(FileChangeEvent{
            FilePath:       relPath,
            IsNew:          isNew,
            ContentChanged: contentChanged,
        })
    }

    // 7. Send notification
    if metadata.TextPreview != nil {
        notifications.GetService().NotifyPreviewUpdated(relPath, "text")
    }

    return &ProcessResult{
        IsNew:          isNew,
        ContentChanged: contentChanged,
        Hash:           metadata.Hash,
    }, nil
}
```

**Usage:**
- API uploads: Call `ProcessFileComplete(path, "upload")`
- FS events: Call `ProcessFileComplete(path, "fs_event")`
- Periodic scans: Call `ProcessFileComplete(path, "scan")` for changed files only

---

### 7. Fragile Hash Change Detection
**File:** `backend/workers/fs/worker.go:366-377`

**Problem:** `oldHash == ""` means both "file is new" and "hash computation previously failed" - these are different states.

**Impact:** Medium - Files with failed hash computation trigger digest repeatedly

**Fix:**
```go
// Add explicit state tracking in FileRecord
type FileRecord struct {
    Hash              *string
    HashFailedAt      *string  // Track when hash computation failed
    HashFailureReason *string  // Track why it failed
    // ...
}

// In processing logic:
if existing != nil && existing.HashFailedAt != nil {
    // This is a retry case, not a new file
    log.Info().Msg("retrying hash computation for previously failed file")
}

contentChanged := (existing == nil) ||                           // New file
                  (existing.Hash == nil) ||                      // Never had hash
                  (existing.Hash != nil && *existing.Hash != metadata.Hash)  // Hash changed
```

---

### 8. Duplicate File Processing in scanDirectory
**File:** `backend/workers/fs/worker.go:462-543`

**Problem:** New files get upserted twice (see Issue #5)

**Impact:** Medium - Inefficient, potential timestamp issues

**Fix:** See fix for Issue #5

---

## Race Conditions & Timing Issues

### 9. Multiple Concurrent ProcessFile Calls
**File:** `backend/workers/fs/worker.go:92-119`

**Problem:** No synchronization between concurrent ProcessFile calls from API, FS watcher, scans.

**Impact:** High - Wasted resources, potential race conditions

**Fix:**
```go
type Worker struct {
    // Add processing lock map (similar to digest worker)
    processingFiles sync.Map // map[string]bool
}

func (w *Worker) acquireProcessingLock(path string) bool {
    _, loaded := w.processingFiles.LoadOrStore(path, true)
    return !loaded // true if we got the lock
}

func (w *Worker) releaseProcessingLock(path string) {
    w.processingFiles.Delete(path)
}

// Use in ProcessFileComplete (see Issue #6 fix)
```

---

### 10. UpsertFile isNewInsert Race Window
**File:** `backend/db/files.go:52-55`

**Problem:** Checks if file exists OUTSIDE transaction, then upserts in separate transaction.

**Impact:** Medium - Return value `isNewInsert` may be incorrect

**Fix:**
```go
func UpsertFile(f *FileRecord) (bool, error) {
    tx, err := GetDB().Begin()
    if err != nil {
        return false, err
    }
    defer tx.Rollback()

    // Check existence within transaction
    var existingPath string
    err = tx.QueryRow("SELECT path FROM files WHERE path = ?", f.Path).Scan(&existingPath)
    isNewInsert := err == sql.ErrNoRows

    // Upsert in same transaction
    query := `...`
    _, err = tx.Exec(query, ...)
    if err != nil {
        return false, err
    }

    return isNewInsert, tx.Commit()
}
```

---

### 11. handleEvent Directory/File Race
**File:** `backend/workers/fs/worker.go:240-250`

**Problem:** Calls `os.Stat()` twice on same file, file could change between calls.

**Impact:** Low - Minor inefficiency, potential crash if file deleted

**Fix:**
```go
func (w *Worker) handleEvent(event fsnotify.Event) {
    relPath, err := filepath.Rel(w.dataRoot, event.Name)
    if err != nil || w.isExcluded(relPath) {
        return
    }

    // Single stat call
    info, err := os.Stat(event.Name)
    if err != nil {
        return // File deleted or inaccessible
    }

    isNew := event.Op&fsnotify.Create != 0
    contentChanged := event.Op&fsnotify.Write != 0

    // Handle directory
    if info.IsDir() {
        if isNew {
            w.watcher.Add(event.Name)
        }
        return // Don't process directories further
    }

    // Handle file
    if isNew {
        w.createFileRecord(relPath, info)
    }

    if w.onChange != nil && (isNew || contentChanged) {
        w.onChange(FileChangeEvent{...})
    }
}
```

---

## Data Consistency Issues

### 12. Missing Hash Computation Fallback
**File:** `backend/workers/fs/worker.go:284-319`

**Problem:** If hash computation fails, file inserted without hash and never retried.

**Impact:** Medium - Files permanently incomplete

**Fix:**
```go
// Add retry mechanism
func (w *Worker) createFileRecord(relPath string, info os.FileInfo) {
    metadata, err := ProcessFileMetadata(relPath)
    if err != nil {
        // Record the failure
        now := db.NowUTC()
        db.UpsertFile(&db.FileRecord{
            Path:              relPath,
            HashFailedAt:      &now,
            HashFailureReason: PtrString(err.Error()),
            // ... basic fields
        })

        // Schedule retry with exponential backoff
        w.scheduleHashRetry(relPath, 1*time.Minute)
        return
    }

    // Normal processing...
}

// Add retry worker
func (w *Worker) retryFailedHashes() {
    rows, _ := db.GetDB().Query(`
        SELECT path
        FROM files
        WHERE hash IS NULL
          AND hash_failed_at IS NOT NULL
          AND hash_failed_at < datetime('now', '-5 minutes')
        LIMIT 10
    `)
    defer rows.Close()

    for rows.Next() {
        var path string
        rows.Scan(&path)
        w.ProcessFileComplete(path, "retry")
    }
}
```

---

### 13. screenshot_sqlar Handling Fragility
**File:** `backend/db/files.go:58-68`

**Problem:** `screenshot_sqlar` is in INSERT but not in ON CONFLICT UPDATE, relying on implicit SQLite preservation behavior.

**Impact:** Low - Works correctly but fragile, could confuse developers

**Fix:**
```go
// Make explicit:
ON CONFLICT(path) DO UPDATE SET
    name = excluded.name,
    is_folder = excluded.is_folder,
    size = excluded.size,
    mime_type = excluded.mime_type,
    hash = excluded.hash,
    modified_at = excluded.modified_at,
    last_scanned_at = excluded.last_scanned_at,
    text_preview = excluded.text_preview,
    screenshot_sqlar = COALESCE(excluded.screenshot_sqlar, screenshot_sqlar)
    -- Only update screenshot_sqlar if new value is not NULL
```

Or better: Create separate `UpdateScreenshot` function to make intent clear.

---

## Architectural Improvements

### 14. No Atomicity Between File Metadata and Database
**Impact:** High - Process crashes leave inconsistent state

**Fix:**
- Accept that filesystem and DB can't be truly atomic across process boundaries
- Add reconciliation job that runs on startup:
  ```go
  func ReconcileFilesystemAndDB() {
      // Find files in DB but not on disk -> mark as deleted
      // Find files on disk but not in DB -> add to DB
      // Find files with mismatched modified_at -> re-process
  }
  ```
- Add health check endpoint that reports inconsistencies

---

### 15. Cascading Updates from Separate text_preview Updates
**Impact:** High - Multiple writes, notification races

**Fix:** Already covered in Issue #2 - eliminate separate updates

---

### 16. No Idempotency Guarantees
**Impact:** Medium - Repeated operations have undefined behavior

**Fix:**
- Document idempotency contracts explicitly
- Make all operations truly idempotent:
  ```go
  // Calling ProcessFileComplete(path) multiple times should:
  // - Always produce same final state
  // - Only trigger digest if hash actually changed
  // - Not create duplicate notifications
  ```

---

### 17. Missing Transactional Boundaries
**Impact:** High - Partial failures leave inconsistent state

**Fix:** See Issue #6 - ProcessFileComplete wraps all operations with proper error handling

---

## Implementation Plan

### Phase 1: Critical Bug Fixes (Week 1)
**Priority: CRITICAL - Fix Now**

1. ✅ Fix `BatchUpsertFiles` to include `text_preview` in ON CONFLICT (DONE)
2. Eliminate separate `UpdateFileField` calls for `text_preview`
3. Add processing lock to prevent concurrent file processing
4. Fix `scanDirectory` double-upsert pattern

**Success Criteria:**
- No more text_preview data loss during scans
- Files processed only once per event
- No race conditions in file processing

---

### Phase 2: Design Consolidation (Week 2)
**Priority: HIGH - Prevents Future Bugs**

5. Create unified `ProcessFileComplete` function
6. Refactor all code paths to use unified function
7. Add hash computation retry mechanism
8. Fix `UpsertFile` transaction handling

**Success Criteria:**
- Single code path for all file processing
- Failed hash computations are retried
- `isNewInsert` return value is accurate

---

### Phase 3: Race Condition Fixes (Week 3)
**Priority: MEDIUM - Improves Reliability**

9. Fix `handleEvent` double stat
10. Add explicit hash failure tracking
11. Improve content change detection logic
12. Make `screenshot_sqlar` handling explicit

**Success Criteria:**
- No redundant filesystem operations
- Clear distinction between "new file" and "hash failed"
- Explicit handling of all edge cases

---

### Phase 4: Architectural Improvements (Week 4)
**Priority: MEDIUM - Long-term Stability**

13. Add filesystem/DB reconciliation job
14. Add health check endpoint
15. Document idempotency contracts
16. Add metrics and monitoring

**Success Criteria:**
- System can recover from crashes automatically
- Inconsistencies are detected and reported
- Clear observability into file processing

---

## Testing Strategy

### Unit Tests
```go
// Test concurrent file processing
func TestConcurrentProcessFile(t *testing.T) {
    // Launch 10 goroutines processing same file
    // Verify: only one succeeds, hash computed once
}

// Test text_preview preservation
func TestTextPreviewPreserved(t *testing.T) {
    // Create file with text_preview
    // Run scanDirectory
    // Verify: text_preview still exists
}

// Test hash change detection
func TestHashChangeDetection(t *testing.T) {
    // Create file, process
    // Modify file content
    // Process again
    // Verify: content change detected, digest triggered
}
```

### Integration Tests
```go
// Test full file lifecycle
func TestFileLifecycle(t *testing.T) {
    // Upload file -> verify DB record with hash + preview
    // Modify file -> verify hash updated, digest triggered
    // Delete file -> verify cleanup
}

// Test scan after crash
func TestScanRecovery(t *testing.T) {
    // Create files on disk
    // Clear database
    // Run scan
    // Verify: all files discovered and processed
}
```

### Load Tests
- 1000 files uploaded concurrently
- Verify no race conditions, all processed correctly

---

## Metrics to Add

```go
// File processing metrics
fileProcessingDuration := prometheus.NewHistogramVec(...)
fileProcessingErrors := prometheus.NewCounterVec(...)
concurrentFileProcessing := prometheus.NewGauge(...)
hashComputationFailures := prometheus.NewCounter(...)
textPreviewFailures := prometheus.NewCounter(...)

// Database metrics
upsertOperations := prometheus.NewCounterVec(...) // by type: new, update
batchUpsertSize := prometheus.NewHistogram(...)
transactionDuration := prometheus.NewHistogram(...)
```

---

## Risk Assessment

| Issue | Severity | Likelihood | Risk Score | Mitigation |
|-------|----------|------------|------------|------------|
| text_preview data loss | Critical | High (confirmed) | 10/10 | Phase 1 fix |
| Hash computation race | High | Medium | 7/10 | Processing lock |
| Concurrent processing | High | High | 8/10 | Processing lock |
| BatchUpsertFiles race | Medium | Low | 4/10 | Transaction fix |
| Missing hash retry | Medium | Medium | 5/10 | Retry mechanism |

---

## Questions for Discussion

1. **Performance vs Correctness:** Should we compute hashes before batch upsert (slower but atomic) or after (faster but two-phase)?

2. **Retry Strategy:** How many times should we retry failed hash computations? Exponential backoff?

3. **Backwards Compatibility:** Do we need migration for existing files missing hashes?

4. **Monitoring:** What alerts should we set up for file processing issues?

5. **Idempotency:** Should we add `processing_started_at` timestamp to detect stuck processing?

---

## Conclusion

The FS worker and database files module suffer from a **fundamental design issue**: attempting to perform multi-step, non-atomic operations without proper synchronization. The fixes outlined above will:

1. ✅ Eliminate data loss (text_preview bug)
2. Add proper locking to prevent concurrent processing races
3. Consolidate inconsistent code paths into unified logic
4. Add retry mechanisms for transient failures
5. Improve observability and monitoring

**Estimated effort:** 4 weeks with 1 developer

**Recommended approach:** Implement Phase 1 immediately (critical bug fixes), then proceed with Phases 2-4 based on priority and resources.
