package db

// DBRole tags a *DB instance with its purpose. The two roles correspond to
// two physical SQLite files in APP_DATA_DIR.
type DBRole int

const (
	// DBRoleIndex is the rebuildable file/search index.
	// Tables: files, files_fts, sqlar, digests.
	// File: index.sqlite.
	DBRoleIndex DBRole = iota

	// DBRoleApp is persistent user data.
	// Tables: pins, settings, sessions, agent_sessions, etc.
	// File: app.sqlite.
	DBRoleApp
)

func (r DBRole) String() string {
	switch r {
	case DBRoleIndex:
		return "index"
	case DBRoleApp:
		return "app"
	default:
		return "unknown"
	}
}
