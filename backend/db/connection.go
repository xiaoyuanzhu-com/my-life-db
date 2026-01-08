package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"sync"

	_ "github.com/mattn/go-sqlite3"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	db   *sql.DB
	once sync.Once
	mu   sync.RWMutex
)

// GetDB returns the singleton database connection
func GetDB() *sql.DB {
	once.Do(func() {
		cfg := config.Get()

		// Ensure database directory exists
		if err := ensureDatabaseDirectory(cfg.DatabasePath); err != nil {
			log.Fatal().Err(err).Msg("failed to create database directory")
		}

		// Open database connection with SQLite pragmas
		// Using WAL mode, foreign keys, and optimized settings
		dsn := cfg.DatabasePath + "?_foreign_keys=1&_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL&_cache_size=-64000"

		var err error
		db, err = sql.Open("sqlite3", dsn)
		if err != nil {
			log.Fatal().Err(err).Str("path", cfg.DatabasePath).Msg("failed to open database")
		}

		// Configure connection pool for better concurrency
		// WAL mode allows multiple readers + one writer concurrently
		db.SetMaxOpenConns(5) // Allow concurrent reads
		db.SetMaxIdleConns(2)
		db.SetConnMaxLifetime(0) // Connections never expire

		// Verify connection
		if err := db.Ping(); err != nil {
			log.Fatal().Err(err).Msg("failed to ping database")
		}

		// Run migrations
		if err := runMigrations(db); err != nil {
			log.Fatal().Err(err).Msg("failed to run migrations")
		}

		log.Info().Str("path", cfg.DatabasePath).Msg("database initialized")
	})

	return db
}

// Close closes the database connection
func Close() error {
	mu.Lock()
	defer mu.Unlock()

	if db != nil {
		return db.Close()
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
func Transaction(fn func(*sql.Tx) error) error {
	tx, err := GetDB().Begin()
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
