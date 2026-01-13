package claude

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	ErrSessionNotFound = fmt.Errorf("session not found")
	ErrTooManySessions = fmt.Errorf("too many sessions")
)

const MaxSessions = 10

// Manager manages Claude Code sessions
type Manager struct {
	sessions map[string]*Session
	mu       sync.RWMutex
	storage  *Storage
}

// NewManager creates a new session manager
func NewManager() (*Manager, error) {
	storage, err := NewStorage()
	if err != nil {
		return nil, fmt.Errorf("failed to create storage: %w", err)
	}

	m := &Manager{
		sessions: make(map[string]*Session),
		storage:  storage,
	}

	// Load existing sessions from storage
	if err := m.loadSessions(); err != nil {
		log.Warn().Err(err).Msg("failed to load sessions from storage")
	}

	// Start background cleanup worker
	go m.cleanupWorker()

	return m, nil
}

// CreateSession spawns a new Claude Code process
func (m *Manager) CreateSession(workingDir, title string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check session limit
	if len(m.sessions) >= MaxSessions {
		return nil, ErrTooManySessions
	}

	sessionID := uuid.New().String()

	// Default working directory
	if workingDir == "" {
		workingDir = config.Get().DataDir
	}

	// Default title
	if title == "" {
		title = fmt.Sprintf("Session %d", len(m.sessions)+1)
	}

	session := &Session{
		ID:           sessionID,
		WorkingDir:   workingDir,
		Title:        title,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
		Status:       "active",
	}

	// Create temp HOME directory with symlink to shared .claude
	tempHome := filepath.Join(os.TempDir(), "mylifedb-claude", sessionID)
	if err := os.MkdirAll(tempHome, 0755); err != nil {
		return nil, fmt.Errorf("failed to create temp home: %w", err)
	}

	// Ensure shared .claude directory exists
	claudeDir := filepath.Join(config.Get().DataDir, "app", "my-life-db", ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create claude dir: %w", err)
	}

	// Create symlink: tempHome/.claude -> MY_DATA_DIR/app/my-life-db/.claude
	tempClaudeLink := filepath.Join(tempHome, ".claude")

	// Remove existing symlink if any
	os.Remove(tempClaudeLink)

	if err := os.Symlink(claudeDir, tempClaudeLink); err != nil {
		return nil, fmt.Errorf("failed to create claude symlink: %w", err)
	}

	// Spawn claude process with PTY
	cmd := exec.Command("claude")
	cmd.Dir = workingDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("HOME=%s", tempHome), // Point to temp HOME with .claude symlink
	)

	ptmx, err := pty.Start(cmd)
	if err != nil {
		os.RemoveAll(tempHome) // Cleanup on error
		return nil, fmt.Errorf("failed to start claude: %w", err)
	}

	session.PTY = ptmx
	session.Cmd = cmd
	session.ProcessID = cmd.Process.Pid
	session.TempHome = tempHome

	m.sessions[session.ID] = session

	// Save to storage
	if err := m.storage.SaveSession(session); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to save session")
	}

	log.Info().
		Str("sessionId", sessionID).
		Int("pid", session.ProcessID).
		Str("workingDir", workingDir).
		Msg("created claude session")

	return session, nil
}

// GetSession retrieves a session by ID
func (m *Manager) GetSession(id string) (*Session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	session, ok := m.sessions[id]
	if !ok {
		return nil, ErrSessionNotFound
	}
	return session, nil
}

// ListSessions returns all sessions
func (m *Manager) ListSessions() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	return sessions
}

// UpdateSession updates session metadata
func (m *Manager) UpdateSession(id string, title string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[id]
	if !ok {
		return ErrSessionNotFound
	}

	if title != "" {
		session.Title = title
	}

	if err := m.storage.SaveSession(session); err != nil {
		return fmt.Errorf("failed to save session: %w", err)
	}

	return nil
}

// DeleteSession kills a session and cleans up resources
func (m *Manager) DeleteSession(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[id]
	if !ok {
		return ErrSessionNotFound
	}

	// Kill the process
	if session.Cmd != nil && session.Cmd.Process != nil {
		if err := session.Cmd.Process.Kill(); err != nil {
			log.Warn().Err(err).Msg("failed to kill process")
		}
	}

	// Close PTY
	if session.PTY != nil {
		session.PTY.Close()
	}

	// Clean up temp HOME directory
	if session.TempHome != "" {
		if err := os.RemoveAll(session.TempHome); err != nil {
			log.Warn().Err(err).Str("tempHome", session.TempHome).Msg("failed to remove temp home")
		}
	}

	delete(m.sessions, id)

	// Remove from storage
	if err := m.storage.DeleteSession(id); err != nil {
		log.Error().Err(err).Msg("failed to delete session from storage")
	}

	log.Info().Str("sessionId", id).Msg("deleted claude session")

	return nil
}

// loadSessions loads sessions from storage on startup
func (m *Manager) loadSessions() error {
	// Note: For now, we don't restore PTY connections on startup
	// Sessions are ephemeral - when the backend restarts, all sessions are lost
	// In the future, we could implement session restoration
	return nil
}

// cleanupWorker periodically cleans up dead sessions
func (m *Manager) cleanupWorker() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		m.mu.Lock()
		for id, session := range m.sessions {
			// Check if process is dead
			if session.Cmd != nil && session.Cmd.ProcessState != nil && session.Cmd.ProcessState.Exited() {
				log.Info().Str("sessionId", id).Msg("cleaning up dead session")

				// Close PTY
				if session.PTY != nil {
					session.PTY.Close()
				}

				// Clean up temp HOME
				if session.TempHome != "" {
					os.RemoveAll(session.TempHome)
				}

				delete(m.sessions, id)
				m.storage.DeleteSession(id)
			}
		}
		m.mu.Unlock()
	}
}
