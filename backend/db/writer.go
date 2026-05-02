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
