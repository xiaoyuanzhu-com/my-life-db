package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "github.com/mattn/go-sqlite3"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	// globalDB is set by the server when it initializes
	// All existing db query functions use this
	globalDB *DB
	mu       sync.RWMutex
)

// DB wraps a sql.DB connection
type DB struct {
	conn *sql.DB
	cfg  Config
}

// Open opens a database connection with the given configuration
func Open(cfg Config) (*DB, error) {
	// Ensure database directory exists
	if err := ensureDatabaseDirectory(cfg.Path); err != nil {
		return nil, fmt.Errorf("failed to create database directory: %w", err)
	}

	// Open database connection with SQLite pragmas
	// Using WAL mode, foreign keys, and optimized settings
	dsn := cfg.Path + "?_foreign_keys=1&_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL&_cache_size=-64000"

	conn, err := sql.Open("sqlite3", dsn)
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

	log.Info().Str("path", cfg.Path).Msg("database opened")

	d := &DB{
		conn: conn,
		cfg:  cfg,
	}

	// Set as global for existing query functions
	mu.Lock()
	globalDB = d
	mu.Unlock()

	return d, nil
}

// Close closes the database connection
func (d *DB) Close() error {
	mu.Lock()
	defer mu.Unlock()

	if d.conn != nil {
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
