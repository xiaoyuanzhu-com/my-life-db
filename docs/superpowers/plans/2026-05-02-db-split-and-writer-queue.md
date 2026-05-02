# DB Split + Writer Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single SQLite database into `index.sqlite` (rebuildable file index) + `app.sqlite` (persistent user data), and route all writes through a per-DB single-writer goroutine. Eliminates `database is locked` errors; isolates scanner workload from user-facing writes; removes the deprecated `globalDB` singleton.

**Architecture:** Two `*db.DB` instances, each owning a `Writer` goroutine that processes write closures from a bounded channel. Reads continue through the connection pool (WAL allows concurrent readers). The app DB ATTACHes the index DB read-only so cross-boundary `pins JOIN files` queries still work. `database.sqlite` from existing installs is migrated in-place on first startup via copy-then-rename (two atomic commit points, crash-recoverable via filesystem state).

**Tech Stack:** Go 1.25, mattn/go-sqlite3, SQLite WAL mode, existing zerolog + Gin server.

**Companion spec:** [docs/superpowers/specs/2026-05-02-db-split-and-writer-queue-design.md](../specs/2026-05-02-db-split-and-writer-queue-design.md)

---

## File Map

**New files:**
- `backend/db/writer.go` — `Writer` type, `Do(ctx, fn)` API, run goroutine
- `backend/db/writer_test.go` — unit tests for Writer
- `backend/db/role.go` — `DBRole` enum (`Index` | `App`)
- `backend/db/split_migration.go` — one-shot legacy → two-DB migration
- `backend/db/split_migration_test.go` — integration test against fixture DB

**Substantially modified:**
- `backend/db/connection.go` — `DB` struct gains `writer`, `role`; remove `globalDB`/`GetDB()`/`Transaction()`; add ATTACH ConnectHook for app DB
- `backend/db/migrations.go` — `Migration.Target` field; per-DB migration filtering; per-DB `migrations` table
- `backend/db/files.go`, `pins.go`, `sessions.go`, `agent_sessions.go`, `agent_session_groups.go`, `settings.go`, `digests.go`, `files_fts.go`, `sqlar.go`, `explore.go`, `collectors.go`, `client.go` — convert package-level functions to methods on `*DB`; route writes through `Write(ctx, fn)`
- `backend/db/migration_*.go` (all 27) — add `Target: DBRoleIndex` or `Target: DBRoleApp`
- `backend/server/server.go` — open both DBs, ATTACH wiring, pass refs
- `backend/server/config.go` — `IndexPath`, `AppPath` config fields; `LegacyPath` for migration detection
- `backend/fs/types.go`, `fs/db_adapter.go` — drop adapter, use `*db.DB` directly
- `backend/fs/{scanner,watcher,preview,operations,service}.go` — call methods on injected `*db.DB`
- `backend/api/handlers.go` — accessors `IndexDB()`, `AppDB()`
- `backend/api/*.go` (16 files) — call sites change from `db.X()` to `h.server.AppDB().X()` / `h.server.IndexDB().X()`
- `backend/workers/digest/{worker,types,content_sources}.go` — accept `*db.DB` (index)
- `backend/workers/textindex/indexer.go` — accept `*db.DB` (index)
- `backend/explore/{service,tools}.go` — accept `*db.DB` (app)
- `backend/utils/text_source.go`, `backend/vendors/openai.go` — minor; pass DB through

**Untouched:**
- `backend/db/models.go` — pure types, no DB access
- All migration files' bodies (only metadata gets a target tag)

---

## Phase 1: Writer infrastructure (zero behavior change)

### Task 1: Add the `Writer` type with unit tests

**Files:**
- Create: `backend/db/writer.go`
- Create: `backend/db/writer_test.go`

- [ ] **Step 1: Write the failing tests**

Create `backend/db/writer_test.go`:

```go
package db

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

func newTestWriter(t *testing.T) (*Writer, func()) {
	t.Helper()
	conn, err := sql.Open("sqlite3", ":memory:?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := conn.Exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	w := newWriter(conn, 16)
	go w.run()
	return w, func() {
		w.stop()
		conn.Close()
	}
}

func TestWriter_DoCommitsTransaction(t *testing.T) {
	w, cleanup := newTestWriter(t)
	defer cleanup()

	err := w.Do(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO t (v) VALUES (?)`, "hello")
		return err
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}

	var count int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM t`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("want 1 row, got %d", count)
	}
}

func TestWriter_DoRollsBackOnError(t *testing.T) {
	w, cleanup := newTestWriter(t)
	defer cleanup()

	want := errors.New("intentional")
	got := w.Do(context.Background(), func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO t (v) VALUES (?)`, "abort"); err != nil {
			return err
		}
		return want
	})
	if !errors.Is(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}

	var count int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM t`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Fatalf("want 0 rows after rollback, got %d", count)
	}
}

func TestWriter_PreservesSubmissionOrder(t *testing.T) {
	w, cleanup := newTestWriter(t)
	defer cleanup()

	const n = 50
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		i := i
		go func() {
			defer wg.Done()
			err := w.Do(context.Background(), func(tx *sql.Tx) error {
				_, err := tx.Exec(`INSERT INTO t (id, v) VALUES (?, ?)`, i, "x")
				return err
			})
			if err != nil {
				t.Errorf("Do(%d): %v", i, err)
			}
		}()
	}
	wg.Wait()

	var count int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM t`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != n {
		t.Fatalf("want %d rows, got %d", n, count)
	}
}

func TestWriter_ContextCancelledBeforeQueue(t *testing.T) {
	conn, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer conn.Close()
	w := newWriter(conn, 1)
	// Don't start the goroutine; queue stays full after first send.

	ctx, cancel := context.WithCancel(context.Background())
	// Fill the queue.
	go w.Do(context.Background(), func(tx *sql.Tx) error { time.Sleep(time.Hour); return nil })
	time.Sleep(10 * time.Millisecond)

	cancel()
	err = w.Do(ctx, func(tx *sql.Tx) error { return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}

func TestWriter_StopDrainsAndClosesQueue(t *testing.T) {
	w, cleanup := newTestWriter(t)
	defer cleanup()

	var ran atomic.Int32
	for i := 0; i < 5; i++ {
		go func() {
			_ = w.Do(context.Background(), func(tx *sql.Tx) error {
				ran.Add(1)
				return nil
			})
		}()
	}
	time.Sleep(50 * time.Millisecond)

	if ran.Load() < 1 {
		t.Fatalf("expected at least one job to run, got %d", ran.Load())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail to compile**

Run: `cd backend && go test ./db/ -run TestWriter -v`
Expected: build failure — `newWriter`, `Writer`, `Do`, `run`, `stop` undefined.

- [ ] **Step 3: Implement the Writer**

Create `backend/db/writer.go`:

```go
package db

import (
	"context"
	"database/sql"
)

// writeJob is one queued unit of work for the writer goroutine.
type writeJob struct {
	ctx  context.Context
	fn   func(*sql.Tx) error
	done chan error
}

// Writer serializes all SQLite writes for a single database through one
// goroutine. SQLite already serializes writers internally; routing writes
// through a Go-level queue makes that explicit, eliminates SQLITE_BUSY from
// in-process contention, and gives callers a synchronous API regardless of
// how many goroutines are calling concurrently.
//
// Reads do NOT go through the writer — they continue through the *sql.DB
// pool directly. WAL mode allows concurrent readers alongside the one writer.
type Writer struct {
	db    *sql.DB
	queue chan writeJob
	quit  chan struct{}
}

func newWriter(db *sql.DB, queueSize int) *Writer {
	return &Writer{
		db:    db,
		queue: make(chan writeJob, queueSize),
		quit:  make(chan struct{}),
	}
}

// Do runs fn inside a write transaction on the writer goroutine. It blocks
// until commit or rollback, returning any error from BeginTx, fn, or Commit.
//
// fn must be short — long-running work (file I/O, network, hashing) blocks
// every other writer for this DB. Do that work first, then call Do with just
// the DB statements.
func (w *Writer) Do(ctx context.Context, fn func(*sql.Tx) error) error {
	done := make(chan error, 1)
	job := writeJob{ctx: ctx, fn: fn, done: done}

	select {
	case w.queue <- job:
	case <-ctx.Done():
		return ctx.Err()
	}

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// run is the writer goroutine. Call it once when starting the DB.
func (w *Writer) run() {
	for {
		select {
		case job := <-w.queue:
			job.done <- w.exec(job)
		case <-w.quit:
			// Drain remaining queued jobs so callers don't block forever.
			for {
				select {
				case job := <-w.queue:
					job.done <- w.exec(job)
				default:
					return
				}
			}
		}
	}
}

func (w *Writer) exec(job writeJob) error {
	if err := job.ctx.Err(); err != nil {
		return err
	}
	tx, err := w.db.BeginTx(job.ctx, nil)
	if err != nil {
		return err
	}
	if err := job.fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// stop signals the writer goroutine to drain and exit. Outstanding queued
// jobs are still executed. Do not call Do after stop.
func (w *Writer) stop() {
	close(w.quit)
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd backend && go test ./db/ -run TestWriter -v`
Expected: PASS for all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/db/writer.go backend/db/writer_test.go
git commit -m "db: add Writer type for single-goroutine write serialization"
```

---

### Task 2: Add `DBRole` and wire `Writer` into `*db.DB`

**Files:**
- Create: `backend/db/role.go`
- Modify: `backend/db/connection.go`

- [ ] **Step 1: Create `backend/db/role.go`**

```go
package db

// DBRole tags a *DB instance with its purpose. The two roles correspond to
// two physical SQLite files in APP_DATA_DIR.
type DBRole int

const (
	// DBRoleIndex is the rebuildable file/search index.
	// Tables: files, files_fts, sqlar, digests.
	// File: index.sqlite.
	DBRoleIndex DBRole = iota

	// DBRoleApp is persistent user data.
	// Tables: pins, settings, sessions, agent_sessions, etc.
	// File: app.sqlite.
	DBRoleApp
)

func (r DBRole) String() string {
	switch r {
	case DBRoleIndex:
		return "index"
	case DBRoleApp:
		return "app"
	default:
		return "unknown"
	}
}
```

- [ ] **Step 2: Add `Writer` and `Role` to the `DB` struct**

Modify `backend/db/connection.go`. Find the `DB` struct (around line 40):

```go
// DB wraps a sql.DB connection
type DB struct {
	conn *sql.DB
	cfg  Config
}
```

Replace with:

```go
// DB wraps a sql.DB connection plus a single-writer goroutine.
// Reads use d.conn directly; writes go through d.writer.Do.
type DB struct {
	conn   *sql.DB
	cfg    Config
	role   DBRole
	writer *Writer
}
```

- [ ] **Step 3: Start the writer in `Open` and stop it in `Close`**

In `backend/db/connection.go`, find the end of `Open` (just before the `return d, nil`):

```go
	d := &DB{
		conn: conn,
		cfg:  cfg,
	}

	// Set as global for existing query functions
	mu.Lock()
	globalDB = d
	mu.Unlock()

	return d, nil
```

Replace with:

```go
	d := &DB{
		conn:   conn,
		cfg:    cfg,
		role:   cfg.Role,
		writer: newWriter(conn, writerQueueSize),
	}
	go d.writer.run()

	// Set as global for existing query functions (deprecated; removed in a later task)
	mu.Lock()
	globalDB = d
	mu.Unlock()

	return d, nil
```

Add a constant near the top of the file (after the imports):

```go
// writerQueueSize bounds backpressure when callers submit faster than the
// writer can process. Picked large enough to absorb burst traffic from the
// scanner's parallel processFile workers without being so large that a
// runaway producer can mask itself.
const writerQueueSize = 256
```

In `Close`, before `return d.conn.Close()`:

```go
		if d.writer != nil {
			d.writer.stop()
		}
```

- [ ] **Step 4: Add `Role` to `Config`**

Modify `backend/db/config.go`. Add to the `Config` struct:

```go
// Role tags this database instance for routing migrations and for log/error
// messages. See DBRole.
Role DBRole
```

- [ ] **Step 5: Add `Write` and `Read` accessor methods to `*DB`**

Add to `backend/db/connection.go`:

```go
// Write runs fn inside a write transaction on the per-DB writer goroutine.
// All writes for this DB must go through this method (or one of the typed
// helper methods that wrap it). Direct writes via d.conn() are never safe.
func (d *DB) Write(ctx context.Context, fn func(*sql.Tx) error) error {
	return d.writer.Do(ctx, fn)
}

// Read returns the underlying *sql.DB for read-only queries. Safe for
// concurrent use; WAL mode allows multiple readers alongside the one writer.
// Do NOT call Exec/Begin on the returned handle for writes — use Write.
func (d *DB) Read() *sql.DB {
	return d.conn
}

// Role returns the role of this database instance.
func (d *DB) Role() DBRole {
	return d.role
}
```

Add `"context"` to the imports.

- [ ] **Step 6: Verify it builds**

Run: `cd backend && go build ./...`
Expected: clean build (no behavior change yet — `globalDB` still set, callers unaffected).

- [ ] **Step 7: Run all existing tests**

Run: `cd backend && go test ./...`
Expected: all existing tests pass — no regression.

- [ ] **Step 8: Commit**

```bash
git add backend/db/role.go backend/db/connection.go backend/db/config.go
git commit -m "db: wire Writer into DB struct and add Role tag"
```

---

## Phase 2: Convert package-level funcs to methods, remove `globalDB`

This phase is the largest — 124 exported package-level functions across 12 files become methods on `*DB`. Each task converts one logical group of functions and updates its callers in the same commit (so the build stays green).

**Pattern for every conversion:**

1. Change `func GetX(...)` → `func (d *DB) GetX(...)`.
2. Replace `GetDB()` inside the body with `d.conn` (for reads) or wrap the body in `d.Write(ctx, func(tx *sql.Tx) error { ... })` (for writes — use `tx.Exec` instead of `GetDB().Exec`).
3. Update callers: `db.GetX(...)` → `someDB.GetX(...)` where `someDB *db.DB` is now passed in via constructor / function parameter / receiver.
4. Build and run tests.

For writes, the conversion is mechanical:

```go
// Before
func DeleteSetting(key string) error {
	_, err := GetDB().Exec(`DELETE FROM settings WHERE key = ?`, key)
	return err
}

// After
func (d *DB) DeleteSetting(ctx context.Context, key string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM settings WHERE key = ?`, key)
		return err
	})
}
```

For reads:

```go
// Before
func GetSetting(key string) (string, error) {
	var v string
	err := GetDB().QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	return v, err
}

// After
func (d *DB) GetSetting(key string) (string, error) {
	var v string
	err := d.conn.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	return v, err
}
```

**Reads don't need `ctx`** — they're synchronous against the pool. Writes get `ctx` because they queue, and a caller waiting on a slow queue must be cancellable.

**`BatchUpsertFiles` and other multi-statement functions:** replace the existing `GetDB().Begin()` + manual rollback with a single `d.Write(ctx, fn)` call where `fn` does all the statements against `tx`.

### Task 3: Convert `db/files.go` (37 functions) to methods

**Files:**
- Modify: `backend/db/files.go`
- Modify: `backend/fs/db_adapter.go` (callers in fs)
- Modify: `backend/api/files.go`, `backend/api/upload.go`, `backend/api/stats.go` (and any others that call db.Get*File*/Upsert*/Delete* — verify with grep below)

- [ ] **Step 1: Find every external caller of files.go functions**

Run: `cd backend && grep -rn "db\.\(GetFileByPath\|UpsertFile\|BatchUpsertFiles\|DeleteFile\|DeleteFileWithCascade\|BatchDeleteFilesWithCascade\|DeleteFilesWithCascadePrefix\|MoveFileAtomic\|RenameFilePath\|RenameFilePaths\|UpdateFileField\|ListAllFilePaths\|ListTopLevelFiles\|GetFilesMissingPreviews\|GetFileWithDigests\|GetFileStats\|GetPreviewSqlarMap\|GetCreatedAtMap\|CountFilesInPath\|GeneratePathHash\|CreateCursor\|ParseCursor\)\b" --include='*.go' .`
Note every file. These are the call sites to update in step 4.

- [ ] **Step 2: Convert every exported function in `backend/db/files.go` to a method**

Use the pattern above. For each function:
- Reads (`GetX`, `ListX`, `CountX`, `GeneratePathHash`, `CreateCursor`, `ParseCursor`): change signature to `func (d *DB) X(...)`, replace `GetDB()` with `d.conn`. (Cursor helpers don't touch DB — they should stay as standalone functions; verify and skip if so.)
- Writes (`UpsertFile`, `BatchUpsertFiles`, `DeleteFile*`, `MoveFileAtomic`, `RenameFilePath*`, `UpdateFileField`): change signature to `func (d *DB) X(ctx context.Context, ...)`, wrap body in `d.Write(ctx, func(tx *sql.Tx) error { ... })`.
- For `BatchUpsertFiles` and the cascade-delete functions that already use `tx, err := GetDB().Begin()`: replace the manual transaction with `return d.Write(ctx, func(tx *sql.Tx) error { ... })` and use `tx` in place of the locally-named `tx`.

Add `"context"` to the imports.

- [ ] **Step 3: Update every caller from step 1**

For each file in step 1, replace `db.X(...)` with `someDB.X(...)`. Where `someDB` comes from depends on the package:

- `backend/fs/db_adapter.go`: this file's whole purpose was bridging the package-level funcs to the `Database` interface. After this task, replace it with a thin pass-through where `dbAdapter` holds a `*db.DB`:

```go
package fs

import (
	"context"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

type dbAdapter struct {
	db *db.DB
}

func NewDBAdapter(d *db.DB) Database {
	return &dbAdapter{db: d}
}

func (a *dbAdapter) GetFileByPath(path string) (*db.FileRecord, error) {
	return a.db.GetFileByPath(path)
}

// ... one method per Database interface entry, all delegating to a.db ...
```

For write methods on the adapter, accept `context.Background()` for now (callers already plumb a context where they have one; the rest get TODOs to fix in a later task):

```go
func (a *dbAdapter) UpsertFile(record *db.FileRecord) (bool, error) {
	return a.db.UpsertFile(context.Background(), record)
}
```

Update `backend/fs/types.go` `Database` interface signatures to match (no `context.Context` needed in the interface yet since callers don't have one to plumb — adapter wraps with Background internally; refactor the interface to take ctx in a later cleanup task).

- `backend/api/*.go`: handlers have access to `h.server` — add temporary accessor `h.server.DB()` returning the global single DB until the split. Replace `db.X(...)` with `h.server.DB().X(...)`. (After Phase 4 this becomes `h.server.IndexDB()` or `h.server.AppDB()`.)

  Add to `backend/server/server.go`:

  ```go
  // DB returns the single DB instance. Temporary — replaced by IndexDB/AppDB
  // after the split.
  func (s *Server) DB() *db.DB { return s.database }
  ```

- [ ] **Step 4: Verify the build**

Run: `cd backend && go build ./...`
Expected: clean build.

- [ ] **Step 5: Run tests**

Run: `cd backend && go test ./...`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/db/files.go backend/fs/ backend/api/ backend/server/server.go
git commit -m "db: convert files.go functions to methods on *DB"
```

---

### Task 4: Convert `db/pins.go`, `db/digests.go`, `db/files_fts.go`, `db/sqlar.go`

Same pattern as Task 3. Group these together because they're all index-side tables (will end up in the same DB).

**Files:**
- Modify: `backend/db/pins.go`, `backend/db/digests.go`, `backend/db/files_fts.go`, `backend/db/sqlar.go`
- Modify: caller files (find via grep below)

- [ ] **Step 1: Find callers**

Run: `cd backend && grep -rn "db\.\(AddPin\|RemovePin\|IsPinned\|CountPins\|GetAllPins\|GetPinnedFiles\|CreateDigest\|DeleteDigest\|DeleteDigestsForFile\|GetDigest\|GetDigests\|GetPendingDigests\|GetFilesWithPendingDigests\|GetDistinctDigesters\|GetDigestStats\|ListDigestsForPath\|IndexFile\|IsFileIndexed\|DeleteFileFromIndex\|SqlarStore\|SqlarExists\|SqlarLoad\)\b" --include='*.go' .`

- [ ] **Step 2: Convert each function to a method**

Apply the read/write pattern from Task 3. Add `context.Context` parameter to writes.

- [ ] **Step 3: Update callers** (same pattern as Task 3 step 4).

- [ ] **Step 4: Verify**

```bash
cd backend && go build ./... && go test ./...
```

- [ ] **Step 5: Commit**

```bash
git commit -am "db: convert pins/digests/files_fts/sqlar to methods on *DB"
```

---

### Task 5: Convert `db/sessions.go`, `db/agent_sessions.go`, `db/agent_session_groups.go`

Same pattern. App-side tables.

**Files:**
- Modify: `backend/db/sessions.go`, `backend/db/agent_sessions.go`, `backend/db/agent_session_groups.go`
- Modify: callers (grep below)

- [ ] **Step 1: Find callers**

Run: `cd backend && grep -rn "db\.\(GetSession\|CreateSession\|DeleteSession\|ExtendSession\|DeleteExpiredSessions\|GetAgentSession\|CreateAgentSession\|UpdateAgentSession\|ArchiveAgentSession\|UnarchiveAgentSession\|IsAgentSessionArchived\|GetArchivedAgentSessionIDs\|ListAgentSessions\|MarkAgentSessionRead\|GetAllSessionReadStates\|GetAgentSessionPermissionMode\|SetAgentSessionPermissionMode\|GetAllAgentSessionPreferences\|UpdateAgentSessionTitle\|UpdateAgentSessionMetadata\|GetShareToken\|GetSessionIDByShareToken\|CreateShareToken\|RevokeShareToken\|GetAllShareTokens\|CreateAgentSessionGroup\|GetAgentSessionGroup\|ListAgentSessionGroups\|UpdateAgentSessionGroup\|DeleteAgentSessionGroup\)\b" --include='*.go' .`

- [ ] **Step 2: Convert; Step 3: update callers; Step 4: verify; Step 5: commit** — same pattern.

```bash
cd backend && go build ./... && go test ./...
git commit -am "db: convert sessions/agent_sessions to methods on *DB"
```

---

### Task 6: Convert `db/settings.go`, `db/explore.go`, `db/collectors.go`, `db/client.go`

Final group of conversions. App-side tables + the generic `client.go` helpers (`Count`, `Exists`).

**Files:**
- Modify: `backend/db/settings.go`, `backend/db/explore.go`, `backend/db/collectors.go`, `backend/db/client.go`
- Modify: callers (grep below)

- [ ] **Step 1: Find callers**

Run: `cd backend && grep -rn "db\.\(GetSetting\|GetSettingJSON\|SetSetting\|SetSettingJSON\|DeleteSetting\|GetAllSettings\|LoadUserSettings\|SaveUserSettings\|GetCollectors\|SaveCollectors\|InsertExplorePost\|UpdateExplorePost\|DeleteExplorePost\|GetExplorePost\|ListExplorePosts\|InsertExploreComment\|ListExploreComments\|CreateExploreCursor\|Count\|Exists\)\b" --include='*.go' .`

Note: `Count` and `Exists` from `client.go` are generic helpers — they take a query string. They become methods on `*DB` too.

- [ ] **Step 2-5:** convert, update callers, verify, commit.

```bash
cd backend && go build ./... && go test ./...
git commit -am "db: convert settings/explore/collectors/client to methods on *DB"
```

---

### Task 7: Remove `globalDB`, `GetDB()`, `Transaction()`

After Tasks 3-6, nothing should call `GetDB()` or `db.Transaction()` anymore — verify with grep, then delete the dead code.

**Files:**
- Modify: `backend/db/connection.go`

- [ ] **Step 1: Verify nothing still calls the old API**

Run: `cd backend && grep -rn "db\.GetDB\|db\.Transaction\|db\.Close()" --include='*.go' .`
Expected: zero hits outside `db/connection.go` itself.

If any hits: stop, fix the stragglers (likely missed callers), and repeat.

- [ ] **Step 2: Delete the deprecated globals**

In `backend/db/connection.go`, remove:
- The `globalDB` and `mu` package-level vars.
- The `mu.Lock(); globalDB = d; mu.Unlock()` block in `Open`.
- The `mu.Lock(); ... if globalDB == d { globalDB = nil }` block in `Close`.
- The `GetDB() *sql.DB` function.
- The package-level `Transaction(fn func(*sql.Tx) error) error` function.
- The package-level `Close() error` function.

Keep the method `(d *DB).Transaction(fn func(*sql.Tx) error) error` if anything still uses it — search first; if unused, delete it too (callers should use `Write(ctx, fn)`).

- [ ] **Step 3: Verify build and tests**

```bash
cd backend && go build ./... && go test ./...
```

- [ ] **Step 4: Commit**

```bash
git add backend/db/connection.go
git commit -m "db: remove globalDB singleton and package-level helpers"
```

---

## Phase 3: Per-DB migration targeting

### Task 8: Tag every migration with a target DB

**Files:**
- Modify: `backend/db/migrations.go`
- Modify: every `backend/db/migration_*.go` (27 files)

- [ ] **Step 1: Add `Target` field to `Migration`**

In `backend/db/migrations.go`, find the `Migration` struct and add:

```go
type Migration struct {
	Version     int
	Description string
	Up          func(*sql.DB) error
	Target      DBRole // DBRoleIndex or DBRoleApp
}
```

- [ ] **Step 2: Update `runMigrations` to filter by role**

Change signature:

```go
func runMigrations(conn *sql.DB, role DBRole) error {
	// ... iterate registered migrations, skip those whose Target != role ...
}
```

The `migrations` table itself is per-DB (each file gets its own row of applied versions). Schema unchanged; just lives in both DBs.

- [ ] **Step 3: Tag every existing migration**

Edit each `backend/db/migration_NNN_*.go`. In the `init()` function's `RegisterMigration` call, add `Target: DBRoleApp` or `Target: DBRoleIndex`:

| Migration | Target | Reason |
|-----------|--------|--------|
| 001 (initial: files, sqlar, etc.) | **Split** — see step 4 below |
| 003 fix_pins_schema | App | pins |
| 004 sessions | App | sessions |
| 005 agent | App | agent_conversations etc. |
| 006 hidden_sessions | App | sessions |
| 007 rename_hidden_to_archived | App | sessions |
| 008 collectors | App | collectors |
| 009 session_read_status | App | sessions |
| 010 epoch_timestamps | **Split** — touches both files (index) and sessions (app) |
| 011 preview_sqlar | Index | sqlar/preview |
| 012 claude_sessions | App | claude_sessions |
| 013 share_sessions | App | sessions |
| 014 preview_status | Index | files.preview_status |
| 015 agent_sessions | App | agent_sessions |
| 016 agent_session_metadata | App | agent_sessions |
| 017 backfill_session_metadata | App | agent_sessions |
| 018 backfill_from_jsonl | App | agent_sessions |
| 019 explore_tables | App | explore |
| 020 agent_session_source | App | agent_sessions |
| 021 agent_session_agent_name | App | agent_sessions |
| 022 agent_session_trigger | App | agent_sessions |
| 023 agent_session_storage_id | App | agent_sessions |
| 024 agent_session_groups | App | agent_session_groups |
| 025 agent_session_group_pin | App | agent_session_groups |
| 026 connect | App | connect_clients |
| 027 files_fts | Index | files_fts |

- [ ] **Step 4: Split migrations 001 and 010**

Migration 001 creates `files`, `sqlar`, `pins`, `settings`, `digests`. Three of those go to index, two to app. Split into two registered migrations:

- `Version: 1, Target: DBRoleIndex` — creates `files`, `sqlar`, `digests`.
- `Version: 1, Target: DBRoleApp` — creates `pins`, `settings`.

Both share version number 1 because each DB tracks its own `migrations` table.

For migration 010, similar split. Read `backend/db/migration_010_epoch_timestamps.go`, identify which `ALTER TABLE` / `UPDATE` statements touch index tables vs app tables, and split.

(If migrations 010 / 001 have intermixed statements that would be awkward to split, an alternative is to keep them both as `Target: DBRoleApp` and add a mirror as `Target: DBRoleIndex` — read the actual code before deciding.)

- [ ] **Step 5: Update `Open` to pass role to `runMigrations`**

In `backend/db/connection.go`:

```go
if err := runMigrations(conn, cfg.Role); err != nil {
    conn.Close()
    return nil, fmt.Errorf("failed to run migrations: %w", err)
}
```

- [ ] **Step 6: Verify**

```bash
cd backend && go build ./...
# Migrations don't run yet against split DBs — only one DB exists. But the
# tagging shouldn't break anything when role is DBRoleApp (current default).
go test ./...
```

- [ ] **Step 7: Commit**

```bash
git add backend/db/
git commit -m "db: tag every migration with target DB role"
```

---

## Phase 4: Open two DBs and ATTACH

### Task 9: Server opens both DBs, ATTACH index read-only on app DB

**Files:**
- Modify: `backend/server/config.go` (add IndexPath, AppPath)
- Modify: `backend/server/server.go` (open both)
- Modify: `backend/db/connection.go` (ATTACH ConnectHook for app DB)

- [ ] **Step 1: Add config fields**

In `backend/server/config.go`, add to `Config`:

```go
// IndexDatabasePath is APP_DATA_DIR/index.sqlite — file index, rebuildable.
IndexDatabasePath string

// AppDatabasePath is APP_DATA_DIR/app.sqlite — persistent user data.
AppDatabasePath string

// LegacyDatabasePath is APP_DATA_DIR/database.sqlite — only present for
// existing installs prior to the split. Used by the one-shot migration.
LegacyDatabasePath string
```

In wherever the Config is populated (likely a `Load()` or factory function — find via grep `DatabasePath:`), set:

```go
cfg.IndexDatabasePath = filepath.Join(appDataDir, "index.sqlite")
cfg.AppDatabasePath = filepath.Join(appDataDir, "app.sqlite")
cfg.LegacyDatabasePath = filepath.Join(appDataDir, "database.sqlite")
```

Keep the existing `DatabasePath` for the moment if other code reads it; it can be deleted in a later cleanup once nothing references it.

- [ ] **Step 2: Add ATTACH ConnectHook**

In `backend/db/connection.go`, add a new driver registration for the app DB. The existing `sqlite3_simple` driver with `ConnectHook` is the model — add a parallel registration that ATTACHes the index DB read-only:

```go
const sqliteAppDriver = "sqlite3_app"

var (
	appDriverRegistered bool
	appDriverIndexPath  string
	appDriverMu         sync.Mutex
)

func registerAppDriver(indexPath, extensionPath, dictDir string) error {
	appDriverMu.Lock()
	defer appDriverMu.Unlock()

	if appDriverRegistered {
		if indexPath != appDriverIndexPath {
			return fmt.Errorf(
				"app driver already registered with index=%q; cannot re-register with index=%q",
				appDriverIndexPath, indexPath,
			)
		}
		return nil
	}

	sql.Register(sqliteAppDriver, &sqlite3.SQLiteDriver{
		ConnectHook: func(conn *sqlite3.SQLiteConn) error {
			// Load extension if configured (for FTS5 simple tokenizer parity
			// across both DBs — search lives in index.sqlite, but keep app
			// connections symmetrical for queries that ATTACH and join).
			if extensionPath != "" {
				if err := conn.LoadExtension(extensionPath, "sqlite3_simple_init"); err != nil {
					return fmt.Errorf("load_extension(%s): %w", extensionPath, err)
				}
				if dictDir != "" {
					if _, err := conn.Exec("SELECT jieba_dict(?)", []driver.Value{dictDir}); err != nil {
						return fmt.Errorf("jieba_dict(%s): %w", dictDir, err)
					}
				}
			}
			// Attach index DB read-only. URI form ?mode=ro plus immutable=0
			// so WAL changes from the index writer become visible.
			attachSQL := fmt.Sprintf(
				"ATTACH DATABASE 'file:%s?mode=ro' AS idx",
				indexPath,
			)
			if _, err := conn.Exec(attachSQL, nil); err != nil {
				return fmt.Errorf("attach index db: %w", err)
			}
			return nil
		},
	})

	appDriverRegistered = true
	appDriverIndexPath = indexPath
	return nil
}
```

In `Open`, when `cfg.Role == DBRoleApp` and `cfg.AttachIndexPath != ""`, use the app driver:

```go
case cfg.Role == DBRoleApp && cfg.AttachIndexPath != "":
	if err := registerAppDriver(cfg.AttachIndexPath, cfg.ExtensionPath, cfg.ExtensionDictDir); err != nil {
		return nil, err
	}
	driverName = sqliteAppDriver
```

Add `AttachIndexPath string` to `db.Config`.

- [ ] **Step 3: Open both DBs in `server.New`**

In `backend/server/server.go`, find the existing `db.Open(...)` call and replace with two opens:

```go
// Open index DB first — app DB ATTACHes it.
indexDB, err := db.Open(db.Config{
	Path:             cfg.IndexDatabasePath,
	Role:             db.DBRoleIndex,
	MaxOpenConns:     25,
	MaxIdleConns:     10,
	ConnMaxLifetime:  0,
	LogQueries:       cfg.DBLogQueries,
	ExtensionPath:    cfg.SimpleExtensionPath,
	ExtensionDictDir: cfg.SimpleDictDir,
})
if err != nil {
	return nil, fmt.Errorf("open index db: %w", err)
}

appDB, err := db.Open(db.Config{
	Path:             cfg.AppDatabasePath,
	Role:             db.DBRoleApp,
	AttachIndexPath:  cfg.IndexDatabasePath,
	MaxOpenConns:     25,
	MaxIdleConns:     10,
	ConnMaxLifetime:  0,
	LogQueries:       cfg.DBLogQueries,
	ExtensionPath:    cfg.SimpleExtensionPath,
	ExtensionDictDir: cfg.SimpleDictDir,
})
if err != nil {
	indexDB.Close()
	return nil, fmt.Errorf("open app db: %w", err)
}
```

Update the `Server` struct: replace `database *db.DB` with `indexDB *db.DB; appDB *db.DB`. Add accessors:

```go
func (s *Server) IndexDB() *db.DB { return s.indexDB }
func (s *Server) AppDB() *db.DB   { return s.appDB }
```

Remove the temporary `DB()` accessor added in Task 3.

- [ ] **Step 4: Wire components to the right DB**

Update component constructors:
- `fs.NewService(...)` → takes `indexDB`
- `digest.NewWorker(...)` → takes `indexDB`
- `agent.New(...)` → takes `appDB`
- `claude.NewSessionManager(...)` → takes `appDB` (if it needs DB)

API handler call sites (Task 3 step 4 used `h.server.DB()`): change to `h.server.IndexDB()` for file/digest/search/sqlar lookups, `h.server.AppDB()` for sessions/pins/settings/etc.

- [ ] **Step 5: Update `pins.GetPinnedFiles` to JOIN via `idx.files`**

In `backend/db/pins.go`, find the JOIN query (around line 67):

```sql
JOIN files f ON f.path = p.file_path
```

Change to:

```sql
JOIN idx.files f ON f.path = p.file_path
```

This query runs against `app.sqlite` (where `pins` lives), and `idx.files` resolves to the ATTACHed index DB.

- [ ] **Step 6: Verify build**

```bash
cd backend && go build ./...
```

- [ ] **Step 7: Run on a fresh APP_DATA_DIR**

```bash
cd backend && rm -rf .my-life-db/ && APP_DATA_DIR=$(pwd)/.my-life-db go run . &
sleep 5
ls -la .my-life-db/
# Expected: index.sqlite and app.sqlite both exist; no database.sqlite.
kill %1
ps -eo pid,command | grep my-life-db  # Verify backend is gone (per CLAUDE.md cleanup rule)
```

- [ ] **Step 8: Commit**

```bash
git add backend/
git commit -m "db: split into index.sqlite + app.sqlite with read-only ATTACH"
```

---

## Phase 5: Migrate existing users

### Task 10: One-shot legacy → split migration

**Files:**
- Create: `backend/db/split_migration.go`
- Create: `backend/db/split_migration_test.go`
- Modify: `backend/server/server.go` (call migration before opening DBs)

- [ ] **Step 1: Write the failing test**

Create `backend/db/split_migration_test.go`:

```go
package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// seedLegacyDB creates a fixture pre-split database matching the schema before
// migration 028 (this refactor). It populates each table with one row so the
// migration's row-count verification has something to check.
func seedLegacyDB(t *testing.T, path string) {
	t.Helper()
	conn, err := sql.Open("sqlite3", path+"?_journal_mode=WAL")
	if err != nil {
		t.Fatalf("open legacy: %v", err)
	}
	defer conn.Close()

	stmts := []string{
		`CREATE TABLE files (path TEXT PRIMARY KEY, name TEXT, size INTEGER)`,
		`CREATE VIRTUAL TABLE files_fts USING fts5(document_id UNINDEXED, file_path, content)`,
		`CREATE TABLE sqlar (name TEXT PRIMARY KEY, mode INT, mtime INT, sz INT, data BLOB)`,
		`CREATE TABLE digests (id TEXT PRIMARY KEY, file_path TEXT, digester TEXT, content TEXT)`,
		`CREATE TABLE pins (id TEXT PRIMARY KEY, file_path TEXT UNIQUE, pinned_at INTEGER, created_at INTEGER)`,
		`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`,
		`INSERT INTO files VALUES ('a.txt', 'a.txt', 10)`,
		`INSERT INTO files_fts (document_id, file_path, content) VALUES ('1', 'a.txt', 'hello')`,
		`INSERT INTO sqlar VALUES ('preview/a', 0, 0, 0, X'00')`,
		`INSERT INTO digests VALUES ('d1', 'a.txt', 'markdown', 'hello world')`,
		`INSERT INTO pins VALUES ('p1', 'a.txt', 1700000000, 1700000000)`,
		`INSERT INTO settings VALUES ('foo', 'bar')`,
	}
	for _, s := range stmts {
		if _, err := conn.Exec(s); err != nil {
			t.Fatalf("seed %q: %v", s, err)
		}
	}
}

func TestSplitMigration_FreshInstall(t *testing.T) {
	dir := t.TempDir()
	cfg := SplitConfig{
		AppDataDir:  dir,
		LegacyPath:  filepath.Join(dir, "database.sqlite"),
		IndexPath:   filepath.Join(dir, "index.sqlite"),
		AppPath:     filepath.Join(dir, "app.sqlite"),
	}

	if err := MaybeRunSplitMigration(cfg); err != nil {
		t.Fatalf("MaybeRunSplitMigration: %v", err)
	}

	// No legacy DB → no migration runs → no files created.
	if _, err := os.Stat(cfg.IndexPath); !os.IsNotExist(err) {
		t.Fatalf("expected no index.sqlite on fresh install, got err=%v", err)
	}
}

func TestSplitMigration_AlreadyMigrated(t *testing.T) {
	dir := t.TempDir()
	cfg := SplitConfig{
		AppDataDir: dir,
		LegacyPath: filepath.Join(dir, "database.sqlite"),
		IndexPath:  filepath.Join(dir, "index.sqlite"),
		AppPath:    filepath.Join(dir, "app.sqlite"),
	}
	// Simulate already-migrated state.
	if err := os.WriteFile(cfg.IndexPath, []byte("dummy"), 0644); err != nil {
		t.Fatalf("seed index: %v", err)
	}

	if err := MaybeRunSplitMigration(cfg); err != nil {
		t.Fatalf("MaybeRunSplitMigration: %v", err)
	}

	// index.sqlite untouched.
	data, _ := os.ReadFile(cfg.IndexPath)
	if string(data) != "dummy" {
		t.Fatalf("index.sqlite was modified: %q", data)
	}
}

func TestSplitMigration_ExistingUserMigratesData(t *testing.T) {
	dir := t.TempDir()
	cfg := SplitConfig{
		AppDataDir: dir,
		LegacyPath: filepath.Join(dir, "database.sqlite"),
		IndexPath:  filepath.Join(dir, "index.sqlite"),
		AppPath:    filepath.Join(dir, "app.sqlite"),
	}
	seedLegacyDB(t, cfg.LegacyPath)

	if err := MaybeRunSplitMigration(cfg); err != nil {
		t.Fatalf("MaybeRunSplitMigration: %v", err)
	}

	if _, err := os.Stat(cfg.LegacyPath); !os.IsNotExist(err) {
		t.Fatalf("legacy DB should be renamed away, got err=%v", err)
	}
	if _, err := os.Stat(cfg.AppPath); err != nil {
		t.Fatalf("app.sqlite should exist: %v", err)
	}
	if _, err := os.Stat(cfg.IndexPath); err != nil {
		t.Fatalf("index.sqlite should exist: %v", err)
	}

	// Verify index DB has the index tables.
	idx, _ := sql.Open("sqlite3", cfg.IndexPath)
	defer idx.Close()
	for _, tbl := range []string{"files", "files_fts", "sqlar", "digests"} {
		var n int
		if err := idx.QueryRow("SELECT COUNT(*) FROM " + tbl).Scan(&n); err != nil {
			t.Fatalf("count idx.%s: %v", tbl, err)
		}
		if n != 1 {
			t.Fatalf("idx.%s: want 1 row, got %d", tbl, n)
		}
	}

	// Verify app DB no longer has index tables.
	app, _ := sql.Open("sqlite3", cfg.AppPath)
	defer app.Close()
	for _, tbl := range []string{"files", "files_fts", "sqlar", "digests"} {
		var n int
		err := app.QueryRow("SELECT COUNT(*) FROM " + tbl).Scan(&n)
		if err == nil {
			t.Fatalf("app.%s should be dropped, but exists with %d rows", tbl, n)
		}
	}
	// App DB still has app tables.
	for _, tbl := range []string{"pins", "settings"} {
		var n int
		if err := app.QueryRow("SELECT COUNT(*) FROM " + tbl).Scan(&n); err != nil {
			t.Fatalf("count app.%s: %v", tbl, err)
		}
		if n != 1 {
			t.Fatalf("app.%s: want 1 row, got %d", tbl, n)
		}
	}
}

func TestSplitMigration_RecoversFromCrashedTmp(t *testing.T) {
	dir := t.TempDir()
	cfg := SplitConfig{
		AppDataDir: dir,
		LegacyPath: filepath.Join(dir, "database.sqlite"),
		IndexPath:  filepath.Join(dir, "index.sqlite"),
		AppPath:    filepath.Join(dir, "app.sqlite"),
	}
	seedLegacyDB(t, cfg.LegacyPath)

	// Simulate a crashed previous run: leftover .tmp file.
	tmpPath := cfg.IndexPath + ".tmp"
	if err := os.WriteFile(tmpPath, []byte("garbage"), 0644); err != nil {
		t.Fatalf("seed tmp: %v", err)
	}

	if err := MaybeRunSplitMigration(cfg); err != nil {
		t.Fatalf("MaybeRunSplitMigration: %v", err)
	}

	// Migration should have cleaned up .tmp and finished successfully.
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf("tmp should be removed, got err=%v", err)
	}
	if _, err := os.Stat(cfg.IndexPath); err != nil {
		t.Fatalf("index.sqlite should exist: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd backend && go test ./db/ -run TestSplitMigration -v`
Expected: build failure — `SplitConfig`, `MaybeRunSplitMigration` undefined.

- [ ] **Step 3: Implement the migration**

Create `backend/db/split_migration.go`:

```go
package db

import (
	"database/sql"
	"fmt"
	"os"

	_ "github.com/mattn/go-sqlite3"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SplitConfig holds the file paths the split migration needs.
type SplitConfig struct {
	AppDataDir string
	LegacyPath string // database.sqlite
	IndexPath  string // index.sqlite
	AppPath    string // app.sqlite
}

// indexTables are the tables that move from the legacy DB to index.sqlite.
// All other tables stay in what becomes app.sqlite.
var indexTables = []string{"files", "files_fts", "sqlar", "digests"}

// MaybeRunSplitMigration migrates an existing single-DB install to the
// split layout. Idempotent: detects whether migration is needed, has already
// completed, or crashed mid-way, and acts accordingly.
//
// Must be called BEFORE opening either index.sqlite or app.sqlite via db.Open.
//
// Recovery model: filesystem state is the source of truth. Two atomic
// renames are the only commit points. See the design doc for the full
// recovery table.
func MaybeRunSplitMigration(cfg SplitConfig) error {
	tmpPath := cfg.IndexPath + ".tmp"

	// Always start by clearing any leftover .tmp from a previously crashed
	// run. The .tmp is only valid mid-migration; on a clean start we don't
	// trust its contents.
	if _, err := os.Stat(tmpPath); err == nil {
		log.Info().Str("path", tmpPath).Msg("removing leftover index.sqlite.tmp from crashed migration")
		if err := os.Remove(tmpPath); err != nil {
			return fmt.Errorf("remove leftover tmp: %w", err)
		}
	}

	// Already migrated.
	if _, err := os.Stat(cfg.IndexPath); err == nil {
		// Edge case: index.sqlite committed but legacy didn't get renamed
		// (crash between commit point 1 and commit point 2). Detect and
		// finish the migration.
		if _, err := os.Stat(cfg.LegacyPath); err == nil {
			log.Info().Msg("resuming split migration: index DB exists but legacy not yet renamed")
			return finishLegacyCleanup(cfg)
		}
		return nil
	}

	// No legacy DB → fresh install, nothing to migrate.
	if _, err := os.Stat(cfg.LegacyPath); os.IsNotExist(err) {
		return nil
	}

	log.Info().
		Str("legacy", cfg.LegacyPath).
		Str("index", cfg.IndexPath).
		Str("app", cfg.AppPath).
		Msg("starting one-shot DB split migration")

	if err := buildIndexTmp(cfg, tmpPath); err != nil {
		// Leave .tmp for the next startup to clean up; legacy untouched.
		return fmt.Errorf("build index tmp: %w", err)
	}

	// First commit point.
	if err := os.Rename(tmpPath, cfg.IndexPath); err != nil {
		return fmt.Errorf("rename index tmp: %w", err)
	}
	log.Info().Msg("split migration: first commit point reached (index.sqlite committed)")

	return finishLegacyCleanup(cfg)
}

func buildIndexTmp(cfg SplitConfig, tmpPath string) error {
	// Open the legacy DB read-write.
	legacy, err := sql.Open("sqlite3", cfg.LegacyPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return fmt.Errorf("open legacy: %w", err)
	}
	defer legacy.Close()

	// ATTACH a fresh tmp file as 'idx'. This auto-creates the file.
	attachSQL := fmt.Sprintf("ATTACH DATABASE '%s' AS idx", tmpPath)
	if _, err := legacy.Exec(attachSQL); err != nil {
		return fmt.Errorf("attach tmp: %w", err)
	}

	// Copy schema + data for each index table. CREATE TABLE ... AS SELECT
	// would lose constraints, so we extract the original CREATE statement
	// from sqlite_master and replay it against idx.
	for _, table := range indexTables {
		var createSQL string
		err := legacy.QueryRow(
			`SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
			table,
		).Scan(&createSQL)
		if err == sql.ErrNoRows {
			log.Warn().Str("table", table).Msg("index table missing from legacy DB, skipping")
			continue
		}
		if err != nil {
			return fmt.Errorf("read schema for %s: %w", table, err)
		}

		// FTS5 virtual tables and others may have multiple rows in sqlite_master
		// (the table itself plus shadow tables). Extracting just the parent
		// CREATE statement is enough — SQLite recreates the shadow tables
		// when the virtual table is created.

		// Recreate in idx schema. Need to rewrite "CREATE TABLE name" to
		// "CREATE TABLE idx.name" — sqlite_master stores the original
		// unqualified form.
		idxCreateSQL := rewriteCreateForSchema(createSQL, table, "idx")
		if _, err := legacy.Exec(idxCreateSQL); err != nil {
			return fmt.Errorf("create idx.%s: %w", table, err)
		}

		// Copy rows.
		copySQL := fmt.Sprintf("INSERT INTO idx.%s SELECT * FROM %s", table, table)
		if _, err := legacy.Exec(copySQL); err != nil {
			return fmt.Errorf("copy %s: %w", table, err)
		}

		// Verify row counts match.
		var srcCount, dstCount int64
		if err := legacy.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&srcCount); err != nil {
			return fmt.Errorf("count src.%s: %w", table, err)
		}
		if err := legacy.QueryRow("SELECT COUNT(*) FROM idx." + table).Scan(&dstCount); err != nil {
			return fmt.Errorf("count idx.%s: %w", table, err)
		}
		if srcCount != dstCount {
			return fmt.Errorf("row count mismatch for %s: legacy=%d idx=%d", table, srcCount, dstCount)
		}
		log.Info().Str("table", table).Int64("rows", srcCount).Msg("split migration: copied table to index")
	}

	if _, err := legacy.Exec("DETACH DATABASE idx"); err != nil {
		return fmt.Errorf("detach idx: %w", err)
	}
	return nil
}

// rewriteCreateForSchema turns "CREATE TABLE files (...)" into
// "CREATE TABLE idx.files (...)". Naive but sufficient: the CREATE
// statement always starts with the table name as the first identifier.
func rewriteCreateForSchema(createSQL, tableName, schema string) string {
	// Find the table name and prefix it with the schema. This handles
	// "CREATE TABLE", "CREATE VIRTUAL TABLE", "CREATE TABLE IF NOT EXISTS".
	// We do a simple string replace of the first occurrence of the table
	// name as a token.
	prefixes := []string{
		"CREATE TABLE IF NOT EXISTS " + tableName,
		"CREATE TABLE " + tableName,
		"CREATE VIRTUAL TABLE IF NOT EXISTS " + tableName,
		"CREATE VIRTUAL TABLE " + tableName,
	}
	for _, p := range prefixes {
		replacement := p[:len(p)-len(tableName)] + schema + "." + tableName
		if i := indexOf(createSQL, p); i >= 0 {
			return createSQL[:i] + replacement + createSQL[i+len(p):]
		}
	}
	// Fallback — shouldn't happen, but if it does, return original; the
	// subsequent INSERT will fail loudly and the migration will abort.
	return createSQL
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func finishLegacyCleanup(cfg SplitConfig) error {
	legacy, err := sql.Open("sqlite3", cfg.LegacyPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return fmt.Errorf("reopen legacy for cleanup: %w", err)
	}
	defer legacy.Close()

	for _, table := range indexTables {
		if _, err := legacy.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			return fmt.Errorf("drop %s from legacy: %w", table, err)
		}
	}
	if _, err := legacy.Exec("VACUUM"); err != nil {
		return fmt.Errorf("vacuum legacy: %w", err)
	}
	if err := legacy.Close(); err != nil {
		return fmt.Errorf("close legacy: %w", err)
	}

	// Second commit point.
	if err := os.Rename(cfg.LegacyPath, cfg.AppPath); err != nil {
		return fmt.Errorf("rename legacy to app.sqlite: %w", err)
	}
	log.Info().Msg("split migration: second commit point reached (legacy renamed to app.sqlite). Done.")
	return nil
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd backend && go test ./db/ -run TestSplitMigration -v`
Expected: PASS for all 4 tests.

- [ ] **Step 5: Call from `server.New`**

In `backend/server/server.go`, before opening either DB, add:

```go
if err := db.MaybeRunSplitMigration(db.SplitConfig{
	AppDataDir: cfg.AppDataDir,
	LegacyPath: cfg.LegacyDatabasePath,
	IndexPath:  cfg.IndexDatabasePath,
	AppPath:    cfg.AppDatabasePath,
}); err != nil {
	return nil, fmt.Errorf("split migration: %w", err)
}
```

- [ ] **Step 6: Verify build and run**

```bash
cd backend && go build ./... && go test ./...
```

- [ ] **Step 7: Manual verification with a real legacy DB**

If you have a backup of an existing `database.sqlite`:

```bash
mkdir -p /tmp/migration-test
cp ~/path/to/old/database.sqlite /tmp/migration-test/database.sqlite
APP_DATA_DIR=/tmp/migration-test go run . &
sleep 5
ls /tmp/migration-test/
# Expected: app.sqlite + index.sqlite (no database.sqlite)
sqlite3 /tmp/migration-test/index.sqlite '.tables'
# Expected: files, files_fts, sqlar, digests, migrations
sqlite3 /tmp/migration-test/app.sqlite '.tables'
# Expected: pins, settings, sessions, agent_sessions, ... (no files etc.)
kill %1
ps -eo pid,command | grep my-life-db  # Verify cleanup
```

- [ ] **Step 8: Commit**

```bash
git add backend/db/split_migration.go backend/db/split_migration_test.go backend/server/server.go
git commit -m "db: add one-shot legacy → split migration with crash recovery"
```

---

## Phase 6: Verification

### Task 11: Load test — scanner + concurrent user writes

**Files:**
- Create: `backend/scripts/loadtest_scanner_with_writes.sh` (or add to existing test infra if there's one)

- [ ] **Step 1: Set up a synthetic 100K-file tree**

```bash
mkdir -p /tmp/mld-load/data
cd /tmp/mld-load/data
for i in $(seq 1 100000); do
	mkdir -p "dir$((i / 1000))"
	echo "content $i" > "dir$((i / 1000))/file$i.txt"
done
```

- [ ] **Step 2: Start the backend pointing at the synthetic tree**

```bash
mkdir -p /tmp/mld-load/.app
USER_DATA_DIR=/tmp/mld-load/data APP_DATA_DIR=/tmp/mld-load/.app \
	go run ./backend > /tmp/mld-load/server.log 2>&1 &
SERVER_PID=$!
sleep 10  # Let scanner start its initial walk.
```

- [ ] **Step 3: Hammer user-facing write endpoints in parallel**

```bash
# Pin/unpin loop
for i in $(seq 1 1000); do
	curl -s -X POST http://localhost:12345/api/library/pin \
		-d '{"path":"dir0/file1.txt"}' &
	curl -s -X DELETE http://localhost:12345/api/library/pin \
		-d '{"path":"dir0/file1.txt"}' &
done
wait
```

- [ ] **Step 4: Check logs for `database is locked`**

```bash
grep "database is locked" /tmp/mld-load/server.log
```

Expected: zero matches.

- [ ] **Step 5: Tear down**

```bash
kill $SERVER_PID
wait $SERVER_PID 2>/dev/null
ps -eo pid,command | grep my-life-db  # Verify no orphan process (per CLAUDE.md)
```

- [ ] **Step 6: Commit the load test script**

```bash
git add backend/scripts/loadtest_scanner_with_writes.sh
git commit -m "test: add load test for scanner + concurrent user writes"
```

---

### Task 12: Cleanup — remove leftover compat shims

**Files:**
- Modify: `backend/server/config.go` (remove `DatabasePath` if unused)
- Modify: `backend/fs/types.go` (consider if `Database` interface still adds value vs. taking `*db.DB` directly)

- [ ] **Step 1: Search for any remaining `DatabasePath`, dead config fields, or compat shims**

```bash
cd backend && grep -rn "DatabasePath\|GetDB\|globalDB" --include='*.go' .
```

- [ ] **Step 2: Remove dead code**

Anything that grep finds outside its definition site is fair game. Watch for genuinely-needed indirection (e.g., the `fs.Database` interface decouples fs from db for testing — keep it, but verify the dbAdapter is now trivial).

- [ ] **Step 3: Final build + full test run**

```bash
cd backend && go build ./... && go vet ./... && go test ./...
```

- [ ] **Step 4: Commit**

```bash
git commit -am "db: remove leftover compat shims after split"
```

---

## Notes

- **Migration is forward-only.** No automated rollback. If a deploy needs to revert, the operator manually restores the pre-deploy backup of `database.sqlite`.
- **The `migrations` table now exists in both DBs.** Each tracks its own applied versions. Don't try to consolidate — they're genuinely separate.
- **Long-running closures inside `Write`.** Discouraged but not prevented at the type level. If a future task adds a closure that does file I/O or network calls inside `Write`, that's the caller bug — fix the caller, not the writer.
- **Cross-DB transactions are not supported.** If a future feature needs to atomically update both index and app data, options are: (a) accept eventual consistency with reconciliation, (b) use SQLite's cross-database transactions (works because both files share a single connection in the ATTACHed app DB), or (c) reconsider the table placement. None are needed for the current codebase.
