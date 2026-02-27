package db

import (
	"database/sql"
	"fmt"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

func init() {
	RegisterMigration(Migration{
		Version:     10,
		Description: "Convert all TEXT timestamp columns to INTEGER (epoch milliseconds)",
		Up:          migration010_epochTimestamps,
	})
}

// tsToMs is the SQL expression to convert a TEXT timestamp to epoch milliseconds.
// Returns 0 for NULL/empty values (for NOT NULL columns).
const tsToMs = `CASE WHEN %s IS NULL OR %s = '' THEN 0 ELSE CAST(strftime('%%s', %s) AS INTEGER) * 1000 END`

// tsToMsNullable is the SQL expression to convert a TEXT timestamp to epoch milliseconds.
// Returns NULL for NULL/empty values (for nullable columns).
const tsToMsNullable = `CASE WHEN %s IS NULL OR %s = '' THEN NULL ELSE CAST(strftime('%%s', %s) AS INTEGER) * 1000 END`

// ts builds a NOT NULL timestamp conversion expression for a column name.
func ts(col string) string {
	return fmt.Sprintf(tsToMs, col, col, col)
}

// tsNull builds a nullable timestamp conversion expression for a column name.
func tsNull(col string) string {
	return fmt.Sprintf(tsToMsNullable, col, col, col)
}

func migration010_epochTimestamps(database *sql.DB) error {
	tx, err := database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// ── files ────────────────────────────────────────────────────────────
	if err := migrateFiles(tx); err != nil {
		return fmt.Errorf("migrate files: %w", err)
	}

	// ── digests ──────────────────────────────────────────────────────────
	if err := migrateDigests(tx); err != nil {
		return fmt.Errorf("migrate digests: %w", err)
	}

	// ── pins ─────────────────────────────────────────────────────────────
	if err := migratePins(tx); err != nil {
		return fmt.Errorf("migrate pins: %w", err)
	}

	// ── settings ─────────────────────────────────────────────────────────
	if err := migrateSettings(tx); err != nil {
		return fmt.Errorf("migrate settings: %w", err)
	}

	// ── sessions ─────────────────────────────────────────────────────────
	if err := migrateSessions(tx); err != nil {
		return fmt.Errorf("migrate sessions: %w", err)
	}

	// ── meili_documents ──────────────────────────────────────────────────
	if err := migrateMeiliDocuments(tx); err != nil {
		return fmt.Errorf("migrate meili_documents: %w", err)
	}

	// ── session_read_status ──────────────────────────────────────────────
	if err := migrateSessionReadStatus(tx); err != nil {
		return fmt.Errorf("migrate session_read_status: %w", err)
	}

	// ── archived_claude_sessions ─────────────────────────────────────────
	if err := migrateArchivedClaudeSessions(tx); err != nil {
		return fmt.Errorf("migrate archived_claude_sessions: %w", err)
	}

	// ── collectors ───────────────────────────────────────────────────────
	if err := migrateCollectors(tx); err != nil {
		return fmt.Errorf("migrate collectors: %w", err)
	}

	// ── agent_conversations ──────────────────────────────────────────────
	if err := migrateAgentConversations(tx); err != nil {
		return fmt.Errorf("migrate agent_conversations: %w", err)
	}

	// ── agent_messages ───────────────────────────────────────────────────
	if err := migrateAgentMessages(tx); err != nil {
		return fmt.Errorf("migrate agent_messages: %w", err)
	}

	// ── file_intentions ──────────────────────────────────────────────────
	if err := migrateFileIntentions(tx); err != nil {
		return fmt.Errorf("migrate file_intentions: %w", err)
	}

	// ── organization_suggestions ─────────────────────────────────────────
	if err := migrateOrganizationSuggestions(tx); err != nil {
		return fmt.Errorf("migrate organization_suggestions: %w", err)
	}

	log.Info().Msg("migration 010: all timestamp columns converted to epoch milliseconds")
	return tx.Commit()
}

// tableExists checks whether a table exists in the database.
func tableExists(tx *sql.Tx, name string) (bool, error) {
	var exists bool
	err := tx.QueryRow(`
		SELECT COUNT(*) > 0
		FROM sqlite_master
		WHERE type='table' AND name=?
	`, name).Scan(&exists)
	return exists, err
}

// ── files ────────────────────────────────────────────────────────────────────

func migrateFiles(tx *sql.Tx) error {
	exists, err := tableExists(tx, "files")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting files timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE files_new (
			path TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			is_folder INTEGER NOT NULL DEFAULT 0,
			size INTEGER,
			mime_type TEXT,
			hash TEXT,
			modified_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			last_scanned_at INTEGER,
			text_preview TEXT,
			preview_sqlar TEXT
		);

		INSERT INTO files_new
		SELECT
			path, name, is_folder, size, mime_type, hash,
			%s,
			%s,
			%s,
			text_preview, preview_sqlar
		FROM files;

		DROP TABLE files;
		ALTER TABLE files_new RENAME TO files;

		CREATE INDEX idx_files_path_prefix ON files(path);
		CREATE INDEX idx_files_is_folder ON files(is_folder);
		CREATE INDEX idx_files_modified_at ON files(modified_at);
		CREATE INDEX idx_files_created_at ON files(created_at);
	`, ts("modified_at"), ts("created_at"), tsNull("last_scanned_at")))

	return err
}

// ── digests ──────────────────────────────────────────────────────────────────

func migrateDigests(tx *sql.Tx) error {
	exists, err := tableExists(tx, "digests")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting digests timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE digests_new (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			digester TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'todo',
			content TEXT,
			sqlar_name TEXT,
			error TEXT,
			attempts INTEGER DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(file_path, digester)
		);

		INSERT INTO digests_new
		SELECT
			id, file_path, digester, status, content, sqlar_name, error, attempts,
			%s,
			%s
		FROM digests
		WHERE rowid IN (
			SELECT MAX(rowid) FROM digests GROUP BY file_path, digester
		);

		DROP TABLE digests;
		ALTER TABLE digests_new RENAME TO digests;

		CREATE INDEX idx_digests_file_path ON digests(file_path);
		CREATE INDEX idx_digests_digester ON digests(digester);
		CREATE INDEX idx_digests_status ON digests(status);
	`, ts("created_at"), ts("updated_at")))

	return err
}

// ── pins ─────────────────────────────────────────────────────────────────────

func migratePins(tx *sql.Tx) error {
	exists, err := tableExists(tx, "pins")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting pins timestamps")

	// The pins table has schema from migration_003:
	// id TEXT PK, file_path TEXT UNIQUE, pinned_at TEXT, created_at TEXT
	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE pins_new (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL UNIQUE,
			pinned_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);

		INSERT INTO pins_new
		SELECT
			id, file_path,
			%s,
			%s
		FROM pins;

		DROP TABLE pins;
		ALTER TABLE pins_new RENAME TO pins;

		CREATE INDEX idx_pins_file_path ON pins(file_path);
		CREATE INDEX idx_pins_pinned_at ON pins(pinned_at DESC);
	`, ts("pinned_at"), ts("created_at")))

	return err
}

// ── settings ─────────────────────────────────────────────────────────────────

func migrateSettings(tx *sql.Tx) error {
	exists, err := tableExists(tx, "settings")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting settings timestamps")

	// Drop the old trigger first (it references the old column type)
	_, err = tx.Exec(`DROP TRIGGER IF EXISTS settings_updated_at`)
	if err != nil {
		return err
	}

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE settings_new (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at INTEGER
		);

		INSERT INTO settings_new
		SELECT
			key, value,
			%s
		FROM settings;

		DROP TABLE settings;
		ALTER TABLE settings_new RENAME TO settings;
	`, tsNull("updated_at")))
	if err != nil {
		return err
	}

	// Recreate the trigger with epoch ms
	_, err = tx.Exec(`
		CREATE TRIGGER settings_updated_at
		AFTER UPDATE ON settings
		BEGIN
			UPDATE settings SET updated_at = (CAST(strftime('%s', 'now') AS INTEGER) * 1000) WHERE key = NEW.key;
		END;
	`)

	return err
}

// ── sessions ─────────────────────────────────────────────────────────────────

func migrateSessions(tx *sql.Tx) error {
	exists, err := tableExists(tx, "sessions")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting sessions timestamps")

	// PK column is "token" in Node.js legacy databases, "id" in fresh Go databases.
	// Migration 004 normalizes this for fresh runs, but existing DBs already passed 004.
	pkCol := "id"
	rows, err := tx.Query(`PRAGMA table_info(sessions)`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull int
		var dfltValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			rows.Close()
			return err
		}
		if name == "token" {
			pkCol = "token"
		}
	}
	rows.Close()

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE sessions_new (
			id TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			last_used_at INTEGER NOT NULL
		);

		INSERT INTO sessions_new
		SELECT
			%s,
			%s,
			%s,
			%s
		FROM sessions;

		DROP TABLE sessions;
		ALTER TABLE sessions_new RENAME TO sessions;

		CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
	`, pkCol, ts("created_at"), ts("expires_at"), ts("last_used_at")))

	return err
}

// ── meili_documents ──────────────────────────────────────────────────────────

func migrateMeiliDocuments(tx *sql.Tx) error {
	exists, err := tableExists(tx, "meili_documents")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting meili_documents timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE meili_documents_new (
			document_id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL UNIQUE,

			content TEXT NOT NULL,
			summary TEXT,
			tags TEXT,
			content_hash TEXT NOT NULL,
			word_count INTEGER NOT NULL,

			mime_type TEXT,
			metadata_json TEXT,

			meili_status TEXT NOT NULL DEFAULT 'pending'
				CHECK(meili_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
			meili_task_id TEXT,
			meili_indexed_at INTEGER,
			meili_error TEXT,

			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

		INSERT INTO meili_documents_new
		SELECT
			document_id, file_path,
			content, summary, tags, content_hash, word_count,
			mime_type, metadata_json,
			meili_status, meili_task_id,
			%s,
			meili_error,
			%s,
			%s
		FROM meili_documents;

		DROP TABLE meili_documents;
		ALTER TABLE meili_documents_new RENAME TO meili_documents;

		CREATE INDEX idx_meili_documents_file_path ON meili_documents(file_path);
		CREATE INDEX idx_meili_documents_status ON meili_documents(meili_status);
		CREATE INDEX idx_meili_documents_hash ON meili_documents(content_hash);
	`, tsNull("meili_indexed_at"), ts("created_at"), ts("updated_at")))

	return err
}

// ── session_read_status ──────────────────────────────────────────────────────

func migrateSessionReadStatus(tx *sql.Tx) error {
	exists, err := tableExists(tx, "session_read_status")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting session_read_status timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE session_read_status_new (
			session_id              TEXT PRIMARY KEY,
			last_read_message_count INTEGER NOT NULL DEFAULT 0,
			updated_at              INTEGER NOT NULL DEFAULT 0
		);

		INSERT INTO session_read_status_new
		SELECT
			session_id, last_read_message_count,
			%s
		FROM session_read_status;

		DROP TABLE session_read_status;
		ALTER TABLE session_read_status_new RENAME TO session_read_status;
	`, ts("updated_at")))

	return err
}

// ── archived_claude_sessions ─────────────────────────────────────────────────

func migrateArchivedClaudeSessions(tx *sql.Tx) error {
	exists, err := tableExists(tx, "archived_claude_sessions")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting archived_claude_sessions timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE archived_claude_sessions_new (
			session_id TEXT PRIMARY KEY,
			hidden_at INTEGER NOT NULL
		);

		INSERT INTO archived_claude_sessions_new
		SELECT
			session_id,
			%s
		FROM archived_claude_sessions;

		DROP TABLE archived_claude_sessions;
		ALTER TABLE archived_claude_sessions_new RENAME TO archived_claude_sessions;
	`, ts("hidden_at")))

	return err
}

// ── collectors ───────────────────────────────────────────────────────────────

func migrateCollectors(tx *sql.Tx) error {
	exists, err := tableExists(tx, "collectors")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting collectors timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE collectors_new (
			id         TEXT PRIMARY KEY,
			enabled    INTEGER NOT NULL DEFAULT 0,
			config     TEXT,
			updated_at INTEGER NOT NULL DEFAULT 0
		);

		INSERT INTO collectors_new
		SELECT
			id, enabled, config,
			%s
		FROM collectors;

		DROP TABLE collectors;
		ALTER TABLE collectors_new RENAME TO collectors;
	`, ts("updated_at")))

	return err
}

// ── agent_conversations ──────────────────────────────────────────────────────

func migrateAgentConversations(tx *sql.Tx) error {
	exists, err := tableExists(tx, "agent_conversations")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting agent_conversations timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE agent_conversations_new (
			id TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			status TEXT DEFAULT 'active',
			summary TEXT
		);

		INSERT INTO agent_conversations_new
		SELECT
			id,
			%s,
			%s,
			status, summary
		FROM agent_conversations;

		DROP TABLE agent_conversations;
		ALTER TABLE agent_conversations_new RENAME TO agent_conversations;

		CREATE INDEX idx_agent_conversations_status ON agent_conversations(status);
		CREATE INDEX idx_agent_conversations_updated_at ON agent_conversations(updated_at);
	`, ts("created_at"), ts("updated_at")))

	return err
}

// ── agent_messages ───────────────────────────────────────────────────────────

func migrateAgentMessages(tx *sql.Tx) error {
	exists, err := tableExists(tx, "agent_messages")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting agent_messages timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE agent_messages_new (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			metadata TEXT,
			created_at INTEGER NOT NULL,
			FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
		);

		INSERT INTO agent_messages_new
		SELECT
			id, conversation_id, role, content, metadata,
			%s
		FROM agent_messages;

		DROP TABLE agent_messages;
		ALTER TABLE agent_messages_new RENAME TO agent_messages;

		CREATE INDEX idx_agent_messages_conversation_id ON agent_messages(conversation_id);
		CREATE INDEX idx_agent_messages_created_at ON agent_messages(created_at);
	`, ts("created_at")))

	return err
}

// ── file_intentions ──────────────────────────────────────────────────────────

func migrateFileIntentions(tx *sql.Tx) error {
	exists, err := tableExists(tx, "file_intentions")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting file_intentions timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE file_intentions_new (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL UNIQUE,
			conversation_id TEXT,
			intention_type TEXT NOT NULL,
			intention_details TEXT,
			confidence REAL NOT NULL,
			suggested_folder TEXT,
			reasoning TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
		);

		INSERT INTO file_intentions_new
		SELECT
			id, file_path, conversation_id, intention_type, intention_details,
			confidence, suggested_folder, reasoning,
			%s,
			%s
		FROM file_intentions;

		DROP TABLE file_intentions;
		ALTER TABLE file_intentions_new RENAME TO file_intentions;

		CREATE INDEX idx_file_intentions_file_path ON file_intentions(file_path);
		CREATE INDEX idx_file_intentions_conversation_id ON file_intentions(conversation_id);
		CREATE INDEX idx_file_intentions_intention_type ON file_intentions(intention_type);
	`, ts("created_at"), ts("updated_at")))

	return err
}

// ── organization_suggestions ─────────────────────────────────────────────────

func migrateOrganizationSuggestions(tx *sql.Tx) error {
	exists, err := tableExists(tx, "organization_suggestions")
	if err != nil || !exists {
		return err
	}

	log.Info().Msg("migration 010: converting organization_suggestions timestamps")

	_, err = tx.Exec(fmt.Sprintf(`
		CREATE TABLE organization_suggestions_new (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			file_path TEXT NOT NULL,
			target_folder TEXT NOT NULL,
			reasoning TEXT NOT NULL,
			confidence REAL NOT NULL,
			status TEXT DEFAULT 'pending',
			created_at INTEGER NOT NULL,
			resolved_at INTEGER,
			FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
		);

		INSERT INTO organization_suggestions_new
		SELECT
			id, conversation_id, file_path, target_folder, reasoning,
			confidence, status,
			%s,
			%s
		FROM organization_suggestions;

		DROP TABLE organization_suggestions;
		ALTER TABLE organization_suggestions_new RENAME TO organization_suggestions;

		CREATE INDEX idx_organization_suggestions_conversation_id ON organization_suggestions(conversation_id);
		CREATE INDEX idx_organization_suggestions_file_path ON organization_suggestions(file_path);
		CREATE INDEX idx_organization_suggestions_status ON organization_suggestions(status);
	`, ts("created_at"), tsNull("resolved_at")))

	return err
}
