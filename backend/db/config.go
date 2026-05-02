package db

import "time"

// Config holds database configuration
type Config struct {
	Path            string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	LogQueries      bool

	// Role tags this database instance for routing migrations and for log/error
	// messages. See DBRole.
	Role DBRole

	// SQLite extension loading.
	// ExtensionPath is the absolute path to a SQLite extension shared library
	// (e.g. /opt/.../libsimple.dylib on macOS, /opt/.../libsimple.so on Linux).
	// When non-empty, the extension is loaded on every new connection.
	ExtensionPath string
	// ExtensionDictDir is passed to SELECT jieba_dict(?) once per connection
	// after loading the simple extension. Required for Chinese word segmentation.
	// When empty, jieba_dict is not called (English-only tokenization still works).
	ExtensionDictDir string
}
