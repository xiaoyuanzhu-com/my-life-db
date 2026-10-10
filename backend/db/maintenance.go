package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

const (
	maintenanceInitialDelay  = 10 * time.Minute
	maintenancePollInterval  = 5 * time.Minute
	maintenanceIdlePeriod    = 5 * time.Minute
	maintenanceMinFreeBytes  = 64 * 1024 * 1024
	maintenanceBatchPages    = 4096
	maintenanceTruncateBytes = 64 * 1024 * 1024
)

// MaintenanceActivity tracks actual requests and application writes, excluding
// maintenance itself. A long request is active even if it began hours ago.
type MaintenanceActivity struct {
	active atomic.Int64
	last   atomic.Int64
	mu     sync.Mutex
	cancel context.CancelFunc
}

func (a *MaintenanceActivity) Begin() func() {
	a.mu.Lock()
	a.active.Add(1)
	if a.cancel != nil {
		a.cancel()
	}
	a.mu.Unlock()
	return func() { a.last.Store(time.Now().UnixNano()); a.active.Add(-1) }
}

func (a *MaintenanceActivity) idleContext(parent context.Context) (context.Context, context.CancelFunc, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.Idle(time.Now()) {
		return nil, nil, false
	}
	ctx, cancel := context.WithCancel(parent)
	a.cancel = cancel
	return ctx, func() { a.mu.Lock(); a.cancel = nil; a.mu.Unlock(); cancel() }, true
}
func (a *MaintenanceActivity) Idle(now time.Time) bool {
	return a.active.Load() == 0 && now.Sub(time.Unix(0, a.last.Load())) >= maintenanceIdlePeriod
}

// RunIndexMaintenance starts after startup and never fails the application.
// Its private, single connection keeps maintenance pragmas out of read pools.
func (d *DB) RunIndexMaintenance(ctx context.Context, activity *MaintenanceActivity) {
	if d.role != DBRoleIndex {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(maintenanceInitialDelay):
	}
	driver := "sqlite3"
	if d.cfg.ExtensionPath != "" {
		driver = sqliteSimpleDriver
	}
	conn, err := sql.Open(driver, d.cfg.Path+"?_busy_timeout=100&_synchronous=NORMAL")
	if err != nil {
		log.Warn().Err(err).Msg("index maintenance connection failed")
		return
	}
	defer conn.Close()
	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	tick := func() {
		opCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		if err := d.maintainIndex(opCtx, conn, activity, time.Now()); err != nil && ctx.Err() == nil {
			log.Warn().Err(err).Msg("index maintenance deferred; will retry")
		}
	}
	tick()
	ticker := time.NewTicker(maintenancePollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tick()
		}
	}
}

func checkpointIndex(ctx context.Context, conn *sql.DB, mode string) (int, int, error) {
	var busy, frames, done int
	if err := conn.QueryRowContext(ctx, "PRAGMA wal_checkpoint("+mode+")").Scan(&busy, &frames, &done); err != nil {
		return 0, 0, err
	}
	if busy != 0 {
		return frames, done, fmt.Errorf("checkpoint busy")
	}
	return frames, done, nil
}

func (d *DB) maintainIndex(ctx context.Context, conn *sql.DB, activity *MaintenanceActivity, now time.Time) error {
	// PASSIVE never waits for readers and can run while normal traffic continues.
	frames, done, err := checkpointIndex(ctx, conn, "PASSIVE")
	if err != nil {
		return err
	}
	if !activity.Idle(now) {
		return nil
	}
	if info, err := os.Stat(d.cfg.Path + "-wal"); err == nil && info.Size() >= maintenanceTruncateBytes && done >= frames {
		if _, _, err := checkpointIndex(ctx, conn, "TRUNCATE"); err != nil {
			return err
		}
	}
	var last int64
	var pending int
	if err := conn.QueryRowContext(ctx, `SELECT last_checked_at,pending FROM index_maintenance WHERE name='space'`).Scan(&last, &pending); err != nil {
		return err
	}
	if pending == 0 && last != 0 && now.Before(time.UnixMilli(last).AddDate(0, 1, 0)) {
		return nil
	}
	if !activity.Idle(time.Now()) {
		return nil
	}
	idleCtx, cancel, idle := activity.idleContext(ctx)
	if !idle {
		return nil
	}
	defer cancel()
	ctx = idleCtx
	if _, err := conn.ExecContext(ctx, `UPDATE index_maintenance SET pending=1 WHERE name='space'`); err != nil {
		return err
	}
	var mode, pageSize, free int64
	for _, q := range []struct {
		sql string
		dst *int64
	}{
		{"PRAGMA auto_vacuum", &mode}, {"PRAGMA page_size", &pageSize}, {"PRAGMA freelist_count", &free},
	} {
		if err := conn.QueryRowContext(ctx, q.sql).Scan(q.dst); err != nil {
			return err
		}
	}
	if free*pageSize < maintenanceMinFreeBytes {
		_, err := conn.ExecContext(ctx, `UPDATE index_maintenance SET pending=0,last_checked_at=? WHERE name='space'`, now.UnixMilli())
		return err
	}
	// Legacy NONE-mode databases need a one-time rewrite to build SQLite's
	// pointer map. This happens only in an idle background window, never startup.
	if mode == 0 {
		if _, err := conn.ExecContext(ctx, "PRAGMA auto_vacuum=INCREMENTAL"); err != nil {
			return err
		}
		log.Info().Msg("converting legacy index for incremental space reclamation")
		// The application writer gate prevents new writes during the conversion.
		// Its private connection must not ATTACH app.sqlite or VACUUM would include it.
		if err := d.writer.Maintain(ctx, func() error {
			if !activity.Idle(time.Now()) {
				return fmt.Errorf("instance became active")
			}
			_, err := conn.ExecContext(ctx, "VACUUM")
			return err
		}); err != nil {
			return err
		}
	} else if mode == 1 {
		if _, err := conn.ExecContext(ctx, "PRAGMA auto_vacuum=INCREMENTAL"); err != nil {
			return err
		}
	}
	if !activity.Idle(time.Now()) {
		return nil
	}
	if err := d.writer.Maintain(ctx, func() error {
		if !activity.Idle(time.Now()) {
			return nil
		}
		// Query/step the pragma fully: SQLite incremental_vacuum yields rows.
		rows, err := conn.QueryContext(ctx, fmt.Sprintf("PRAGMA incremental_vacuum(%d)", maintenanceBatchPages))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
		}
		return rows.Err()
	}); err != nil {
		return err
	}
	if _, _, err := checkpointIndex(ctx, conn, "TRUNCATE"); err != nil {
		return err
	}
	if err := conn.QueryRowContext(ctx, "PRAGMA freelist_count").Scan(&free); err != nil {
		return err
	}
	if free*pageSize < maintenanceMinFreeBytes {
		_, err := conn.ExecContext(ctx, `UPDATE index_maintenance SET pending=0,last_checked_at=? WHERE name='space'`, now.UnixMilli())
		return err
	}
	// A remaining backlog stays pending and resumes one small batch per tick.
	return nil
}
