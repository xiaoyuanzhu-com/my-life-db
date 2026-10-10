package db

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func maintenanceFixture(t *testing.T, incremental bool) (*DB, *sql.DB, string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "index.sqlite")
	c, err := sql.Open("sqlite3", p+"?_journal_mode=WAL&_busy_timeout=20")
	if err != nil {
		t.Fatal(err)
	}
	c.SetMaxOpenConns(1)
	if incremental {
		mustExec(t, c, `PRAGMA auto_vacuum=INCREMENTAL`)
		mustExec(t, c, `VACUUM`)
	}
	mustExec(t, c, `CREATE TABLE retained(id TEXT PRIMARY KEY,data BLOB)`)
	if err := migrations040ForTest(c); err != nil {
		t.Fatal(err)
	}
	d := &DB{conn: c, writeConn: c, cfg: Config{Path: p}, role: DBRoleIndex}
	if err := d.StartWriter(WriterConfig{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	m, err := sql.Open("sqlite3", p+"?_busy_timeout=20")
	if err != nil {
		t.Fatal(err)
	}
	m.SetMaxOpenConns(1)
	m.SetMaxIdleConns(1)
	t.Cleanup(func() { m.Close() })
	return d, m, p
}

func migrations040ForTest(c *sql.DB) error {
	for _, migration := range migrations {
		if migration.Version == 40 {
			return migration.Up(c)
		}
	}
	panic("missing maintenance migration")
}

func seedReclaimablePages(t *testing.T, c *sql.DB) {
	t.Helper()
	mustExec(t, c, `INSERT INTO retained VALUES('keep',?)`, []byte("persistent data"))
	mustExec(t, c, `INSERT INTO retained VALUES('discard',zeroblob(100663296))`)
	mustExec(t, c, `DELETE FROM retained WHERE id='discard'`)
	mustExec(t, c, `PRAGMA wal_checkpoint(TRUNCATE)`)
}

func TestMaintenanceDoesNotCompactAtStartup(t *testing.T) {
	c := lightweightFixture(t)
	var p string
	if err := c.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&p); err != nil {
		t.Fatal(err)
	}
	mustExec(t, c, `INSERT INTO sqlar(name,data) VALUES('0123456789abcdef/preview/thumbnail.jpg',zeroblob(8388608))`)
	mustExec(t, c, `PRAGMA wal_checkpoint(TRUNCATE)`)
	c.Close()
	before, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	d, err := Open(Config{Path: p, Role: DBRoleIndex, MaxOpenConns: 1, MaxIdleConns: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	after, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() < before.Size() {
		t.Fatalf("startup unexpectedly compacted: %d -> %d", before.Size(), after.Size())
	}
	var pending int
	if err := d.conn.QueryRow(`SELECT pending FROM index_maintenance WHERE name='space'`).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("background cleanup not pending: %d %v", pending, err)
	}
}

func TestMaintenanceConvertsLegacyAndReclaimsInBackground(t *testing.T) {
	d, m, p := maintenanceFixture(t, false)
	seedReclaimablePages(t, d.conn)
	before, _ := os.Stat(p)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := d.maintainIndex(ctx, m, &MaintenanceActivity{}, time.Now()); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(p)
	if after.Size() >= before.Size()/2 {
		t.Fatalf("not reclaimed: %d -> %d", before.Size(), after.Size())
	}
	var mode int
	if err := m.QueryRow(`PRAGMA auto_vacuum`).Scan(&mode); err != nil || mode != 2 {
		t.Fatalf("not incremental: %d %v", mode, err)
	}
	assertEqualSlice(t, "persistent content", queryColumn(t, m, `SELECT id FROM retained`), []string{"keep"})
	var check string
	if err := m.QueryRow(`PRAGMA integrity_check`).Scan(&check); err != nil || check != "ok" {
		t.Fatalf("integrity: %s %v", check, err)
	}
}

func TestMaintenanceBatchesAndPersistsMonthlySchedule(t *testing.T) {
	d, m, p := maintenanceFixture(t, true)
	seedReclaimablePages(t, d.conn)
	before, _ := os.Stat(p)
	now := time.Now()
	if err := d.maintainIndex(context.Background(), m, &MaintenanceActivity{}, now); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(p)
	if after.Size() >= before.Size() || before.Size()-after.Size() > maintenanceBatchPages*4096+4096*32 {
		t.Fatalf("not bounded batch: %d -> %d", before.Size(), after.Size())
	}
	var pending int
	var last int64
	if err := m.QueryRow(`SELECT pending,last_checked_at FROM index_maintenance`).Scan(&pending, &last); err != nil || pending != 1 || last != 0 {
		t.Fatalf("backlog state: %d %d %v", pending, last, err)
	}
	for i := 0; i < 8; i++ {
		if err := d.maintainIndex(context.Background(), m, &MaintenanceActivity{}, now); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.QueryRow(`SELECT pending,last_checked_at FROM index_maintenance`).Scan(&pending, &last); err != nil || pending != 0 || last != now.UnixMilli() {
		t.Fatalf("completion: %d %d %v", pending, last, err)
	}
	// Reload persisted state with a new connection/activity tracker.
	mustExec(t, d.conn, `INSERT INTO retained VALUES('discard',zeroblob(100663296))`)
	mustExec(t, d.conn, `DELETE FROM retained WHERE id='discard'`)
	var freeBefore, freeAfter int
	m.QueryRow(`PRAGMA freelist_count`).Scan(&freeBefore)
	if err := d.maintainIndex(context.Background(), m, &MaintenanceActivity{}, now.AddDate(0, 0, 20)); err != nil {
		t.Fatal(err)
	}
	m.QueryRow(`PRAGMA freelist_count`).Scan(&freeAfter)
	if freeBefore != freeAfter {
		t.Fatal("compacted before monthly due date")
	}
	if err := d.maintainIndex(context.Background(), m, &MaintenanceActivity{}, now.AddDate(0, 1, 0)); err != nil {
		t.Fatal(err)
	}
	m.QueryRow(`PRAGMA freelist_count`).Scan(&freeAfter)
	if freeAfter >= freeBefore {
		t.Fatal("did not run when monthly due")
	}
}

func TestMaintenanceDefersBusyAndCancelsWhenUserReturns(t *testing.T) {
	d, m, _ := maintenanceFixture(t, true)
	seedReclaimablePages(t, d.conn)
	a := &MaintenanceActivity{}
	done := a.Begin()
	if err := d.maintainIndex(context.Background(), m, a, time.Now()); err != nil {
		t.Fatal(err)
	}
	var last int64
	m.QueryRow(`SELECT last_checked_at FROM index_maintenance`).Scan(&last)
	if last != 0 {
		t.Fatal("ran while user active")
	}
	done()
	a.last.Store(time.Now().Add(-maintenanceIdlePeriod - time.Second).UnixNano())
	ctx, cancel, idle := a.idleContext(context.Background())
	if !idle {
		t.Fatal("not idle")
	}
	defer cancel()
	done = a.Begin()
	defer done()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("did not cancel when user returned")
	}
}

func TestMaintenanceBlockedReaderKeepsPendingAndRetries(t *testing.T) {
	d, m, _ := maintenanceFixture(t, true)
	seedReclaimablePages(t, d.conn)
	tx, err := d.conn.Begin()
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRow(`SELECT count(*) FROM retained`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if err := d.maintainIndex(context.Background(), m, &MaintenanceActivity{}, time.Now()); err == nil {
		tx.Rollback()
		t.Fatal("expected checkpoint blockage")
	}
	var pending int
	var last int64
	if err := m.QueryRow(`SELECT pending,last_checked_at FROM index_maintenance`).Scan(&pending, &last); err != nil || pending != 1 || last != 0 {
		tx.Rollback()
		t.Fatalf("lost pending maintenance: %d %d %v", pending, last, err)
	}
	tx.Rollback()
	if err := d.maintainIndex(context.Background(), m, &MaintenanceActivity{}, time.Now()); err != nil {
		t.Fatalf("retry failed: %v", err)
	}
}

func TestMaintenanceRunStopsWithContext(t *testing.T) {
	d, _, _ := maintenanceFixture(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { d.RunIndexMaintenance(ctx, &MaintenanceActivity{}); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("maintenance did not stop")
	}
}

func TestMaintenanceConfiguresFreshIndexWithoutVacuum(t *testing.T) {
	p := filepath.Join(t.TempDir(), "fresh.sqlite")
	d, err := Open(Config{Path: p, Role: DBRoleIndex, MaxOpenConns: 1, MaxIdleConns: 1})
	// Bare test driver does not register production's simple tokenizer. The
	// setup runs before schema creation, so inspect its setting even on failure.
	if err == nil {
		d.Close()
	}
	c, err := sql.Open("sqlite3", p)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var mode int
	if err := c.QueryRow(`PRAGMA auto_vacuum`).Scan(&mode); err != nil || mode != 2 {
		t.Fatalf("fresh mode: %d %v", mode, err)
	}
}

func TestApplicationWriteCancelsMaintenanceBeforeWaiting(t *testing.T) {
	d, _, _ := maintenanceFixture(t, true)
	activity := &MaintenanceActivity{}
	d.SetMaintenanceActivity(activity)
	ctx, cancel, idle := activity.idleContext(context.Background())
	if !idle {
		t.Fatal("not idle")
	}
	defer cancel()
	entered := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		finished <- d.writer.Maintain(ctx, func() error { close(entered); <-ctx.Done(); return ctx.Err() })
	}()
	<-entered
	if err := d.Write(context.Background(), func(tx *sql.Tx) error { _, err := tx.Exec(`INSERT INTO retained VALUES('write','data')`); return err }); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err != context.Canceled {
			t.Fatalf("maintenance error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("write did not interrupt maintenance")
	}
}
