# Database Layer

The database layer provides SQLite access with migrations, generic query helpers, and domain-specific functions.

## Architecture

```
Database Package
├── connection.go     # DB struct, Open/Close, singleton
├── client.go         # Generic query helpers (Select, SelectOne, Run)
├── migrations.go     # Migration runner
├── migration_*.go    # Individual migrations
├── models.go         # Data structures
├── files.go          # File operations
├── digests.go        # Digest operations
├── pins.go           # Pin operations
├── settings.go       # Settings operations
├── sqlar.go          # SQLAR archive operations
├── meili_documents.go # Meilisearch sync
└── qdrant_documents.go # Qdrant sync
```

## Key Components

| Location | Purpose |
|----------|---------|
| `backend/db/connection.go` | Database connection, Open/Close |
| `backend/db/client.go` | Generic query helpers |
| `backend/db/migrations.go` | Migration system |
| `backend/db/models.go` | Data structures |

## Database Singleton

```go
// backend/db/connection.go
type DB struct {
    *sql.DB
}

var (
    globalDB *DB
    mu       sync.RWMutex
)

// Open initializes the database connection
func Open(cfg Config) (*DB, error) {
    // Open SQLite with CGO (mattn/go-sqlite3)
    db, err := sql.Open("sqlite3", cfg.Path+"?_journal_mode=WAL")
    if err != nil {
        return nil, err
    }

    globalDB = &DB{db}

    // Run migrations
    if err := runMigrations(db); err != nil {
        return nil, err
    }

    return globalDB, nil
}

// GetDB returns the global database instance
func GetDB() *sql.DB {
    return globalDB.DB
}
```

## Generic Query Helpers

### Select (Multiple Rows)

```go
// Select runs a SELECT query returning multiple rows
func Select[T any](query string, params []QueryParam, scanner func(*sql.Rows) (T, error)) ([]T, error)

// Example usage
files, err := Select(
    "SELECT path, size FROM files WHERE is_folder = ?",
    []QueryParam{false},
    func(rows *sql.Rows) (FileRecord, error) {
        var f FileRecord
        err := rows.Scan(&f.Path, &f.Size)
        return f, err
    },
)
```

### SelectOne (Single Row)

```go
// SelectOne runs a SELECT query returning a single row (or nil if not found)
func SelectOne[T any](query string, params []QueryParam, scanner func(*sql.Row) (T, error)) (*T, error)

// Example usage
file, err := SelectOne(
    "SELECT path, size FROM files WHERE path = ?",
    []QueryParam{path},
    func(row *sql.Row) (FileRecord, error) {
        var f FileRecord
        err := row.Scan(&f.Path, &f.Size)
        return f, err
    },
)
// file is nil if not found
```

### Run (INSERT/UPDATE/DELETE)

```go
// Run executes an INSERT/UPDATE/DELETE query
func Run(query string, params ...QueryParam) (sql.Result, error)

// Example usage
_, err := Run(
    "UPDATE files SET size = ? WHERE path = ?",
    newSize, path,
)
```

### Exists

```go
// Exists checks if a row exists matching the query
func Exists(query string, params ...QueryParam) (bool, error)

// Example usage
exists, err := Exists(
    "SELECT 1 FROM files WHERE path = ?",
    path,
)
```

### Count

```go
// Count returns the count of rows matching the query
func Count(query string, params ...QueryParam) (int64, error)

// Example usage
count, err := Count(
    "SELECT COUNT(*) FROM digests WHERE status = ?",
    "completed",
)
```

## Query Logging

Enable with `DB_LOG_QUERIES=1`:

```go
var shouldLogQueries bool

func logQuery(kind string, sql string, params []QueryParam) {
    if !shouldLogQueries {
        return
    }
    log.Debug().
        Str("kind", kind).
        Str("sql", sql).
        Interface("params", params).
        Msg("db query")
}
```

## Migration System

### Structure

```go
type Migration struct {
    Version     int
    Description string
    Up          func(db *sql.DB) error
}
```

### Current Migrations

| Version | File | Description |
|---------|------|-------------|
| 1 | `migration_001_initial.go` | Initial schema (files, digests, sqlar, settings) |
| 2 | `migration_002_search_tables.go` | Search index tables (meili, qdrant) |
| 3 | `migration_003_fix_pins_schema.go` | Fix pins table schema |

### Adding a New Migration

1. **Create migration file**:
   ```go
   // backend/db/migration_004_my_feature.go
   package db

   import "database/sql"

   func init() {
       RegisterMigration(Migration{
           Version:     4,
           Description: "Add my new feature",
           Up: func(db *sql.DB) error {
               _, err := db.Exec(`
                   CREATE TABLE my_table (
                       id TEXT PRIMARY KEY,
                       name TEXT NOT NULL
                   )
               `)
               return err
           },
       })
   }
   ```

2. **Migrations run automatically** on `db.Open()`

3. **Test on fresh database**:
   ```bash
   rm -rf .my-life-db/ && go run .
   ```

### Schema Version Tracking

```sql
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT,
    description TEXT
);
```

## Core Tables

### files

```sql
CREATE TABLE files (
    path TEXT PRIMARY KEY,         -- Relative path from data root
    name TEXT NOT NULL,
    size INTEGER,
    mime_type TEXT,
    is_folder INTEGER DEFAULT 0,
    hash TEXT,                     -- Content hash
    text_preview TEXT,             -- First ~500 chars for text files
    screenshot_sqlar TEXT,         -- SQLAR path for preview image
    created_at TEXT,
    modified_at TEXT,
    indexed_at TEXT
);
```

### digests

```sql
CREATE TABLE digests (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    digester TEXT NOT NULL,        -- Digester name (e.g., "url-crawl-content")
    status TEXT NOT NULL,          -- todo, in-progress, completed, skipped, failed
    content TEXT,                  -- Extracted text content
    sqlar_name TEXT,               -- SQLAR filename for binary data
    error TEXT,
    attempts INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(file_path, digester)
);
```

### pins

```sql
CREATE TABLE pins (
    id TEXT PRIMARY KEY,
    file_path TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
);
```

### settings

```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### sqlar (Archive Format)

```sql
CREATE TABLE sqlar (
    name TEXT PRIMARY KEY,         -- Path within archive
    mode INT,
    mtime INT,
    sz INT,                        -- Uncompressed size
    data BLOB                      -- Compressed content (zlib)
);
```

## Domain Functions

### File Operations

```go
// backend/db/files.go
func GetFileByPath(path string) (*FileRecord, error)
func UpsertFile(file *FileRecord) error
func DeleteFile(path string) error
func ListFilesInFolder(folderPath string, limit, offset int) ([]FileRecord, error)
func UpdateFileField(path, field string, value interface{}) error
```

### Digest Operations

```go
// backend/db/digests.go
func GetDigestByID(id string) (*Digest, error)
func GetDigestByPathAndDigester(path, digester string) (*Digest, error)
func ListDigestsForPath(path string) []Digest
func CreateDigest(d *Digest) error
func UpdateDigestMap(id string, updates map[string]interface{}) error
func GetFilesWithPendingDigests() []string
```

### SQLAR Operations

```go
// backend/db/sqlar.go
func SqlarStore(name string, data []byte, mode int) error
func SqlarRead(name string) ([]byte, error)
func SqlarDelete(name string) error
func SqlarExists(name string) bool
```

### Settings Operations

```go
// backend/db/settings.go
func LoadUserSettings() (*UserSettings, error)
func SaveUserSettings(settings *UserSettings) error
func GetSetting(key string) (string, error)
func SetSetting(key, value string) error
```

## Data Models

```go
// backend/db/models.go
type FileRecord struct {
    Path           string
    Name           string
    Size           int64
    MimeType       string
    IsFolder       bool
    Hash           string
    TextPreview    string
    ScreenshotSqlar string
    CreatedAt      time.Time
    ModifiedAt     time.Time
    IndexedAt      time.Time
}

type Digest struct {
    ID        string
    FilePath  string
    Digester  string
    Status    string
    Content   *string
    SqlarName *string
    Error     *string
    Attempts  int
    CreatedAt string
    UpdatedAt string
}
```

## CGO Requirement

The database uses `mattn/go-sqlite3` which requires CGO:

```bash
CGO_ENABLED=1 go build .
```

## Common Patterns

### Transaction

```go
db := GetDB()
tx, err := db.Begin()
if err != nil {
    return err
}
defer tx.Rollback()

// Execute queries with tx
_, err = tx.Exec("INSERT INTO ...")
if err != nil {
    return err
}

return tx.Commit()
```

### Nullable Fields

```go
// Use sql.NullString for optional fields
var textPreview sql.NullString
err := row.Scan(&textPreview)

if textPreview.Valid {
    result.TextPreview = textPreview.String
}
```

## Files to Modify

| Task | Files |
|------|-------|
| Add new table | Create `backend/db/migration_NNN_*.go` |
| Add domain functions | Create or modify `backend/db/*.go` |
| Add data model | `backend/db/models.go` |
| Change query helpers | `backend/db/client.go` |
