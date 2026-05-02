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

// sqliteAppDriver is the driver name for app DB connections that ATTACH the
// index DB read-only as 'idx'. This lets queries on app.sqlite reference
// idx.<table> for cross-DB joins (e.g., pins JOIN idx.files).
const sqliteAppDriver = "sqlite3_app"

// sqliteIdxWriterDriver is the driver name for the index DB's WRITER-side
// connection. Connections from this driver ATTACH the app DB read-write as
// 'app' so file-mutation transactions (DeleteFileWithCascade et al.) can
// atomically update app.pins in the same transaction. The index DB's read
// pool stays on the plain (or simple) driver — only the dedicated writer
// connection has cross-DB write privileges.
const sqliteIdxWriterDriver = "sqlite3_idx_writer"

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

	// App-DB driver (sqlite3_app): same as the simple driver, plus ATTACHes
	// the index DB read-only as 'idx' on every new connection.
	appDriverRegistered bool
	appDriverIndexPath  string
	appDriverExtPath    string
	appDriverDictDir    string
	appDriverMu         sync.Mutex

	// Idx-writer driver (sqlite3_idx_writer): index DB connections that
	// ATTACH the app DB read-write as 'app'. Used only by the index DB's
	// dedicated writer connection so that file-mutation transactions can
	// atomically update app.pins (and any other app-side state that must
	// change in lockstep with files).
	idxWriterDriverRegistered bool
	idxWriterDriverAppPath    string
	idxWriterDriverExtPath    string
	idxWriterDriverDictDir    string
	idxWriterDriverMu         sync.Mutex
)

// DB wraps a sql.DB connection plus a single-writer goroutine.
// Reads use d.conn directly; writes go through d.writer.Do.
//
// d.conn is the read pool (back-compat name; equivalent to readConn).
// d.writeConn is the pool used by the writer goroutine. By default it points
// at the same *sql.DB as d.conn; if StartWriter is called with a non-empty
// AttachOtherPath, a separate writer-side *sql.DB is opened (using a driver
// that ATTACHes another database read-write) and d.writeConn points at that
// instead. Currently this is only used by the index DB to attach the app DB
// for cross-DB atomic transactions.
type DB struct {
	conn      *sql.DB
	writeConn *sql.DB
	cfg       Config
	role      DBRole
	writer    *Writer
}

// Open opens a database connection with the given configuration
func Open(cfg Config) (*DB, error) {
	// Ensure database directory exists
	if err := ensureDatabaseDirectory(cfg.Path); err != nil {
		return nil, fmt.Errorf("failed to create database directory: %w", err)
	}

	// Pick the driver name. App-role connections that need an ATTACHed index
	// get the dedicated sqlite3_app driver; otherwise fall back to the simple
	// driver (when an extension is configured) or the bare sqlite3 driver.
	driverName := "sqlite3"
	switch {
	case cfg.Role == DBRoleApp && cfg.AttachIndexPath != "":
		if err := registerAppDriver(cfg.AttachIndexPath, cfg.ExtensionPath, cfg.ExtensionDictDir); err != nil {
			return nil, fmt.Errorf("failed to register sqlite app driver: %w", err)
		}
		driverName = sqliteAppDriver
	case cfg.ExtensionPath != "":
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

	// Run migrations (filtered by role so each DB only runs its own)
	if err := runMigrations(conn, cfg.Role); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	log.Info().
		Str("path", cfg.Path).
		Str("driver", driverName).
		Msg("database opened")

	d := &DB{
		conn:      conn,
		writeConn: conn, // default: writer reuses the read pool
		cfg:       cfg,
		role:      cfg.Role,
		// writer left nil; StartWriter sets it. Splitting Open from
		// StartWriter lets the bootstrap order open both DBs first, then
		// install a cross-DB-ATTACH writer connection on the index DB.
	}

	return d, nil
}

// WriterConfig configures the per-DB writer goroutine.
//
// When AttachOtherPath is set, the writer opens its OWN *sql.DB using a
// driver whose ConnectHook ATTACHes that other database read-write under a
// fixed schema name. Currently this is used only by the index DB to attach
// the app DB as 'app', enabling cross-DB atomic transactions for file
// mutations that must also update pins.
type WriterConfig struct {
	// AttachOtherPath is the absolute path to another SQLite file that the
	// writer's connection should ATTACH read-write. Empty means no ATTACH —
	// the writer reuses the read pool.
	AttachOtherPath string
}

// StartWriter opens the writer-side connection (separately if AttachOtherPath
// is set) and starts the writer goroutine. Must be called exactly once per
// DB after Open and before any Write call.
func (d *DB) StartWriter(wcfg WriterConfig) error {
	if d.writer != nil {
		return fmt.Errorf("writer already started")
	}

	if wcfg.AttachOtherPath != "" {
		if d.role != DBRoleIndex {
			return fmt.Errorf("WriterConfig.AttachOtherPath is only supported for DBRoleIndex (got %s)", d.role)
		}
		if err := registerIdxWriterDriver(wcfg.AttachOtherPath, d.cfg.ExtensionPath, d.cfg.ExtensionDictDir); err != nil {
			return fmt.Errorf("register idx-writer driver: %w", err)
		}
		dsn := d.cfg.Path + "?_foreign_keys=1&_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL&_cache_size=-64000"
		writeConn, err := sql.Open(sqliteIdxWriterDriver, dsn)
		if err != nil {
			return fmt.Errorf("open writer conn: %w", err)
		}
		// Single connection in the writer pool — the writer goroutine is
		// the only user, and SQLite is single-writer anyway. Avoids
		// re-attaching across many connections.
		writeConn.SetMaxOpenConns(1)
		writeConn.SetMaxIdleConns(1)
		writeConn.SetConnMaxLifetime(0)
		if err := writeConn.Ping(); err != nil {
			writeConn.Close()
			return fmt.Errorf("ping writer conn: %w", err)
		}
		d.writeConn = writeConn
		log.Info().
			Str("path", d.cfg.Path).
			Str("attach", wcfg.AttachOtherPath).
			Msg("idx-writer connection opened (cross-DB ATTACH rw)")
	}

	d.writer = newWriter(d.writeConn, writerQueueSize)
	go d.writer.run()
	return nil
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

// registerAppDriver registers the sqlite3_app driver exactly once. Connections
// from this driver ATTACH the configured index DB read-only as 'idx', and
// also load the simple FTS5 extension when extensionPath is non-empty.
// Subsequent calls with matching arguments are no-ops; mismatched calls return
// an error because sql.Register cannot be reset without a process restart.
func registerAppDriver(indexPath, extensionPath, dictDir string) error {
	appDriverMu.Lock()
	defer appDriverMu.Unlock()

	if appDriverRegistered {
		if indexPath != appDriverIndexPath || extensionPath != appDriverExtPath || dictDir != appDriverDictDir {
			return fmt.Errorf(
				"sqlite app driver already registered with index=%q ext=%q dict=%q; cannot re-register with index=%q ext=%q dict=%q",
				appDriverIndexPath, appDriverExtPath, appDriverDictDir,
				indexPath, extensionPath, dictDir,
			)
		}
		return nil
	}

	// Verify the index DB exists (it must be opened first by server.New so
	// the file is present on disk before we ATTACH it). A clearer error
	// here beats an opaque ATTACH failure on the first connection.
	if _, err := os.Stat(indexPath); err != nil {
		return fmt.Errorf("index db not found at %s (must be opened before app db): %w", indexPath, err)
	}

	sql.Register(sqliteAppDriver, &sqlite3.SQLiteDriver{
		ConnectHook: func(conn *sqlite3.SQLiteConn) error {
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
			attachSQL := fmt.Sprintf("ATTACH DATABASE 'file:%s?mode=ro' AS idx", indexPath)
			if _, err := conn.Exec(attachSQL, nil); err != nil {
				return fmt.Errorf("attach index db: %w", err)
			}
			return nil
		},
	})

	appDriverRegistered = true
	appDriverIndexPath = indexPath
	appDriverExtPath = extensionPath
	appDriverDictDir = dictDir
	return nil
}

// registerIdxWriterDriver registers a driver whose connections ATTACH the app
// DB read-write as 'app'. Used only by the index DB's writer connection so
// that file-mutation transactions can atomically update app.pins (and any
// other app-side state that must change in lockstep with files).
func registerIdxWriterDriver(appPath, extensionPath, dictDir string) error {
	idxWriterDriverMu.Lock()
	defer idxWriterDriverMu.Unlock()

	if idxWriterDriverRegistered {
		if appPath != idxWriterDriverAppPath || extensionPath != idxWriterDriverExtPath || dictDir != idxWriterDriverDictDir {
			return fmt.Errorf(
				"idx-writer driver already registered with app=%q ext=%q dict=%q; cannot re-register with app=%q ext=%q dict=%q",
				idxWriterDriverAppPath, idxWriterDriverExtPath, idxWriterDriverDictDir,
				appPath, extensionPath, dictDir,
			)
		}
		return nil
	}

	// Verify the app DB exists — the writer's ConnectHook will fail to ATTACH
	// otherwise. A clear error here beats an opaque sqlite "no such file"
	// later from the first connection.
	if _, err := os.Stat(appPath); err != nil {
		return fmt.Errorf("app db not found at %s (must be opened before idx writer): %w", appPath, err)
	}

	sql.Register(sqliteIdxWriterDriver, &sqlite3.SQLiteDriver{
		ConnectHook: func(conn *sqlite3.SQLiteConn) error {
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
			attachSQL := fmt.Sprintf("ATTACH DATABASE 'file:%s?mode=rw' AS app", appPath)
			if _, err := conn.Exec(attachSQL, nil); err != nil {
				return fmt.Errorf("attach app db rw: %w", err)
			}
			return nil
		},
	})

	idxWriterDriverRegistered = true
	idxWriterDriverAppPath = appPath
	idxWriterDriverExtPath = extensionPath
	idxWriterDriverDictDir = dictDir
	return nil
}

// Close closes the database connection
func (d *DB) Close() error {
	if d.writer != nil {
		d.writer.stop()
	}
	// Close writer-side conn if it's a different *sql.DB (cross-DB ATTACH case).
	if d.writeConn != nil && d.writeConn != d.conn {
		if err := d.writeConn.Close(); err != nil {
			log.Error().Err(err).Str("path", d.cfg.Path).Msg("close writer conn")
		}
	}
	if d.conn != nil {
		return d.conn.Close()
	}
	return nil
}

// Conn returns the underlying sql.DB connection
func (d *DB) Conn() *sql.DB {
	return d.conn
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
