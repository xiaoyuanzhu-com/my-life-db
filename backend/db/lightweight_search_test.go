package db

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func lightweightFixture(t *testing.T) *sql.DB {
	t.Helper()
	p := filepath.Join(t.TempDir(), "index.sqlite")
	c, err := sql.Open("sqlite3", p+"?_journal_mode=WAL")
	if err != nil {
		t.Fatal(err)
	}
	c.SetMaxOpenConns(1)
	t.Cleanup(func() { c.Close() })
	for _, q := range []string{
		`CREATE TABLE files(path TEXT PRIMARY KEY,name TEXT,is_folder INTEGER,size INTEGER,mime_type TEXT,hash TEXT,modified_at INTEGER,created_at INTEGER,last_scanned_at INTEGER,text_preview TEXT,preview_sqlar TEXT,preview_status TEXT)`,
		`CREATE VIRTUAL TABLE files_fts USING fts5(file_path, content)`,
		`CREATE TABLE sqlar(name TEXT PRIMARY KEY,mode INTEGER,mtime INTEGER,sz INTEGER,data BLOB)`,
		`CREATE VIRTUAL TABLE agent_sessions_fts USING fts5(session_id UNINDEXED,content)`,
		`CREATE TABLE agent_sessions_index_state(session_id TEXT PRIMARY KEY,last_indexed_at INTEGER)`,
		`CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at TEXT,description TEXT)`,
		`INSERT INTO schema_version(version) VALUES (38)`,
	} {
		mustExec(t, c, q)
	}
	return c
}

func TestLightweightMigrationPreservesPersistentData(t *testing.T) {
	c := lightweightFixture(t)
	mustExec(t, c, `INSERT INTO files VALUES('notes/a.md','a.md',0,10,'text/markdown',NULL,1,1,NULL,'body preview','0123456789abcdef/preview/thumbnail.jpg','ready')`)
	mustExec(t, c, `INSERT INTO files_fts VALUES('notes/a.md','secret body')`)
	mustExec(t, c, `INSERT INTO sqlar(name,data) VALUES('0123456789abcdef/preview/thumbnail.jpg',?),('original.bin',?)`, []byte("thumbnail"), []byte("keep me"))
	mustExec(t, c, `INSERT INTO sqlar(name,data) VALUES('user/preview/notes.txt',?)`, []byte("not generated"))
	mustExec(t, c, `INSERT INTO agent_sessions_fts VALUES('session','transcript')`)
	mustExec(t, c, `INSERT INTO agent_sessions_index_state VALUES('session',1)`)
	for i := 0; i < 2; i++ {
		if err := migration039Up(c); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := c.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE name='files_fts'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("file FTS remains: %d %v", n, err)
	}
	assertEqualSlice(t, "retained archive", queryColumn(t, c, `SELECT name FROM sqlar ORDER BY name`), []string{"original.bin", "user/preview/notes.txt"})
	assertEqualSlice(t, "session search", queryColumn(t, c, `SELECT content FROM agent_sessions_fts`), []string{"transcript"})
	assertEqualSlice(t, "session state", queryColumn(t, c, `SELECT session_id FROM agent_sessions_index_state`), []string{"session"})
	var preview, status *string
	var text string
	if err := c.QueryRow(`SELECT preview_sqlar,preview_status,text_preview FROM files`).Scan(&preview, &status, &text); err != nil {
		t.Fatal(err)
	}
	if preview != nil || status != nil || text != "body preview" {
		t.Fatalf("metadata corrupted: %v %v %s", preview, status, text)
	}
}

func TestSearchPathsFiltersPaginationAndLiteralWildcards(t *testing.T) {
	c := lightweightFixture(t)
	for _, p := range []string{"notes/report.md", "notes/report_100%.md", "notes/Report two.txt", "notes-archive/report.md", "notes/照片.md", "notes/unrelated.md", "projects/demo/target/report.o", "projects/demo/build/report.js", "projects/demo/dist/report.html", "projects/demo/out/report.json"} {
		mustExec(t, c, `INSERT INTO files(path,name,is_folder,mime_type,modified_at,created_at,text_preview) VALUES(?,?,0,'text/markdown',1,1,'report appears only in body')`, p, filepath.Base(p))
	}
	d := &DB{conn: c}
	cases := []struct {
		q     string
		opts  PathSearchOptions
		total int
		paths []string
	}{
		{"report", PathSearchOptions{PathFilter: "notes", Limit: 1, Offset: 1}, 3, []string{"notes/report.md"}},
		{"100%", PathSearchOptions{}, 1, []string{"notes/report_100%.md"}},
		{"report_", PathSearchOptions{}, 1, []string{"notes/report_100%.md"}},
		{"照片", PathSearchOptions{}, 1, []string{"notes/照片.md"}},
		{"report two", PathSearchOptions{}, 1, []string{"notes/Report two.txt"}},
		{"only in body", PathSearchOptions{}, 0, []string{}},
		{"report.o", PathSearchOptions{}, 0, []string{}},
		{"report", PathSearchOptions{TypeFilter: "image/"}, 0, []string{}},
	}
	for _, tt := range cases {
		files, total, err := d.SearchPaths(context.Background(), tt.q, tt.opts)
		if err != nil {
			t.Fatal(err)
		}
		paths := []string{}
		for _, f := range files {
			paths = append(paths, f.Path)
		}
		if total != tt.total {
			t.Errorf("%s: total=%d want=%d", tt.q, total, tt.total)
		}
		assertEqualSlice(t, tt.q, paths, tt.paths)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := d.SearchPaths(ctx, "report", PathSearchOptions{}); err == nil {
		t.Fatal("canceled search succeeded")
	}
}

func TestCompactIndexReclaimsSpaceAndPreservesSessions(t *testing.T) {
	c := lightweightFixture(t)
	var p string
	if err := c.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&p); err != nil {
		t.Fatal(err)
	}
	mustExec(t, c, `INSERT INTO sqlar(name,data) VALUES('0123456789abcdef/preview/thumbnail.jpg',zeroblob(4194304)),('original.bin',?)`, []byte("keep me"))
	mustExec(t, c, `INSERT INTO agent_sessions_fts VALUES('session','transcript')`)
	mustExec(t, c, `PRAGMA wal_checkpoint(TRUNCATE)`)
	before, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if err := CompactIndex(Config{Path: p}); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() >= before.Size()/2 {
		t.Fatalf("space not reclaimed: %d -> %d", before.Size(), after.Size())
	}
	r, err := sql.Open("sqlite3", p)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	assertEqualSlice(t, "session survives compaction", queryColumn(t, r, `SELECT content FROM agent_sessions_fts WHERE agent_sessions_fts MATCH 'transcript'`), []string{"transcript"})
	assertEqualSlice(t, "original survives compaction", queryColumn(t, r, `SELECT name FROM sqlar`), []string{"original.bin"})
	var check string
	if err := r.QueryRow(`PRAGMA integrity_check`).Scan(&check); err != nil || check != "ok" {
		t.Fatalf("integrity: %s %v", check, err)
	}
}

func TestCompactIndexRefusesActiveReader(t *testing.T) {
	c := lightweightFixture(t)
	var p string
	if err := c.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&p); err != nil {
		t.Fatal(err)
	}
	mustExec(t, c, `INSERT INTO files_fts VALUES('a','body')`)
	tx, err := c.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var content string
	if err := tx.QueryRow(`SELECT content FROM files_fts`).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if err := CompactIndex(Config{Path: p}); err == nil || !strings.Contains(err.Error(), "stop the instance") {
		t.Fatalf("did not reject active reader: %v", err)
	}
	if err := tx.QueryRow(`SELECT content FROM files_fts`).Scan(&content); err != nil || content != "body" {
		t.Fatalf("modified DB before obtaining exclusivity: %v", err)
	}
}

func TestCompactIndexRequiresExistingFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "missing.sqlite")
	if err := CompactIndex(Config{Path: p}); err == nil {
		t.Fatal("compacted nonexistent DB")
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("created an empty index")
	}
}
