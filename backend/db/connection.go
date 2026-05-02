package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/mattn/go-sqlite3"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Driver name registered with database/sql for connections that load the
// wangfenjin/simple SQLite FTS5 extension. We register a separate driver
// (rather than the default "sqlite3") so we can attach a ConnectHook that
// runs LoadExtension + jieba_dict() per connection.
const sqliteSimpleDriver = "sqlite3_simple"

// writerQueueSize bounds backpressure when callers submit faster than the
// writer can process. Picked large enough to absorb burst traffic from the
// scanner's parallel processFile workers without being so large that a
// runaway producer can mask itself.
const writerQueueSize = 256

var (
	// driverRegistered is the path the simple-driver was registered with.
	// Re-registration is a no-op if the same paths are requested again; if
	// they change between calls (e.g. tests), we panic — sql.Register can't
	// be undone without process restart.
	driverRegistered     bool
	driverExtensionPath  string
	driverDictDir        string
	driverRegisterMu     sync.Mutex
)

var (
	// globalDB is set by the server when it initializes
	// All existing db query functions use this
	globalDB *DB
	mu       sync.RWMutex
)

// DB wraps a sql.DB connection plus a single-writer goroutine.
// Reads use d.conn directly; writes go through d.writer.Do.
type DB struct {
	conn   *sql.DB
	cfg    Config
	role   DBRole
	writer *Writer
}

// Open opens a database connection with the given configuration
func Open(cfg Config) (*DB, error) {
	// Ensure database directory exists
	if err := ensureDatabaseDirectory(cfg.Path); err != nil {
		return nil, fmt.Errorf("failed to create database directory: %w", err)
	}

	// Pick the driver name. If an extension is configured, register a
	// per-connection ConnectHook that loads it and primes the jieba dict.
	driverName := "sqlite3"
	if cfg.ExtensionPath != "" {
		if err := registerSimpleDriver(cfg.ExtensionPath, cfg.ExtensionDictDir); err != nil {
			return nil, fmt.Errorf("failed to register sqlite simple driver: %w", err)
		}
		driverName = sqliteSimpleDriver
	}

	// Open database connection with SQLite pragmas
	// Using WAL mode, foreign keys, and optimized settings
	dsn := cfg.Path + "?_foreign_keys=1&_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL&_cache_size=-64000"

	conn, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Configure connection pool for better concurrency
	// WAL mode allows multiple readers + one writer concurrently
	conn.SetMaxOpenConns(cfg.MaxOpenConns)
	conn.SetMaxIdleConns(cfg.MaxIdleConns)
	conn.SetConnMaxLifetime(cfg.ConnMaxLifetime)

	// Verify connection
	if err := conn.Ping(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Run migrations
	if err := runMigrations(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	log.Info().
		Str("path", cfg.Path).
		Str("driver", driverName).
		Msg("database opened")

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
}

// registerSimpleDriver registers the sqlite3_simple driver exactly once.
// Subsequent calls with matching paths are no-ops; mismatched calls return
// an error because sql.Register cannot be reset without process restart.
func registerSimpleDriver(extensionPath, dictDir string) error {
	driverRegisterMu.Lock()
	defer driverRegisterMu.Unlock()

	if driverRegistered {
		if extensionPath != driverExtensionPath || dictDir != driverDictDir {
			return fmt.Errorf(
				"sqlite simple driver already registered with extension=%q dict=%q; cannot re-register with extension=%q dict=%q",
				driverExtensionPath, driverDictDir, extensionPath, dictDir,
			)
		}
		return nil
	}

	// Verify the artifacts exist before registering — surfacing a clear error
	// here is much friendlier than an opaque "load_extension failed" later.
	if _, err := os.Stat(extensionPath); err != nil {
		return fmt.Errorf("sqlite extension not found at %s: %w", extensionPath, err)
	}
	if dictDir != "" {
		if info, err := os.Stat(dictDir); err != nil {
			return fmt.Errorf("jieba dict dir not found at %s: %w", dictDir, err)
		} else if !info.IsDir() {
			return fmt.Errorf("jieba dict path %s is not a directory", dictDir)
		}
	}

	sql.Register(sqliteSimpleDriver, &sqlite3.SQLiteDriver{
		ConnectHook: func(conn *sqlite3.SQLiteConn) error {
			// Pass the explicit entry-point symbol — go-sqlite3 forwards "" as
			// an empty C string (not NULL), which makes dlsym look up "" and fail.
			if err := conn.LoadExtension(extensionPath, "sqlite3_simple_init"); err != nil {
				return fmt.Errorf("load_extension(%s): %w", extensionPath, err)
			}
			if dictDir != "" {
				// jieba_dict initializes the segmenter for this connection.
				// It returns a status string; we discard the result.
				if _, err := conn.Exec("SELECT jieba_dict(?)", []driver.Value{dictDir}); err != nil {
					return fmt.Errorf("jieba_dict(%s): %w", dictDir, err)
				}
			}
			return nil
		},
	})

	driverRegistered = true
	driverExtensionPath = extensionPath
	driverDictDir = dictDir
	return nil
}

// Close closes the database connection
func (d *DB) Close() error {
	mu.Lock()
	defer mu.Unlock()

	if d.conn != nil {
		if d.writer != nil {
			d.writer.stop()
		}
		// Clear global if this is the global instance
		if globalDB == d {
			globalDB = nil
		}
		return d.conn.Close()
	}
	return nil
}

// Conn returns the underlying sql.DB connection
func (d *DB) Conn() *sql.DB {
	return d.conn
}

// GetDB returns the global database connection for existing query functions
// This is a compatibility layer during the refactoring
func GetDB() *sql.DB {
	mu.RLock()
	defer mu.RUnlock()

	if globalDB == nil {
		return nil
	}
	return globalDB.conn
}

// Transaction executes a function within a database transaction (global version)
func Transaction(fn func(*sql.Tx) error) error {
	mu.RLock()
	db := globalDB
	mu.RUnlock()

	if db == nil {
		return fmt.Errorf("database not initialized")
	}

	return db.Transaction(fn)
}

// Close closes the global database connection
// DEPRECATED: This is temporary for backward compatibility
func Close() error {
	mu.Lock()
	defer mu.Unlock()

	if globalDB != nil {
		return globalDB.Close()
	}
	return nil
}

// ensureDatabaseDirectory creates the directory for the database file if it doesn't exist
func ensureDatabaseDirectory(dbPath string) error {
	dir := filepath.Dir(dbPath)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
		log.Info().Str("dir", dir).Msg("created database directory")
	}
	return nil
}

// Transaction executes a function within a database transaction
func (d *DB) Transaction(fn func(*sql.Tx) error) error {
	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}

	defer func() {
		if p := recover(); p != nil {
			tx.Rollback()
			panic(p)
		}
	}()

	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}

	return tx.Commit()
}

// Write runs fn inside a write transaction on the per-DB writer goroutine.
// All writes for this DB must go through this method (or one of the typed
// helper methods that wrap it). Direct writes via d.Read() are never safe.
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
