package db

import (
	"database/sql"
)

func init() {
	RegisterMigration(Migration{
		Version:     5,
		Description: "Add agent tables for inbox automation",
		Up:          migration005_agent,
	})
}

func migration005_agent(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Conversations table - tracks agent conversations
	_, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS agent_conversations (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			status TEXT DEFAULT 'active',
			summary TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_agent_conversations_status ON agent_conversations(status);
		CREATE INDEX IF NOT EXISTS idx_agent_conversations_updated_at ON agent_conversations(updated_at);
	`)
	if err != nil {
		return err
	}

	// Messages table - stores conversation messages
	_, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS agent_messages (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			metadata TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
		);

		CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation_id ON agent_messages(conversation_id);
		CREATE INDEX IF NOT EXISTS idx_agent_messages_created_at ON agent_messages(created_at);
	`)
	if err != nil {
		return err
	}

	// File intentions table - stores agent's analysis of file intentions
	_, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS file_intentions (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL UNIQUE,
			conversation_id TEXT,
			intention_type TEXT NOT NULL,
			intention_details TEXT,
			confidence REAL NOT NULL,
			suggested_folder TEXT,
			reasoning TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
		);

		CREATE INDEX IF NOT EXISTS idx_file_intentions_file_path ON file_intentions(file_path);
		CREATE INDEX IF NOT EXISTS idx_file_intentions_conversation_id ON file_intentions(conversation_id);
		CREATE INDEX IF NOT EXISTS idx_file_intentions_intention_type ON file_intentions(intention_type);
	`)
	if err != nil {
		return err
	}

	// Organization suggestions table - stores pending move suggestions
	_, err = tx.Exec(`
		CREATE TABLE IF NOT EXISTS organization_suggestions (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			file_path TEXT NOT NULL,
			target_folder TEXT NOT NULL,
			reasoning TEXT NOT NULL,
			confidence REAL NOT NULL,
			status TEXT DEFAULT 'pending',
			created_at TEXT NOT NULL,
			resolved_at TEXT,
			FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id)
		);

		CREATE INDEX IF NOT EXISTS idx_organization_suggestions_conversation_id ON organization_suggestions(conversation_id);
		CREATE INDEX IF NOT EXISTS idx_organization_suggestions_file_path ON organization_suggestions(file_path);
		CREATE INDEX IF NOT EXISTS idx_organization_suggestions_status ON organization_suggestions(status);
	`)
	if err != nil {
		return err
	}

	return tx.Commit()
}
