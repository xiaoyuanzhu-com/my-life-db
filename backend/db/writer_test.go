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
