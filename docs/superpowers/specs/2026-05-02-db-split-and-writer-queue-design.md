# DB Layer Refactor: Two-DB Split + Single-Writer Queue

**Date:** 2026-05-02
**Status:** Design

## Problem

Two pain points in the current DB layer, both rooted in SQLite's single-writer model:

1. **Write contention.** The scanner can hit `database is locked` when a long-running orphan reconciliation overlaps with concurrent file processing. Symptom-fixed in the prior change (mutex-guarded scan + batched deletes), but the underlying class of bug — multiple goroutines fighting for SQLite's writer slot through a connection pool with a `_busy_timeout` — remains.
2. **Coupled rebuildable and persistent state.** `files`, `files_fts`, `digests`, `sqlar` are *rebuildable* indexes derived from the filesystem; `pins`, `people`, `settings`, `sessions`, `agent_sessions`, etc. are *persistent* user data. They share a single SQLite file, so a hot scanner workload contends with user-facing writes.

This refactor addresses both at once.

## Goals

- Eliminate `database is locked` as a possible failure mode.
- Isolate hot scanner/digest writes from user-facing writes.
- Make the rebuildable/persistent boundary explicit: dropping the index DB and rescanning must never lose user data.
- Replace the deprecated `globalDB` singleton with explicit dependency injection.
- Migrate existing single-DB users transparently on the next deploy.

## Non-goals

- Switching off SQLite. Stays SQLite.
- Schema redesign of individual tables. Tables move; their columns don't.
- Performance optimization beyond what the architecture inherently provides.

## Architecture

### Two databases

| File | Purpose | Contains |
|------|---------|----------|
| `APP_DATA_DIR/index.sqlite` | Rebuildable file/search index | `files`, `files_fts`, `sqlar`, `digests` |
| `APP_DATA_DIR/app.sqlite` | Persistent user data | `pins`, `people`, `settings`, `sessions`, `agent_sessions`, `agent_session_groups`, `claude_sessions`, `share_sessions`, `explore_*`, `connect_*`, `migrations` (per-DB) |

`app.sqlite` is the renamed-in-place existing `database.sqlite` after migration. `index.sqlite` is created fresh and populated by copying tables out.

The boundary follows the existing `APP_DATA_DIR` "rebuildable" philosophy in CLAUDE.md. Conceptually, deleting `index.sqlite` and restarting the server should fully rebuild it from the filesystem; deleting `app.sqlite` would lose user data.

### Cross-DB queries

The only cross-boundary JOIN is `pins JOIN files` ([db/pins.go:67](../../../backend/db/pins.go#L67)).

Solution: when opening `app.sqlite`, run `ATTACH DATABASE 'index.sqlite' AS idx` on every connection (via a `ConnectHook` similar to the existing simple-extension hook). Queries can then reference `idx.files` from the app DB:

```sql
SELECT p.file_path, p.pinned_at, f.size, f.mime_type
FROM pins p
JOIN idx.files f ON f.path = p.file_path
```

The attach is **read-only** to make accidental cross-DB writes impossible:

```sql
ATTACH DATABASE 'file:.../index.sqlite?mode=ro' AS idx
```

Writes to `idx.*` from the app DB connection would error. Writes to the index DB go through the index DB's own writer queue.

### Single-writer queue per DB

Each `*db.DB` owns a `Writer`:

```go
type Writer struct {
    db    *sql.DB
    queue chan writeJob
    quit  chan struct{}
}

type writeJob struct {
    ctx  context.Context
    fn   func(*sql.Tx) error
    done chan error
}

// Do runs fn inside a transaction on the writer goroutine.
// Blocks until commit/rollback. Safe to call from any goroutine.
func (w *Writer) Do(ctx context.Context, fn func(*sql.Tx) error) error {
    done := make(chan error, 1)
    select {
    case w.queue <- writeJob{ctx: ctx, fn: fn, done: done}:
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

func (w *Writer) run() {
    for {
        select {
        case job := <-w.queue:
            job.done <- w.runJob(job)
        case <-w.quit:
            return
        }
    }
}

func (w *Writer) runJob(job writeJob) error {
    if err := job.ctx.Err(); err != nil {
        return err
    }
    tx, err := w.db.BeginTx(job.ctx, nil)
    if err != nil {
        return err
    }
    if err := job.fn(tx); err != nil {
        tx.Rollback()
        return err
    }
    return tx.Commit()
}
```

**API to callers** is `db.Write(ctx, func(tx *sql.Tx) error { ... })` — looks synchronous, runs on the queue. The fact that one goroutine owns all writes is invisible to callers other than ordering guarantees.

**Properties:**
- SQLite never sees concurrent writers from this process → no `BUSY` from contention.
- Multi-statement transactions (the existing `DeleteFileWithCascade` pattern) become natural single `Do` calls.
- Writes are serialized in submission order per-DB. Cross-DB ordering is not guaranteed — but no current code depends on it.
- Backpressure: the channel is bounded (size = 256, configurable). If the writer falls behind, callers block. This is the correct behavior; an unbounded queue would mask scanner runaway.

**Reads** continue using `db.Conn().Query(...)` / `db.Conn().QueryRow(...)` against the pool. WAL mode allows concurrent readers + the one writer.

### `db.DB` API surface

Today: package-level functions everywhere (`db.UpsertFile`, `db.GetFileByPath`, ...) backed by `globalDB`.

After: methods on `*db.DB`. The two instances are constructed by `server.New()` and passed into the components that need them:

```go
type DB struct {
    conn   *sql.DB
    writer *Writer
    cfg    Config
    role   DBRole // index | app
}

// Read methods (no queue)
func (d *DB) GetFileByPath(path string) (*FileRecord, error)
func (d *DB) ListAllFilePaths() ([]string, error)
// ... etc

// Write methods (use writer.Do internally)
func (d *DB) UpsertFile(f *FileRecord) (bool, error)
func (d *DB) DeleteFileWithCascade(path string) error
func (d *DB) BatchDeleteFilesWithCascade(paths []string) error
// ... etc

// Escape hatch: arbitrary write transaction
func (d *DB) Write(ctx context.Context, fn func(*sql.Tx) error) error
```

The `globalDB` var, the `mu` mutex around it, `GetDB()`, package-level `Transaction()`, and the `dbAdapter` in `fs/` all go away. Components take `*db.DB` directly.

### Component wiring

```go
// server/server.go
type Server struct {
    indexDB *db.DB  // index.sqlite
    appDB   *db.DB  // app.sqlite (with ATTACH idx)

    fsService     *fs.Service          // gets indexDB
    digestWorker  *digest.Worker       // gets indexDB
    notifService  *notifications.Service
    claudeManager *claude.SessionManager // gets appDB
    agent         *agent.Agent          // gets appDB
    // ...
}
```

API handlers in `api/handlers.go` already access components via `h.server.X()`. Add `h.server.IndexDB()` and `h.server.AppDB()` accessors.

### Migration of existing users

On startup, `server.New()` runs a one-time migration before opening the new DB instances:

1. Check `APP_DATA_DIR/index.sqlite` exists. If yes, migration is already done — skip.
2. Check `APP_DATA_DIR/database.sqlite` exists. If no, this is a fresh install — create `index.sqlite` and `app.sqlite` empty, run migrations on each.
3. Else: this is an existing user. Run the split:
   1. Delete any leftover `index.sqlite.tmp` from a previously-crashed migration.
   2. Open the legacy `database.sqlite` directly.
   3. Create `index.sqlite.tmp` and run index-targeted schema migrations on it (creates the four tables).
   4. `ATTACH DATABASE 'index.sqlite.tmp' AS idx` on the legacy connection.
   5. `INSERT INTO idx.files SELECT * FROM files;` (and same for `files_fts`, `sqlar`, `digests`).
   6. Verify row counts match. If not, abort loudly — leave `database.sqlite` untouched.
   7. `DETACH DATABASE idx`. Atomic rename `index.sqlite.tmp` → `index.sqlite`. **First commit point.**
   8. Re-attach `index.sqlite` (now permanent). `DROP TABLE IF EXISTS files`, `files_fts`, `sqlar`, `digests` from the legacy DB.
   9. `VACUUM` the legacy DB to reclaim space.
   10. Atomic rename `database.sqlite` → `app.sqlite`. **Second commit point.**
   11. Done. Subsequent startups see `index.sqlite` already exists and skip the whole sequence.

**Idempotence and crash recovery.** Each step is checkpointed via filesystem state, so any crash leaves the system in a recoverable state. The migration uses a temporary file name during construction:

| Phase | State on disk | Recovery on next startup |
|-------|--------------|--------------------------|
| Pre-migration | `database.sqlite` exists, no `index.sqlite`, no `index.sqlite.tmp` | Run migration from step 1 |
| During copy (steps 2-5) | `database.sqlite` exists, `index.sqlite.tmp` exists, no `index.sqlite` | Delete `index.sqlite.tmp`, restart from step 1 |
| Copy verified (step 6 ready) | `database.sqlite` exists, `index.sqlite.tmp` exists with verified row counts | Atomic rename `index.sqlite.tmp` → `index.sqlite`, then continue from step 6 |
| Post-rename, pre-drop (step 7) | `database.sqlite` exists with old tables, `index.sqlite` exists | Re-attach and re-run DROPs (idempotent — `DROP TABLE IF EXISTS`), VACUUM, rename |
| Post-rename of legacy (step 8 done) | `app.sqlite` exists, `index.sqlite` exists, no `database.sqlite` | Migration complete, normal startup |

The two atomic rename operations (`index.sqlite.tmp` → `index.sqlite`, `database.sqlite` → `app.sqlite`) are the only commit points. Everything between two commits is recoverable by re-doing.

Row-count verification (step 5) happens before any rename — if counts don't match, abort with a loud error and leave `database.sqlite` untouched. The user (or operator, in the multi-tenant cloud case) gets a clear failure rather than silent partial migration.

**Rollback:** if the user wants to revert, they can manually re-attach the legacy and copy back. We don't ship automated rollback — the migration is forward-only after step 8.

### Migration system changes

The existing `db/migrations.go` registry runs all migrations against one DB. After this refactor:

- Each `Migration` declares its target: `Target: DBRoleIndex` or `Target: DBRoleApp`.
- `runMigrations(indexDB)` runs only index-targeted migrations.
- `runMigrations(appDB)` runs only app-targeted migrations.
- Each DB has its own `migrations` table tracking applied versions.
- Existing migrations 001-027 get tagged with their target retroactively (most are app-side; 027 is index-side; 011 is index-side because of `sqlar`; etc.).

## Implementation order

Even as one logical refactor, the implementation stages incrementally so each step can be tested:

1. **Add `Writer` type + tests.** Standalone, no dependencies on existing code. Verify ordering, context cancellation, backpressure.
2. **Refactor `*db.DB` to own a `Writer`.** Add `Write(ctx, fn)` method. Don't change any existing call sites yet.
3. **Convert package-level functions to methods.** Mechanical. `GetFileByPath()` → `(*DB).GetFileByPath()`. Update callers to use the injected `*db.DB`. Delete `globalDB`, `GetDB()`, `Transaction()`.
4. **Switch all writes to use `Write`.** `UpsertFile`, `DeleteFileWithCascade`, `BatchDeleteFilesWithCascade`, `MoveFileAtomic`, `RenameFilePath`, `UpdateFileField`, etc. all become thin wrappers over `Write(ctx, fn)`.
5. **Tag every migration with a target DB.** No behavior change yet — both run against the same DB still.
6. **Add second DB instance + ATTACH.** `server.New()` opens both `index.sqlite` and `app.sqlite`, runs targeted migrations against each. ATTACH index DB read-only to app DB connections via a ConnectHook.
7. **Move tables.** Update the four index tables' migrations to target index DB. On fresh install, they go to the right place.
8. **Add startup migration code** for existing users (the `database.sqlite` → split sequence).
9. **End-to-end test:** fresh install (both DBs created empty, scanner populates index) + migration test (start with a populated `database.sqlite`, verify split happens cleanly and all queries still work).

Steps 1-5 are zero-behavior-change refactor. Steps 6-8 are the actual split. Step 9 is verification.

## Testing

- Unit tests for `Writer`: ordering, context cancellation, backpressure, panic recovery, shutdown drain.
- Existing `fs/` test suite must pass unchanged after the API conversion (steps 3-4).
- New integration test: spin up a server with a pre-populated legacy `database.sqlite` fixture, verify migration completes and all data is queryable from the right DB.
- New integration test: simulate a crash mid-migration (between INSERT and DROP) by interrupting; verify recovery on next startup.
- Load test: scanner indexing a 100K-file tree with concurrent user-facing API writes (pin/unpin, settings update). Confirm no `database is locked` errors and user-facing latency is unaffected by scanner throughput.

## Risks

- **Migration data loss.** Mitigated by row-count verification before any DROP and by leaving the legacy DB intact until the final atomic rename succeeds.
- **Performance regression on writes.** Single goroutine processes writes serially. SQLite already serializes writers, so the ceiling is the same — but Go-level scheduling adds overhead. Expected to be negligible (<1ms per write); load test will confirm.
- **Long-running write closures block all other writes.** Callers must keep their `Do(ctx, fn)` closures short. Documented in the Writer godoc. Hash computation, file I/O, network calls etc. must happen *before* the closure, not inside it.
- **ATTACH read-only on every app DB connection.** Adds startup overhead per connection (~ms). Acceptable; the pool keeps connections warm.
- **Migration code is one-shot but lives in the codebase forever.** Acceptable cost; remove in a future major version.

## Open questions

None. All decisions resolved during brainstorming.
