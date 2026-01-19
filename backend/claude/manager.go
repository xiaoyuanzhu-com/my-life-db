package claude

import (
	"context"
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

	// Context for graceful shutdown
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewManager creates a new session manager
func NewManager() (*Manager, error) {
	ctx, cancel := context.WithCancel(context.Background())

	m := &Manager{
		sessions: make(map[string]*Session),
		ctx:      ctx,
		cancel:   cancel,
	}

	// Start background cleanup worker
	m.wg.Add(1)
	go m.cleanupWorker()

	return m, nil
}

// Shutdown gracefully stops all sessions and goroutines
func (m *Manager) Shutdown(ctx context.Context) error {
	log.Info().Msg("shutting down Claude manager")

	// Signal all goroutines to stop
	m.cancel()

	// Kill all sessions
	m.mu.Lock()
	for id, session := range m.sessions {
		log.Info().Str("sessionId", id).Msg("killing session during shutdown")
		if session.Cmd != nil && session.Cmd.Process != nil {
			session.Cmd.Process.Kill()
		}
		if session.PTY != nil {
			session.PTY.Close()
		}
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	// Wait for goroutines with timeout
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Info().Msg("Claude manager shutdown complete")
		return nil
	case <-ctx.Done():
		log.Warn().Msg("Claude manager shutdown timed out")
		return ctx.Err()
	}
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
		workingDir = config.Get().UserDataDir
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
		log.Error().Err(err).Str("workingDir", workingDir).Msg("failed to start claude process")
		return nil, fmt.Errorf("failed to start claude: %w", err)
	}

	session.PTY = ptmx
	session.Cmd = cmd
	session.ProcessID = cmd.Process.Pid

	// Start PTY reader that broadcasts to all clients
	m.wg.Add(1)
	go m.readPTY(session)

	// Monitor process state in background
	m.wg.Add(1)
	go m.monitorProcess(session)

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
	defer m.wg.Done()

	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-m.ctx.Done():
			log.Debug().Msg("cleanup worker stopping")
			return
		case <-ticker.C:
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
}

// monitorProcess monitors the claude process and logs when it exits
func (m *Manager) monitorProcess(session *Session) {
	defer m.wg.Done()

	if session.Cmd == nil {
		return
	}

	// Wait for process to exit
	err := session.Cmd.Wait()

	// Check if we're shutting down - if so, don't log as error
	select {
	case <-m.ctx.Done():
		log.Debug().Str("sessionId", session.ID).Msg("process monitor stopping (shutdown)")
		return
	default:
	}

	session.mu.Lock()
	session.Status = "dead"
	session.mu.Unlock()

	if err != nil {
		log.Warn().
			Err(err).
			Str("sessionId", session.ID).
			Int("pid", session.ProcessID).
			Msg("claude process exited with error")
	} else {
		log.Info().
			Str("sessionId", session.ID).
			Int("pid", session.ProcessID).
			Msg("claude process exited normally")
	}

	// Notify all connected clients that the session ended
	session.Broadcast([]byte("\r\n\x1b[33mSession process has ended\x1b[0m\r\n"))
}

// readPTY reads from PTY and broadcasts to all connected clients
func (m *Manager) readPTY(session *Session) {
	defer m.wg.Done()

	buf := make([]byte, 4096)
	for {
		// Check for shutdown
		select {
		case <-m.ctx.Done():
			log.Debug().Str("sessionId", session.ID).Msg("PTY reader stopping (shutdown)")
			return
		default:
		}

		n, err := session.PTY.Read(buf)
		if err != nil {
			// PTY closed or process died - silent, process monitor will log exit
			session.mu.Lock()
			session.Status = "dead"
			session.mu.Unlock()
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
