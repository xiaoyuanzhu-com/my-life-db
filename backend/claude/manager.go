package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sync"
	"syscall"
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

// Permission configuration for Claude CLI
// These control which tools are auto-approved vs blocked
var (
	// Tools that are always allowed without prompting (read-only, safe operations)
	allowedTools = []string{
		"Read",
		"Glob",
		"Grep",
		"WebFetch",
		"WebSearch",
		"TodoWrite",
		"Task",
	}

	// Tools/commands that are never allowed (dangerous operations)
	disallowedTools = []string{
		"Bash(rm -rf:*)",
		"Bash(sudo:*)",
	}
)

// buildClaudeArgs constructs the command-line arguments for launching Claude
// with appropriate permission settings for web UI usage
// gracefulTerminate attempts to gracefully terminate a process by sending SIGTERM first,
// waiting for a short period, then forcefully killing with SIGKILL if it doesn't exit.
// This allows the process (Claude) to finish writing any pending data (like JSONL files).
func gracefulTerminate(cmd *exec.Cmd, timeout time.Duration) {
	if cmd == nil || cmd.Process == nil {
		return
	}

	// Send SIGTERM for graceful shutdown
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		// Process might already be dead, try Kill anyway
		cmd.Process.Kill()
		return
	}

	// Wait for process to exit gracefully
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		close(done)
	}()

	select {
	case <-done:
		// Process exited gracefully
		return
	case <-time.After(timeout):
		// Timeout, force kill
		log.Warn().Int("pid", cmd.Process.Pid).Msg("process didn't exit gracefully, sending SIGKILL")
		cmd.Process.Kill()
	}
}

func buildClaudeArgs(sessionID string, resume bool, mode SessionMode) []string {
	var args []string

	if mode == ModeUI {
		// UI mode: JSON streaming with interactive permission handling
		args = []string{
			"--output-format", "stream-json",
			"--input-format", "stream-json",
			"--permission-mode", "default", // Enable control_request for permission handling
			"--verbose",
		}

		// Add allowed tools (auto-approved without prompting)
		for _, tool := range allowedTools {
			args = append(args, "--allowedTools", tool)
		}
	} else {
		// CLI mode: PTY with skipped permissions (legacy behavior)
		args = []string{
			"--dangerously-skip-permissions", // Skip interactive permission prompts
		}

		// Add allowed tools
		for _, tool := range allowedTools {
			args = append(args, "--allowedTools", tool)
		}

		// Add disallowed tools
		for _, tool := range disallowedTools {
			args = append(args, "--disallowedTools", tool)
		}
	}

	// Add session flag
	if resume {
		args = append(args, "--resume", sessionID)
	} else {
		args = append(args, "--session-id", sessionID)
	}

	return args
}

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

	// Gracefully terminate all sessions
	m.mu.Lock()
	var wg sync.WaitGroup
	for id, session := range m.sessions {
		log.Info().Str("sessionId", id).Msg("gracefully terminating session during shutdown")
		wg.Add(1)
		go func(id string, s *Session) {
			defer wg.Done()
			// Close stdin/PTY first to signal EOF
			if s.Mode == ModeUI && s.Stdin != nil {
				s.Stdin.Close()
			} else if s.PTY != nil {
				s.PTY.Close()
			}
			// Gracefully terminate with 3 second timeout per session
			gracefulTerminate(s.Cmd, 3*time.Second)
		}(id, session)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	// Wait for all terminations
	wg.Wait()

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
func (m *Manager) CreateSession(workingDir, title string, mode SessionMode) (*Session, error) {
	return m.CreateSessionWithID(workingDir, title, "", mode)
}

// CreateSessionWithID spawns a new Claude Code process with an optional session ID to resume
func (m *Manager) CreateSessionWithID(workingDir, title, resumeSessionID string, mode SessionMode) (*Session, error) {
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

	// Default mode to UI if not specified
	if mode == "" {
		mode = ModeUI
	}

	session := &Session{
		ID:           sessionID,
		WorkingDir:   workingDir,
		Title:        title,
		Mode:         mode,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
		Status:       "active",
		Clients:      make(map[*Client]bool),
		broadcast:    make(chan []byte, 256),
		activated:    true, // Sessions created via CreateSessionWithID are immediately activated
	}

	// Build args based on mode
	args := buildClaudeArgs(sessionID, resumeSessionID != "", mode)
	cmd := exec.Command("claude", args...)
	cmd.Dir = workingDir

	if mode == ModeUI {
		// UI mode: use stdin/stdout pipes for JSON streaming
		stdin, err := cmd.StdinPipe()
		if err != nil {
			log.Error().Err(err).Str("workingDir", workingDir).Msg("failed to create stdin pipe")
			return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			log.Error().Err(err).Str("workingDir", workingDir).Msg("failed to create stdout pipe")
			return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			log.Error().Err(err).Str("workingDir", workingDir).Msg("failed to create stderr pipe")
			return nil, fmt.Errorf("failed to create stderr pipe: %w", err)
		}

		if err := cmd.Start(); err != nil {
			log.Error().Err(err).Str("workingDir", workingDir).Msg("failed to start claude process")
			return nil, fmt.Errorf("failed to start claude: %w", err)
		}

		session.Stdin = stdin
		session.Stdout = stdout
		session.Stderr = stderr
		session.Cmd = cmd
		session.ProcessID = cmd.Process.Pid
		session.pendingRequests = make(map[string]chan map[string]interface{})

		// Start JSON reader that broadcasts to all clients
		m.wg.Add(1)
		go m.readJSON(session)

		// Start stderr reader for debugging
		m.wg.Add(1)
		go m.readStderr(session)
	} else {
		// CLI mode: use PTY for raw terminal I/O
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
	}

	// Monitor process state in background
	m.wg.Add(1)
	go m.monitorProcess(session)

	m.sessions[session.ID] = session

	log.Info().
		Str("sessionId", sessionID).
		Int("pid", session.ProcessID).
		Str("workingDir", workingDir).
		Str("mode", string(mode)).
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
		return session, nil
	}

	// Session not in pool - try to find it in history and create shell session

	// Find session info from all Claude project indexes
	index, err := GetAllSessionIndexes()
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

	// Create a non-activated shell session (default to UI mode for historical sessions)
	return m.createShellSession(id, workingDir, title, ModeUI)
}

// createShellSession creates a non-activated session (just metadata, no process)
func (m *Manager) createShellSession(id, workingDir, title string, mode SessionMode) (*Session, error) {
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

	// Default mode to UI if not specified
	if mode == "" {
		mode = ModeUI
	}

	session := &Session{
		ID:           id,
		WorkingDir:   workingDir,
		Title:        title,
		Mode:         mode,
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

	log.Debug().Str("sessionId", id).Str("mode", string(mode)).Msg("created shell session (not activated)")

	return session, nil
}

// activateSession spawns the actual Claude process for a shell session
func (m *Manager) activateSession(session *Session) error {
	// Build args based on mode (always resume for activation)
	args := buildClaudeArgs(session.ID, true, session.Mode)
	cmd := exec.Command("claude", args...)
	cmd.Dir = session.WorkingDir

	session.ready = make(chan struct{}) // Will be closed when ready

	if session.Mode == ModeUI {
		// UI mode: use stdin/stdout pipes for JSON streaming
		stdin, err := cmd.StdinPipe()
		if err != nil {
			log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to create stdin pipe")
			return fmt.Errorf("failed to create stdin pipe: %w", err)
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to create stdout pipe")
			return fmt.Errorf("failed to create stdout pipe: %w", err)
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to create stderr pipe")
			return fmt.Errorf("failed to create stderr pipe: %w", err)
		}

		if err := cmd.Start(); err != nil {
			log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to start claude process")
			return fmt.Errorf("failed to start claude: %w", err)
		}

		session.Stdin = stdin
		session.Stdout = stdout
		session.Stderr = stderr
		session.Cmd = cmd
		session.ProcessID = cmd.Process.Pid
		session.Status = "active"
		session.pendingRequests = make(map[string]chan map[string]interface{})

		// Start JSON reader that broadcasts to all clients
		m.wg.Add(1)
		go m.readJSON(session)

		// Start stderr reader for debugging
		m.wg.Add(1)
		go m.readStderr(session)

		// UI mode: signal ready after brief delay (Claude waits for input before outputting)
		go func() {
			time.Sleep(100 * time.Millisecond)
			if session.ready != nil {
				close(session.ready)
			}
		}()
	} else {
		// CLI mode: use PTY for raw terminal I/O
		ptmx, err := pty.Start(cmd)
		if err != nil {
			log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to start claude process")
			return fmt.Errorf("failed to start claude: %w", err)
		}

		session.PTY = ptmx
		session.Cmd = cmd
		session.ProcessID = cmd.Process.Pid
		session.Status = "active"

		// Start PTY reader that broadcasts to all clients
		m.wg.Add(1)
		go m.readPTY(session)
	}

	// Monitor process state in background
	m.wg.Add(1)
	go m.monitorProcess(session)

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

	// Close stdin/PTY first to signal EOF to Claude
	if session.Mode == ModeUI {
		if session.Stdin != nil {
			session.Stdin.Close()
		}
	} else {
		if session.PTY != nil {
			session.PTY.Close()
		}
	}

	// Gracefully terminate the process (SIGTERM, wait, then SIGKILL)
	gracefulTerminate(session.Cmd, 3*time.Second)

	// Close remaining resources
	if session.Mode == ModeUI {
		if session.Stdout != nil {
			session.Stdout.Close()
		}
		if session.Stderr != nil {
			session.Stderr.Close()
		}
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

	// Close stdin/PTY first to signal EOF to Claude
	if session.Mode == ModeUI {
		if session.Stdin != nil {
			session.Stdin.Close()
		}
	} else {
		if session.PTY != nil {
			session.PTY.Close()
		}
	}

	// Gracefully terminate the process (SIGTERM, wait, then SIGKILL)
	gracefulTerminate(session.Cmd, 3*time.Second)

	// Close remaining resources
	if session.Mode == ModeUI {
		if session.Stdout != nil {
			session.Stdout.Close()
		}
		if session.Stderr != nil {
			session.Stderr.Close()
		}
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
	firstOutputReceived := false
	var lastOutputMu sync.Mutex

	if session.ready != nil {
		go func() {
			ticker := time.NewTicker(50 * time.Millisecond)
			defer ticker.Stop()

			maxWaitTime := 3 * time.Second // Failsafe: mark ready after 3s even without silence
			startTime := time.Now()

			for {
				select {
				case <-m.ctx.Done():
					return
				case <-ticker.C:
					lastOutputMu.Lock()
					timeSinceLastOutput := time.Since(lastOutputTime)
					hadOutput := firstOutputReceived
					lastOutputMu.Unlock()

					// Failsafe: if we've been waiting too long, just mark as ready
					if time.Since(startTime) >= maxWaitTime {
						readyOnce.Do(func() {
							close(session.ready)
						})
						return
					}

					// If we've seen output and there's been 300ms of silence, signal ready
					if hadOutput && timeSinceLastOutput >= 300*time.Millisecond {
						readyOnce.Do(func() {
							close(session.ready)
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
		firstOutputReceived = true
		lastOutputMu.Unlock()

		// Make a copy of the data to broadcast
		data := make([]byte, n)
		copy(data, buf[:n])

		// Broadcast to all connected clients
		session.Broadcast(data)
		session.LastActivity = time.Now()
	}
}

// readJSON reads JSON lines from stdout and broadcasts to all connected clients (UI mode)
// Claude may output multiple JSON objects concatenated on a single line (especially on resume),
// so we split them before broadcasting.
func (m *Manager) readJSON(session *Session) {
	defer m.wg.Done()

	if session.Stdout == nil {
		log.Error().Str("sessionId", session.ID).Msg("readJSON called but stdout is nil")
		return
	}

	scanner := bufio.NewScanner(session.Stdout)
	// Set a large buffer for potentially large JSON messages (10MB for resumed sessions with history)
	buf := make([]byte, 10*1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	for scanner.Scan() {
		// Check for shutdown
		select {
		case <-m.ctx.Done():
			log.Debug().Str("sessionId", session.ID).Msg("JSON reader stopping (shutdown)")
			return
		default:
		}

		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		// Split concatenated JSON objects (Claude may output multiple on one line)
		jsonObjects := splitConcatenatedJSON(line)

		for _, jsonData := range jsonObjects {
			// Broadcast to all connected clients (and cache for late-joining clients)
			session.BroadcastUIMessage(jsonData)
		}

		session.LastActivity = time.Now()
	}

	if err := scanner.Err(); err != nil {
		log.Debug().Err(err).Str("sessionId", session.ID).Msg("JSON scanner error")
	}

	// Mark session as dead when stdout closes
	session.mu.Lock()
	session.Status = "dead"
	session.mu.Unlock()
}

// splitConcatenatedJSON splits a byte slice containing concatenated JSON objects
// e.g., `{"a":1}{"b":2}` becomes `[{"a":1}, {"b":2}]`
func splitConcatenatedJSON(data []byte) [][]byte {
	if len(data) == 0 {
		return nil
	}

	var result [][]byte
	decoder := json.NewDecoder(bytes.NewReader(data))

	for {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			break
		}
		// Make a copy since raw may be backed by the original slice
		obj := make([]byte, len(raw))
		copy(obj, raw)
		result = append(result, obj)
	}

	return result
}

// readStderr reads stderr output for debugging (UI mode)
func (m *Manager) readStderr(session *Session) {
	defer m.wg.Done()

	if session.Stderr == nil {
		return
	}

	scanner := bufio.NewScanner(session.Stderr)
	for scanner.Scan() {
		// Check for shutdown
		select {
		case <-m.ctx.Done():
			return
		default:
		}

		line := scanner.Text()
		if line != "" {
			log.Debug().
				Str("sessionId", session.ID).
				Str("stderr", line).
				Msg("claude stderr")
		}
	}
}
