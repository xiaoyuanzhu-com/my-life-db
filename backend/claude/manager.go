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
// If resumeSessionID is provided, it will resume from that session's conversation history
func (m *Manager) CreateSession(workingDir, title string) (*Session, error) {
	return m.CreateSessionWithID(workingDir, title, "")
}

// CreateSessionWithID spawns a new Claude Code process with an optional session ID to resume
func (m *Manager) CreateSessionWithID(workingDir, title, resumeSessionID string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check session limit
	if len(m.sessions) >= MaxSessions {
		return nil, ErrTooManySessions
	}

	// If resuming, use the provided session ID; otherwise generate a new one
	var sessionID string
	if resumeSessionID != "" {
		sessionID = resumeSessionID
		log.Info().Str("sessionId", sessionID).Msg("resuming session with existing ID")
	} else {
		sessionID = uuid.New().String()
	}

	// Default working directory
	if workingDir == "" {
		workingDir = config.Get().UserDataDir
	}

	// Default title
	if title == "" {
		if resumeSessionID != "" {
			title = "Resumed Session"
		} else {
			title = fmt.Sprintf("Session %d", len(m.sessions)+1)
		}
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
		activated:    true, // Sessions created via CreateSessionWithID are immediately activated
	}

	// Spawn claude process with PTY
	// Uses default HOME so all sessions share the same .claude directory
	var cmd *exec.Cmd
	if resumeSessionID != "" {
		// Resume existing session using --resume flag
		cmd = exec.Command("claude", "--resume", resumeSessionID)
	} else {
		// Create new session with specific session ID
		cmd = exec.Command("claude", "--session-id", sessionID)
	}
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

// GetSession retrieves a session by ID from the pool
// If session is not in pool but exists in history, creates a non-activated shell session
func (m *Manager) GetSession(id string) (*Session, error) {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if ok {
		// Session already in pool (may or may not be activated)
		log.Info().Str("sessionId", id).Bool("activated", session.IsActivated()).Msg("GetSession: found in pool")
		return session, nil
	}

	// Session not in pool - try to find it in history and create shell session
	log.Info().Str("sessionId", id).Msg("GetSession: not in pool, checking history")

	// Find session info from Claude's index
	index, err := GetSessionIndexForProject(config.Get().UserDataDir)
	var workingDir string
	var title string
	found := false

	if err == nil {
		for _, entry := range index.Entries {
			if entry.SessionID == id {
				workingDir = entry.ProjectPath
				title = entry.FirstPrompt
				found = true
				break
			}
		}
	}

	if !found {
		// Session doesn't exist anywhere
		return nil, ErrSessionNotFound
	}

	// Default values
	if workingDir == "" {
		workingDir = config.Get().UserDataDir
	}
	if title == "" {
		title = "Archived Session"
	}

	// Create a non-activated shell session
	log.Info().Str("sessionId", id).Str("workingDir", workingDir).Msg("GetSession: creating shell session from history")
	return m.createShellSession(id, workingDir, title)
}

// createShellSession creates a non-activated session (just metadata, no process)
func (m *Manager) createShellSession(id, workingDir, title string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if it was added while we were waiting for lock
	if existing, ok := m.sessions[id]; ok {
		return existing, nil
	}

	// Check session limit
	if len(m.sessions) >= MaxSessions {
		return nil, ErrTooManySessions
	}

	session := &Session{
		ID:           id,
		WorkingDir:   workingDir,
		Title:        title,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
		Status:       "archived",
		Clients:      make(map[*Client]bool),
		broadcast:    make(chan []byte, 256),
		activated:    false,
	}

	// Set up activation function
	session.activateFn = func() error {
		return m.activateSession(session)
	}

	m.sessions[id] = session

	log.Debug().Str("sessionId", id).Msg("created shell session (not activated)")

	return session, nil
}

// activateSession spawns the actual Claude process for a shell session
func (m *Manager) activateSession(session *Session) error {
	// Spawn claude process with PTY
	var cmd *exec.Cmd
	cmd = exec.Command("claude", "--resume", session.ID)
	cmd.Dir = session.WorkingDir

	ptmx, err := pty.Start(cmd)
	if err != nil {
		log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to start claude process")
		return fmt.Errorf("failed to start claude: %w", err)
	}

	session.PTY = ptmx
	session.Cmd = cmd
	session.ProcessID = cmd.Process.Pid
	session.Status = "active"
	session.ready = make(chan struct{}) // Will be closed when first output is received

	// Start PTY reader that broadcasts to all clients
	m.wg.Add(1)
	go m.readPTY(session)

	// Monitor process state in background
	m.wg.Add(1)
	go m.monitorProcess(session)

	log.Info().
		Str("sessionId", session.ID).
		Int("pid", session.ProcessID).
		Msg("activated session")

	return nil
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

// DeactivateSession stops a session process but keeps it in the active sessions map
// This allows the session to be archived while preserving its state in the history
func (m *Manager) DeactivateSession(id string) error {
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

	// Remove from active sessions map (will show as archived in ListAllClaudeSessions)
	delete(m.sessions, id)

	log.Info().Str("sessionId", id).Msg("deactivated claude session")

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

	// Remove the dead session from the manager's pool
	m.mu.Lock()
	delete(m.sessions, session.ID)
	m.mu.Unlock()

	log.Info().Str("sessionId", session.ID).Msg("removed dead session from pool")
}

// readPTY reads from PTY and broadcasts to all connected clients
func (m *Manager) readPTY(session *Session) {
	defer m.wg.Done()

	buf := make([]byte, 4096)

	// Goroutine to signal ready after a period of silence (output stopped)
	var readyOnce sync.Once
	lastOutputTime := time.Now()
	var lastOutputMu sync.Mutex

	if session.ready != nil {
		go func() {
			ticker := time.NewTicker(50 * time.Millisecond)
			defer ticker.Stop()

			firstOutput := false
			for {
				select {
				case <-m.ctx.Done():
					return
				case <-ticker.C:
					lastOutputMu.Lock()
					timeSinceLastOutput := time.Since(lastOutputTime)
					hadOutput := firstOutput
					lastOutputMu.Unlock()

					// If we've seen output and there's been 300ms of silence, signal ready
					if hadOutput && timeSinceLastOutput >= 300*time.Millisecond {
						readyOnce.Do(func() {
							close(session.ready)
							log.Info().
								Str("sessionId", session.ID).
								Dur("silence", timeSinceLastOutput).
								Msg("Claude ready (silence detected after output)")
						})
						return
					}
				}
			}
		}()
	}

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

		// Update last output time for silence detection
		lastOutputMu.Lock()
		lastOutputTime = time.Now()
		lastOutputMu.Unlock()

		// Make a copy of the data to broadcast
		data := make([]byte, n)
		copy(data, buf[:n])

		// Broadcast to all connected clients
		session.Broadcast(data)
		session.LastActivity = time.Now()
	}
}
