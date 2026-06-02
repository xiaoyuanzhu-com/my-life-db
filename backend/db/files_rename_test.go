package db

import (
	"context"
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// newRenameTestDB builds a minimal *DB for exercising RenameFilePaths without
// the FTS5 'simple' extension or the production cross-DB wiring.
//
// RenameFilePaths only issues three UPDATEs touching files.path/name,
// files_fts.file_path and app.pins.file_path, so plain stand-in tables (and an
// ATTACHed in-memory 'app' schema) reproduce the real statements faithfully.
// A single pooled connection keeps the ATTACH alive and lets the writer
// goroutine see the same in-memory database the test inserts into.
func newRenameTestDB(t *testing.T) *DB {
	t.Helper()

	conn, err := sql.Open("sqlite3", ":memory:?_busy_timeout=5000")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	conn.SetConnMaxLifetime(0)

	stmts := []string{
		`ATTACH DATABASE ':memory:' AS app`,
		`CREATE TABLE files (path TEXT PRIMARY KEY, name TEXT NOT NULL)`,
		`CREATE TABLE files_fts (file_path TEXT, content TEXT)`,
		`CREATE TABLE app.pins (file_path TEXT PRIMARY KEY)`,
	}
	for _, s := range stmts {
		if _, err := conn.Exec(s); err != nil {
			t.Fatalf("setup %q: %v", s, err)
		}
	}

	d := &DB{conn: conn, writeConn: conn, role: DBRoleIndex}
	if err := d.StartWriter(WriterConfig{}); err != nil {
		t.Fatalf("StartWriter: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

func mustExec(t *testing.T, conn *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

func queryColumn(t *testing.T, conn *sql.DB, query string) []string {
	t.Helper()
	rows, err := conn.Query(query)
	if err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, s)
	}
	return out
}

func assertEqualSlice(t *testing.T, label string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %v, want %v", label, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: got %v, want %v", label, got, want)
		}
	}
}

// TestRenameFilePaths_CJKFolder is the regression guard for the byte-vs-character
// substr bug. SQLite substr() on TEXT counts CHARACTERS while Go len() counts
// BYTES; for a multi-byte (CJK) folder name those diverge, so a byte-derived
// offset rewrote every child path into garbage. The fix uses SQL length()+1,
// which this test pins down across files, files_fts and app.pins — including a
// sibling whose name shares the renamed folder as a string prefix but is not a
// child (照片备份 vs 照片), which must stay untouched.
func TestRenameFilePaths_CJKFolder(t *testing.T) {
	d := newRenameTestDB(t)
	conn := d.Read()
	ctx := context.Background()

	// files: the folder, two (nested) children, and a non-child sibling.
	mustExec(t, conn, `INSERT INTO files (path, name) VALUES (?, ?)`, "照片", "照片")
	mustExec(t, conn, `INSERT INTO files (path, name) VALUES (?, ?)`, "照片/a.jpg", "a.jpg")
	mustExec(t, conn, `INSERT INTO files (path, name) VALUES (?, ?)`, "照片/子目录/b.png", "b.png")
	mustExec(t, conn, `INSERT INTO files (path, name) VALUES (?, ?)`, "照片备份/c.jpg", "c.jpg")

	mustExec(t, conn, `INSERT INTO files_fts (file_path, content) VALUES (?, ?)`, "照片/a.jpg", "x")
	mustExec(t, conn, `INSERT INTO files_fts (file_path, content) VALUES (?, ?)`, "照片备份/c.jpg", "x")

	mustExec(t, conn, `INSERT INTO app.pins (file_path) VALUES (?)`, "照片/a.jpg")
	mustExec(t, conn, `INSERT INTO app.pins (file_path) VALUES (?)`, "照片备份/c.jpg")

	if err := d.RenameFilePaths(ctx, "照片", "我的照片"); err != nil {
		t.Fatalf("RenameFilePaths: %v", err)
	}

	assertEqualSlice(t, "files.path", queryColumn(t, conn, `SELECT path FROM files ORDER BY path`),
		[]string{"我的照片", "我的照片/a.jpg", "我的照片/子目录/b.png", "照片备份/c.jpg"})

	// The renamed folder's own name follows the new basename; children keep theirs.
	got := queryColumn(t, conn, `SELECT name FROM files WHERE path = '我的照片'`)
	assertEqualSlice(t, "folder name", got, []string{"我的照片"})

	assertEqualSlice(t, "files_fts.file_path", queryColumn(t, conn, `SELECT file_path FROM files_fts ORDER BY file_path`),
		[]string{"我的照片/a.jpg", "照片备份/c.jpg"})

	assertEqualSlice(t, "app.pins.file_path", queryColumn(t, conn, `SELECT file_path FROM app.pins ORDER BY file_path`),
		[]string{"我的照片/a.jpg", "照片备份/c.jpg"})
}

// TestRenameFilePaths_ASCIIFolder guards the common case so a future "fix" of
// the substr offset can't silently break plain ASCII renames.
func TestRenameFilePaths_ASCIIFolder(t *testing.T) {
	d := newRenameTestDB(t)
	conn := d.Read()
	ctx := context.Background()

	mustExec(t, conn, `INSERT INTO files (path, name) VALUES (?, ?)`, "notes", "notes")
	mustExec(t, conn, `INSERT INTO files (path, name) VALUES (?, ?)`, "notes/todo.md", "todo.md")
	mustExec(t, conn, `INSERT INTO files (path, name) VALUES (?, ?)`, "notes-archive/old.md", "old.md")

	if err := d.RenameFilePaths(ctx, "notes", "journal"); err != nil {
		t.Fatalf("RenameFilePaths: %v", err)
	}

	assertEqualSlice(t, "files.path", queryColumn(t, conn, `SELECT path FROM files ORDER BY path`),
		[]string{"journal", "journal/todo.md", "notes-archive/old.md"})
}
