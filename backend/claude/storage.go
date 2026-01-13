package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
)

// Storage handles session persistence
type Storage struct {
	sessionsDir string
}

// NewStorage creates a new storage instance
func NewStorage() (*Storage, error) {
	sessionsDir := filepath.Join(config.Get().DataDir, "app", "my-life-db", "claude-sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create sessions dir: %w", err)
	}

	return &Storage{
		sessionsDir: sessionsDir,
	}, nil
}

// SaveSession persists a session to disk
func (s *Storage) SaveSession(session *Session) error {
	data, err := json.MarshalIndent(session.ToJSON(), "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal session: %w", err)
	}

	filePath := filepath.Join(s.sessionsDir, session.ID+".json")
	if err := os.WriteFile(filePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write session file: %w", err)
	}

	return nil
}

// DeleteSession removes a session from disk
func (s *Storage) DeleteSession(id string) error {
	filePath := filepath.Join(s.sessionsDir, id+".json")
	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete session file: %w", err)
	}
	return nil
}

// ListSessions returns all session metadata from disk
func (s *Storage) ListSessions() ([]*Session, error) {
	entries, err := os.ReadDir(s.sessionsDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read sessions dir: %w", err)
	}

	sessions := make([]*Session, 0)
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		filePath := filepath.Join(s.sessionsDir, entry.Name())
		data, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}

		var session Session
		if err := json.Unmarshal(data, &session); err != nil {
			continue
		}

		sessions = append(sessions, &session)
	}

	return sessions, nil
}
