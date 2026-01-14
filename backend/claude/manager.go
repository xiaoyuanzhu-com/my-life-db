package claude

import (
	"fmt"
	"os/exec"
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

// Manager manages Claude Code sessions in memory
type Manager struct {
	sessions map[string]*Session
	mu       sync.RWMutex
}

// NewManager creates a new session manager
func NewManager() (*Manager, error) {
	m := &Manager{
		sessions: make(map[string]*Session),
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
		Clients:      make(map[*Client]bool),
		broadcast:    make(chan []byte, 256),
	}

	// Spawn claude process with PTY
	// Uses default HOME so all sessions share the same .claude directory
	cmd := exec.Command("claude")
	cmd.Dir = workingDir
	// No custom environment needed - just inherit everything from os.Environ()

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("failed to start claude: %w", err)
	}

	session.PTY = ptmx
	session.Cmd = cmd
	session.ProcessID = cmd.Process.Pid

	// Start PTY reader that broadcasts to all clients
	go m.readPTY(session)

	m.sessions[session.ID] = session

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

	delete(m.sessions, id)

	log.Info().Str("sessionId", id).Msg("deleted claude session")

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

				delete(m.sessions, id)
			}
		}
		m.mu.Unlock()
	}
}

// readPTY reads from PTY and broadcasts to all connected clients
func (m *Manager) readPTY(session *Session) {
	buf := make([]byte, 4096)
	for {
		n, err := session.PTY.Read(buf)
		if err != nil {
			// PTY closed or process died
			session.Status = "dead"
			log.Info().Str("sessionId", session.ID).Msg("PTY closed")
			return
		}

		// Make a copy of the data to broadcast
		data := make([]byte, n)
		copy(data, buf[:n])

		// Broadcast to all connected clients
		session.Broadcast(data)
		session.LastActivity = time.Now()
	}
}
