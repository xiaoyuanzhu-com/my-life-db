# Filesystem Service v2 Design

**Date:** 2026-01-31
**Status:** Draft

---

## Problem Statement

The current FS service has bugs that cause:
1. **Race conditions**: Multiple goroutines processing the same file
2. **Orphaned records**: DB records for files that no longer exist (after moves)
3. **Stale data**: Scanner overwrites newer API data

These issues are more visible now with AI agents (Claude Code) rapidly creating/modifying/moving files.

---

## Goals

Keep it simple:

1. **No duplicate processing** - One file, one processor at a time
2. **No orphaned records** - Moves/renames clean up old paths
3. **Latest data wins** - Don't overwrite new data with old
4. **Eventually consistent** - Scanner catches anything missed

Non-goals (keep current behavior):
- We don't need sub-100ms latency
- We don't need complex editor pattern detection
- We don't need metrics/observability (can add later)

---

## Current Bugs

### Bug 1: `unmarkProcessing` runs too early

```go
// WRONG - defer runs when handleCreate returns, not when goroutine finishes
func (w *watcher) handleCreate(path string) {
    if !w.service.fileLock.markProcessing(path) { return }
    defer w.service.fileLock.unmarkProcessing(path)  // ← runs immediately!

    go func() {
        w.processExternalFile(path)  // ← still running
    }()
}
```

**Fix**: Move `unmarkProcessing` inside the goroutine.

### Bug 2: RENAME events ignored

```go
// WRONG - only handles Remove, not Rename
if err != nil {
    if event.Op&fsnotify.Remove != 0 {
        w.handleDelete(relPath)
    }
    return  // ← Rename dropped silently
}
```

**Fix**: Handle RENAME as delete of old path.

### Bug 3: Scanner overwrites newer data

```sql
-- WRONG - always overwrites hash
ON CONFLICT(path) DO UPDATE SET hash = excluded.hash
```

**Fix**: Only update if hash is empty or we have newer data.

### Bug 4: No debouncing

Every fsnotify event triggers full processing. Rapid saves = duplicate work.

**Fix**: Simple debounce with 100-200ms delay.

---

## Scenarios We Must Handle

### Basic (already works, keep working)
- File created via API → DB record created
- File created externally → detected, DB record created
- File modified → hash updated
- File deleted → DB record removed

### Currently Broken (must fix)

#### Rapid writes to same file
```
T0:   Write V1
T50:  Write V2
T100: Write V3
```
**Current**: May process V1, V2, V3 separately (wasted work, possible races)
**Expected**: Process once with V3 content

#### Write then move
```
T0:   Create "inbox/doc.md"
T50:  Move to "notes/doc.md"
```
**Current**: "inbox/doc.md" orphaned in DB
**Expected**: Only "notes/doc.md" in DB

#### External move/rename
```
T0: mv inbox/doc.md notes/doc.md
```
**Current**: RENAME event ignored, old record stays
**Expected**: Old record deleted, new record created

#### Scanner vs API race
```
T0:   Scanner reads file (content V1)
T50:  API writes V2, updates DB with H2
T100: Scanner finishes, writes H1 to DB
```
**Current**: DB has stale H1
**Expected**: DB keeps H2 (newer)

---

## Solution

### 1. Fix the defer bug (simple)

```go
func (w *watcher) handleCreate(path string) {
    if !w.service.fileLock.markProcessing(path) { return }
    // NO defer here

    go func() {
        defer w.service.fileLock.unmarkProcessing(path)  // ← correct place
        w.processExternalFile(path)
    }()
}
```

### 2. Handle RENAME events (simple)

```go
func (w *watcher) handleEvent(event fsnotify.Event) {
    // ...
    if err != nil {
        // File doesn't exist at this path anymore
        if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
            w.handleDelete(relPath)
        }
        return
    }
    // ...
}
```

### 3. Add simple debouncing

Instead of processing immediately, queue events and wait for them to settle.

```go
type debouncer struct {
    pending   map[string]*pendingEvent
    mu        sync.Mutex
    delay     time.Duration  // 150ms default
}

type pendingEvent struct {
    path      string
    timer     *time.Timer
    eventType EventType  // CREATE, WRITE, DELETE
}

func (d *debouncer) Queue(path string, eventType EventType) {
    d.mu.Lock()
    defer d.mu.Unlock()

    if eventType == EventDelete {
        // Delete is immediate - cancel pending and process now
        if p, ok := d.pending[path]; ok {
            p.timer.Stop()
            delete(d.pending, path)
        }
        d.processNow(path, EventDelete)
        return
    }

    if p, ok := d.pending[path]; ok {
        // Already pending - reset timer
        p.timer.Reset(d.delay)
        return
    }

    // New pending event
    timer := time.AfterFunc(d.delay, func() {
        d.onTimer(path)
    })
    d.pending[path] = &pendingEvent{
        path:      path,
        timer:     timer,
        eventType: eventType,
    }
}

func (d *debouncer) onTimer(path string) {
    d.mu.Lock()
    p, ok := d.pending[path]
    if ok {
        delete(d.pending, path)
    }
    d.mu.Unlock()

    if ok {
        d.processNow(path, p.eventType)
    }
}
```

### 4. Detect moves (RENAME + CREATE pattern)

When we see RENAME for path A, remember it briefly. If CREATE for path B comes within 500ms with same filename, treat as move.

```go
type moveDetector struct {
    recentRenames map[string]time.Time  // path → when renamed
    mu            sync.Mutex
    ttl           time.Duration  // 500ms
}

func (m *moveDetector) TrackRename(oldPath string) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.recentRenames[oldPath] = time.Now()
}

func (m *moveDetector) CheckMove(newPath string) (oldPath string, isMove bool) {
    m.mu.Lock()
    defer m.mu.Unlock()

    newName := filepath.Base(newPath)
    now := time.Now()

    for old, ts := range m.recentRenames {
        if now.Sub(ts) > m.ttl {
            delete(m.recentRenames, old)
            continue
        }
        if filepath.Base(old) == newName {
            delete(m.recentRenames, old)
            return old, true
        }
    }
    return "", false
}
```

### 5. Smarter DB upsert

Don't overwrite hash if existing hash is non-empty and different (means someone else updated).

```go
func UpsertFile(f *FileRecord) (isNew bool, err error) {
    // Check existing
    var existingHash sql.NullString
    err = db.QueryRow("SELECT hash FROM files WHERE path = ?", f.Path).Scan(&existingHash)
    isNew = (err == sql.ErrNoRows)

    if !isNew && existingHash.Valid && existingHash.String != "" {
        // Existing record has hash - only update if we also have hash
        if f.Hash == nil || *f.Hash == "" {
            // We don't have hash, don't overwrite
            return false, nil
        }
    }

    // Proceed with upsert
    _, err = db.Exec(`
        INSERT INTO files (...) VALUES (...)
        ON CONFLICT(path) DO UPDATE SET
            hash = COALESCE(NULLIF(excluded.hash, ''), files.hash),
            text_preview = COALESCE(excluded.text_preview, files.text_preview),
            ...
    `, ...)

    return isNew, err
}
```

### 6. Process moves atomically

When move detected:
1. Compute metadata for new path
2. In single transaction: insert new record, delete old record, update related tables

```go
func (s *Service) processMove(oldPath, newPath string) error {
    // 1. Compute metadata for file at new location
    metadata, _ := s.processor.ComputeMetadata(ctx, newPath)

    // 2. Get file info
    info, err := os.Stat(filepath.Join(s.dataRoot, newPath))
    if err != nil {
        return err
    }

    // 3. Atomic DB update
    return s.db.MoveFile(oldPath, newPath, s.buildFileRecord(newPath, info, metadata))
}

// In db package
func MoveFile(oldPath, newPath string, newRecord *FileRecord) error {
    tx, _ := db.Begin()
    defer tx.Rollback()

    // Insert/update new path
    tx.Exec(`INSERT INTO files (...) VALUES (...) ON CONFLICT ...`, newRecord)

    // Delete old path
    tx.Exec(`DELETE FROM files WHERE path = ?`, oldPath)

    // Update related tables
    tx.Exec(`UPDATE digests SET file_path = ? WHERE file_path = ?`, newPath, oldPath)
    tx.Exec(`UPDATE pins SET path = ? WHERE path = ?`, newPath, oldPath)

    return tx.Commit()
}
```

---

## Architecture

Keep it simple - minimal new abstractions:

```
┌──────────────────────────────────────────────────────────┐
│                     FS Service                            │
├──────────────────────────────────────────────────────────┤
│                                                          │
│   ┌─────────┐     ┌─────────┐     ┌─────────┐           │
│   │   API   │     │ Watcher │     │ Scanner │           │
│   └────┬────┘     └────┬────┘     └────┬────┘           │
│        │               │               │                 │
│        │               ▼               │                 │
│        │         ┌──────────┐          │                 │
│        │         │Debouncer │          │                 │
│        │         │  +Move   │          │                 │
│        │         │ Detector │          │                 │
│        │         └────┬─────┘          │                 │
│        │              │                │                 │
│        ▼              ▼                ▼                 │
│   ┌────────────────────────────────────────┐            │
│   │         processFile(path)              │            │
│   │   (with per-file lock via fileLock)    │            │
│   └────────────────────────────────────────┘            │
│                       │                                  │
│        ┌──────────────┼──────────────┐                  │
│        ▼              ▼              ▼                  │
│   ┌─────────┐   ┌──────────┐   ┌──────────┐            │
│   │  Disk   │   │ Database │   │ Notifier │            │
│   └─────────┘   └──────────┘   └──────────┘            │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Key points:
- **Debouncer** sits between watcher and processing (not API - API is synchronous)
- **Move detector** is part of debouncer
- **fileLock** remains the single source of truth for per-file locking
- **Scanner** goes through same `processFile()` path
- No new "coordinator" abstraction - just fix existing code

---

## Changes Summary

| Component | Change | Complexity |
|-----------|--------|------------|
| `watcher.go` | Fix defer placement | Simple |
| `watcher.go` | Handle RENAME events | Simple |
| `watcher.go` | Add debouncer | Medium |
| `watcher.go` | Add move detection | Medium |
| `operations.go` | No changes needed | - |
| `scanner.go` | Use same processFile path | Simple |
| `db/files.go` | Smarter upsert (COALESCE) | Simple |
| `db/files.go` | Add MoveFile transaction | Medium |

---

## Implementation Plan

### Phase 1: Fix critical bugs (1 day)
1. Fix defer placement in handleCreate/handleWrite
2. Handle RENAME events as delete
3. Update DB upsert to use COALESCE

### Phase 2: Add debouncing (1 day)
1. Add simple debouncer struct
2. Wire watcher to use debouncer
3. Test with rapid file changes

### Phase 3: Add move detection (0.5 day)
1. Add move detector
2. Wire into debouncer
3. Add MoveFile DB transaction

### Phase 4: Test & polish (0.5 day)
1. Manual testing with AI agent workflows
2. Fix any edge cases
3. Update scanner to use same code path

Total: ~3 days

---

## What We're NOT Doing

- ❌ Complex "coordinator" abstraction
- ❌ Version numbers / optimistic locking
- ❌ Worker pools
- ❌ Metrics / observability
- ❌ Feature flags for gradual rollout
- ❌ Editor-specific pattern detection (vim, vscode)
- ❌ Folder move handling (can add later if needed)

We can add these later if needed. For now, fix the bugs simply.

---

## Testing

Manual tests to verify:

1. **Rapid writes**: Create file, modify 5x rapidly → single hash in DB
2. **Move detection**: `mv inbox/a.md notes/a.md` → only notes/a.md in DB
3. **Scanner doesn't overwrite**: API write during scan → API hash preserved
4. **No duplicate processing**: Check logs for single "processing" per file

Automated tests:
- `TestDebouncer_CoalescesRapidWrites`
- `TestMoveDetector_SameFilename`
- `TestUpsert_PreservesNewerHash`
- `TestWatcher_RenameDeletesOldRecord`

---

## Appendix: Detailed Scenarios

### Scenario: Rapid Write → Write → Move

```
T0:    Agent creates "inbox/doc.md" (V1)
       └─ fsnotify CREATE
       └─ Debouncer: queue "inbox/doc.md", start 150ms timer

T30:   Agent modifies "inbox/doc.md" (V2)
       └─ fsnotify WRITE
       └─ Debouncer: reset timer to 150ms

T60:   Agent moves to "notes/doc.md"
       └─ fsnotify RENAME "inbox/doc.md"
       └─ Debouncer:
          ├─ Cancel pending for "inbox/doc.md"
          └─ moveDetector.TrackRename("inbox/doc.md")
       └─ fsnotify CREATE "notes/doc.md"
       └─ Debouncer:
          ├─ moveDetector.CheckMove("notes/doc.md") → "inbox/doc.md"
          └─ Process as MOVE immediately

T60+:  processMove("inbox/doc.md", "notes/doc.md"):
       ├─ ComputeMetadata("notes/doc.md") → hash of V2
       └─ DB transaction:
          ├─ INSERT "notes/doc.md" with hash
          └─ DELETE "inbox/doc.md"

Result: Only "notes/doc.md" in DB, no orphans
```

### Scenario: Scanner vs API Race

```
T0:    Scanner starts scan, finds "doc.md"
       └─ markProcessing("doc.md") → true
       └─ ComputeMetadata starts (slow, reading V1)

T50:   API WriteFile("doc.md", V2) called
       └─ Acquire fileLock
       └─ Write V2 to disk
       └─ ComputeMetadata → H2
       └─ UpsertFile with H2
       └─ Release fileLock

T100:  Scanner finishes ComputeMetadata → H1
       └─ UpsertFile with H1
       └─ DB has H2 already (non-empty)
       └─ COALESCE keeps H2 (doesn't overwrite with H1)

Result: DB has H2 (correct, newer)
```

Wait, this scenario still has a problem - scanner's `markProcessing` doesn't coordinate with API's `fileLock`. Let me think...

Actually, the current code has API using `fileLock.acquireFileLock().Lock()` (mutex) while scanner uses `fileLock.markProcessing()` (flag). They don't coordinate.

**Simpler fix**: Scanner should also acquire the mutex, not just the flag.

```go
// scanner.go
func (s *scanner) processFile(path string) {
    mu := s.service.fileLock.acquireFileLock(path)
    mu.Lock()
    defer mu.Unlock()

    // Now we're coordinated with API
    // ... compute metadata, upsert ...
}
```

This way:
- If API is writing, scanner waits
- If scanner is processing, API waits
- Whoever finishes last has the final say (which is correct - they read the current content)

---

## Updated Changes Summary

| Component | Change | Complexity |
|-----------|--------|------------|
| `watcher.go` | Fix defer placement | Simple |
| `watcher.go` | Handle RENAME events | Simple |
| `watcher.go` | Add debouncer + move detection | Medium |
| `scanner.go` | Use mutex instead of just flag | Simple |
| `db/files.go` | Smarter upsert (COALESCE) | Simple |
| `db/files.go` | Add MoveFile transaction | Medium |

---

## Appendix: fsnotify Official Documentation & Research

This section summarizes the official fsnotify documentation and research findings, cross-referenced with our test results.

**Sources**:
- [fsnotify GitHub](https://github.com/fsnotify/fsnotify)
- [fsnotify pkg.go.dev](https://pkg.go.dev/github.com/fsnotify/fsnotify)
- [Linux inotify(7) man page](https://man7.org/linux/man-pages/man7/inotify.7.html)

### Official Event Definitions (from source code)

```go
const (
    // A new pathname was created.
    Create Op = 1 << iota

    // The pathname was written to; this does *not* mean the write has finished,
    // and a write can be followed by more writes.
    Write

    // The path was removed; any watches on it will be removed. Some "remove"
    // operations may trigger a Rename if the file is actually moved.
    Remove

    // The path was renamed to something else; any watches on it will be removed.
    Rename

    // File attributes were changed. It's generally not recommended to take
    // action on this event, as it may get triggered very frequently.
    Chmod
)
```

### RENAME Event Behavior (Official Documentation)

From the [official docs](https://pkg.go.dev/github.com/fsnotify/fsnotify):

> "A rename is **always sent with the old path** as `Event.Name`, and a **Create event will be sent with the new name**. Renames are only sent for paths that are currently watched."

**Example**: `mv /tmp/file /tmp/rename` will emit:
- `Event{Op: Rename, Name: "/tmp/file"}`
- `Event{Op: Create, Name: "/tmp/rename", renamedFrom: "/tmp/file"}`

### Important Discovery: `renamedFrom` Field

The Event struct has an **unexported `renamedFrom` field** that tracks the source path for renames:

```go
type Event struct {
    Name        string  // Path to file/directory
    Op          Op      // Operation bitmask
    renamedFrom string  // (unexported) Old path if this is a rename
}
```

**Key findings from our tests**:
- The `renamedFrom` field IS populated on Linux
- It's visible in `event.String()` output: `CREATE "/new.txt" ← "/old.txt"`
- But it's **unexported** - cannot access directly via `event.RenamedFrom`
- Workaround: Parse `event.String()` if needed

This simplifies our move detection! We don't need to correlate RENAME+CREATE ourselves - fsnotify already does it.

### Multiple Events for Single Operations (Official)

From the [documentation](https://pkg.go.dev/github.com/fsnotify/fsnotify):

> "A single 'write action' initiated by the user may show up as one or multiple writes, depending on when the system syncs things to disk. For example when compiling a large Go program you may get hundreds of Write events."

**Cause**: `os.WriteFile()` uses `O_TRUNC` flag, which:
1. Truncates file (generates one WRITE)
2. Writes content (generates another WRITE)
3. Large files may need multiple syscalls (more WRITEs)

### Event Coalescing (Linux inotify)

From the [inotify man page](https://man7.org/linux/man-pages/man7/inotify.7.html):

> "If successive output inotify events produced on the inotify file descriptor are identical (same wd, mask, cookie, and name), then they are coalesced into a single event."

This means **identical** rapid events may be coalesced, but in practice we still see more events than operations.

### Official Best Practices

1. **Watch directories, not files**:
   > "Watching individual files (rather than directories) is generally not recommended as many programs (especially editors) update files atomically."

2. **Use `Event.Has()` for checking operations**:
   > "Op is a bitmask and some systems may send multiple operations at once. Use the `Event.Has()` method instead of comparing with `==`."

3. **Ignore Chmod events**:
   > "It's generally not recommended to take action on this event, as it may get triggered very frequently by some software."

4. **Debounce Write events**:
   > Official example in `cmd/fsnotify/dedup.go` shows waiting 100ms for events to settle.

### Linux-Specific Behaviors (inotify)

| Behavior | Description |
|----------|-------------|
| REMOVE timing | Won't fire until all file descriptors are closed |
| Delete sequence | Delete triggers CHMOD first, then REMOVE on fd close |
| Buffer overflow | Governed by `fs.inotify.max_queued_events` |
| Watch limits | Governed by `fs.inotify.max_user_watches` |

### Implications for Our Design

1. **Move detection is simpler than expected**: The `renamedFrom` field means CREATE events for renames already carry the source path. We can parse `event.String()` or use our RENAME+CREATE correlation as backup.

2. **Debouncing is essential**: Official recommendation is 100ms wait. Our 150ms is reasonable.

3. **Multiple WRITEs per operation is normal**: Don't treat each WRITE as meaningful - debounce.

4. **File may not exist when processing event**: Official docs confirm this is expected behavior.

---

## Appendix: fsnotify Behavior Test Results

This section documents the **verified** behavior of the fsnotify library on Linux (inotify backend). All behaviors below were tested and confirmed on 2026-01-31.

**Test file**: `backend/fs/fsnotify_test.go` - Run with `go test -v -run TestFsnotify ./fs/`

### Event Types

| Event | Description |
|-------|-------------|
| `CREATE` | New file/directory created |
| `WRITE` | File content modified |
| `REMOVE` | File/directory deleted |
| `RENAME` | File/directory renamed (old name) |
| `CHMOD` | File permissions changed |

### Basic Operations (Verified)

#### Simple File Create
```
os.WriteFile("test.txt", content, 0644)
```
**Verified Events**: `CREATE` → `WRITE`
```
50ms: test.txt  op=CREATE  [exists]
50ms: test.txt  op=WRITE   [exists]
```
- File exists when both events are received
- **Always get both CREATE and WRITE** for `os.WriteFile()`

#### Simple File Modify
```
os.WriteFile("existing.txt", newContent, 0644)
```
**Verified Events**: `WRITE` × 2
```
50ms: test.txt  op=WRITE  [exists]
50ms: test.txt  op=WRITE  [exists]
```
- May receive **multiple WRITE events** for single write operation

#### Simple File Delete
```
os.Remove("test.txt")
```
**Verified Events**: `REMOVE`
```
50ms: test.txt  op=REMOVE  [GONE]
```
- File does NOT exist when REMOVE event is received

#### File Rename (Same Directory)
```
os.Rename("old.txt", "new.txt")
```
**Verified Events**: `RENAME` → `CREATE`
```
50ms: old.txt  op=RENAME  [GONE]
50ms: new.txt  op=CREATE  [exists]
```
- Old path gets RENAME, new path gets CREATE
- Events arrive in order, same millisecond

#### File Move (Different Directory)
```
os.Rename("dir1/test.txt", "dir2/test.txt")
```
**Verified Events** (if both dirs watched): `RENAME` → `CREATE`
```
100ms: test.txt  op=RENAME  [GONE]
100ms: test.txt  op=CREATE  [exists]
```
- Same pattern as rename, just different directories
- **CRITICAL**: If destination directory is NOT watched, you only get RENAME

### Edge Cases (Verified)

#### Rapid Writes (10 writes, no delay)
```go
for i := 0; i < 10; i++ {
    os.WriteFile("test.txt", content[i], 0644)
}
```
**Verified Events**: 11 WRITE events for 10 writes
```
50ms: test.txt  op=WRITE  [exists]
50ms: test.txt  op=WRITE  [exists]
... (11 total)
```
- **MORE events than writes** (each WriteFile may generate multiple WRITEs)
- All arrive within ~1ms of each other

#### Rapid Writes (10 writes, 10ms apart)
**Verified Events**: 14 WRITE events for 10 writes
```
50ms:  test.txt  op=WRITE  [exists]
60ms:  test.txt  op=WRITE  [exists]
... (14 total over 143ms)
```
- Events spaced out, roughly following write timing
- Still more events than actual writes

**Implication**: MUST debounce - we get **more events than actual operations**.

#### Create Then Immediate Delete
```go
os.WriteFile("test.txt", content, 0644)
os.Remove("test.txt")
```
**Verified Events**: `CREATE` → `WRITE` → `REMOVE`
```
50ms: test.txt  op=CREATE  [GONE]
50ms: test.txt  op=WRITE   [GONE]
50ms: test.txt  op=REMOVE  [GONE]
```
- **File already GONE when processing CREATE!**
- All 3 events have `[GONE]` status when we check existence

**Implication**: Always check if file exists before processing CREATE/WRITE events.

#### Create Then Immediate Rename
```go
os.WriteFile("a.txt", content, 0644)
os.Rename("a.txt", "b.txt")
```
**Verified Events**: `CREATE` → `WRITE` → `RENAME` → `CREATE`
```
50ms: test1.txt  op=CREATE  [GONE]
50ms: test1.txt  op=WRITE   [GONE]
50ms: test1.txt  op=RENAME  [GONE]
50ms: test2.txt  op=CREATE  [exists]
```
- Original file CREATE shows `[GONE]` - already renamed by processing time

#### Write Then Immediate Rename
```go
os.WriteFile("a.txt", newContent, 0644)
os.Rename("a.txt", "b.txt")
```
**Verified Events**: `WRITE` × 2 → `RENAME` → `CREATE`
```
50ms: test1.txt  op=WRITE   [exists]
50ms: test1.txt  op=WRITE   [exists]
50ms: test1.txt  op=RENAME  [GONE]
50ms: test2.txt  op=CREATE  [exists]
```
- Interestingly, first two WRITE events show file `[exists]`
- Race condition: depends on timing of event processing vs rename

#### Multiple Rapid Renames (a→b→c→a)
```go
os.Rename("a.txt", "b.txt")
os.Rename("b.txt", "c.txt")
os.Rename("c.txt", "a.txt")
```
**Verified Events**: 6 events total
```
50ms: a.txt  op=RENAME  [exists]  // back to a!
50ms: b.txt  op=CREATE  [GONE]
50ms: b.txt  op=RENAME  [GONE]
50ms: c.txt  op=CREATE  [GONE]
50ms: c.txt  op=RENAME  [GONE]
50ms: a.txt  op=CREATE  [exists]
```
- Events in correct order: `[a:RENAME, b:CREATE, b:RENAME, c:CREATE, c:RENAME, a:CREATE]`
- Intermediate files b and c show `[GONE]` - already moved by processing time

**Implication**: Move detection must handle rapid chains.

#### Atomic Write Pattern (temp → rename)
```go
os.WriteFile(".target.tmp", content, 0644)
os.Rename(".target.tmp", "target.txt")
```
**Verified Events**: 4 events
```
50ms: .target.txt.tmp  op=CREATE  [GONE]
50ms: .target.txt.tmp  op=WRITE   [GONE]
50ms: .target.txt.tmp  op=RENAME  [GONE]
50ms: target.txt       op=CREATE  [exists]
```
- Temp file events show `[GONE]`
- Final target shows `[exists]`

**Implication**: Filter out temp files (`.tmp`, etc.) in path filter.

#### Vim-Style Save Pattern
```go
os.Rename("file.txt", "file.txt~")     // backup
os.WriteFile("file.txt", content, 0644) // new file
os.Remove("file.txt~")                  // cleanup
```
**Verified Events**: 5 events
```
50ms: file.txt   op=RENAME  [exists]
50ms: file.txt~  op=CREATE  [GONE]
50ms: file.txt   op=CREATE  [exists]
50ms: file.txt   op=WRITE   [exists]
50ms: file.txt~  op=REMOVE  [GONE]
```
- Event order: `[file.txt:RENAME, file.txt~:CREATE, file.txt:CREATE, file.txt:WRITE, file.txt~:REMOVE]`
- The RENAME for file.txt shows `[exists]` because new file.txt already created!

**Implication**:
- Our move detector might incorrectly link file.txt→file.txt~ (same base name)
- Filter out backup files (`~` suffix, `.bak`, etc.)

### Directory Watching (Verified)

#### Subdirectory NOT Automatically Watched
```
// Watching: /root (not subdir)
os.WriteFile("/root/subdir/test.txt", content, 0644)
```
**Verified Events**: NONE (0 events)

After adding subdir to watcher, subsequent writes detected:
```
200ms: test.txt  op=WRITE  [exists]
201ms: test.txt  op=WRITE  [exists]
```

**Implication**: Must recursively add watches for new subdirectories.

#### New Subdirectory Creation
```
os.MkdirAll("/root/newdir", 0755)
```
**Verified Events**: `CREATE`
```
50ms: subdir  op=CREATE  [exists]
```

**Implication**: When we see CREATE for a directory, add it to the watcher.

### Other Operations (Verified)

#### Chmod
```go
os.Chmod("test.txt", 0600)
```
**Verified Events**: `CHMOD`
```
50ms: test.txt  op=CHMOD  [exists]
```

#### Truncate
```go
os.Truncate("test.txt", 5)
```
**Verified Events**: `WRITE`
```
50ms: test.txt  op=WRITE  [exists]
```

#### Large File Write (10MB)
**Verified Events**: `CREATE` → `WRITE` (only 2 events)
```
56ms: large.bin  op=CREATE  [exists]
59ms: large.bin  op=WRITE   [exists]
```
- Large files don't generate extra events on Linux

### Event Ordering (Verified)

**Test**: Create 5 files in sequence, 20ms apart
**Result**: Events arrive in correct order
```
Create order: [file1.txt file2.txt file3.txt file4.txt file5.txt]
```
- Events are reliably ordered when there's delay between operations
- Timestamps reflect actual creation order

### Key Takeaways for Our Design (Verified)

1. **Always check file existence** - CREATE/WRITE events may arrive after file is already gone/renamed
2. **Debounce is essential** - we get MORE events than actual operations (11 events for 10 writes)
3. **RENAME = "file gone from this path"** - treat as delete for old path
4. **Move detection requires correlation** - RENAME(old) + CREATE(new) within time window
5. **Filter temp/backup files** - editors create `.tmp`, `~` files we don't need to track
6. **Subdirs need explicit watching** - must auto-add new directories to watcher
7. **Events may arrive "late"** - file state when processing differs from event time
8. **Events arrive same millisecond** - rapid operations all timestamp within 1ms
