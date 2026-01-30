package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	ErrSessionNotFound = fmt.Errorf("session not found")
)

// Permission configuration for Claude CLI
// These control which tools are auto-approved vs blocked
// Reference: https://code.claude.com/docs/en/settings#tools-available-to-claude
//
// IMPORTANT: Bash pattern matching limitations
// ============================================
// Claude Code uses glob patterns for bash command matching, but these have significant limitations:
//
// 1. Pipes and shell metacharacters don't match reliably
//    - "Bash(find *)" matches "find /path" but NOT "find /path | wc -l"
//    - The entire command string (including pipes) must match the pattern
//
// 2. Pattern matching is fragile for security
//    - "Bash(curl http://example.com/ *)" won't match "curl -X GET http://example.com/..."
//    - Flag ordering, shell variables, and subshells can bypass restrictions
//
// 3. Industry guidance (from Claude Code docs):
//    "Bash permission patterns that try to constrain command arguments are fragile
//     and should not be relied upon as a security boundary."
//
// Alternative approaches:
//
// Option A: Allow all bash with Bash(*)
//   - Since we already allow Edit/Write, bash restrictions provide little real security
//   - Claude can write a script and execute it anyway
//   - Simpler but loses visibility into what's being run
//
// Option B: Custom callback logic in CreatePermissionCallback()
//   - Don't put Bash patterns in allowedTools
//   - Implement isDangerousBashCommand(cmd) to check for rm, sudo, etc.
//   - Auto-allow safe commands, prompt only for dangerous ones
//   - More control but adds custom code complexity
//
// Option C: Sandboxing (recommended for high-security)
//   - Use DevContainers or Claude's sandbox mode
//   - True isolation regardless of what commands run
//   - See: https://code.claude.com/docs/en/settings (sandbox section)
//
// Current approach: Enumerate common safe patterns, accept that complex commands
// (pipes, etc.) will prompt for permission. This provides visibility into operations
// without false security guarantees.
//
// References:
// - https://code.claude.com/docs/en/settings
// - https://www.joinformal.com/blog/allowlisting-some-bash-commands-is-often-the-same-as-allowlisting-all-with-claude-code/
var (
	// Tools that are always allowed without prompting
	allowedTools = []string{
		// === No permission required by default ===
		"AskUserQuestion", // Asks multiple-choice questions
		"Glob",            // Finds files based on pattern matching
		"Grep",            // Searches for patterns in file contents
		"KillShell",       // Kills a running background bash shell
		"LSP",             // Code intelligence via language servers
		"MCPSearch",       // Searches for and loads MCP tools
		"Read",            // Reads the contents of files
		"Task",            // Runs a sub-agent for multi-step tasks
		"TaskCreate",      // Creates a new task in the task list
		"TaskGet",         // Retrieves full details for a specific task
		"TaskList",        // Lists all tasks with their current status
		"TaskOutput",      // Retrieves output from a background task
		"TaskUpdate",      // Updates task status/dependencies/details
		"TodoWrite",       // Tracks progress with todo list

		// === Permission required by default, we allow ===
		"Edit",         // Makes targeted edits to specific files
		"NotebookEdit", // Modifies Jupyter notebook cells
		"Skill",        // Executes a skill within the conversation
		"WebFetch",     // Fetches content from a specified URL
		"WebSearch",    // Performs web searches
		"Write",        // Creates or overwrites files

		// === Bash commands (selective patterns) ===
		// NOTE: These patterns only match simple commands without pipes or complex shell syntax.
		// Commands like "find /path | wc -l" will still prompt for permission.
		// See the comment block above for why this is a known limitation.
		"Bash(ls *)",
		"Bash(cat *)",
		"Bash(head *)",
		"Bash(tail *)",
		"Bash(wc *)",
		"Bash(find *)",
		"Bash(tree *)",
		"Bash(pwd)",
		"Bash(which *)",
		"Bash(echo *)",
		"Bash(sed *)",
		// Git commands (read-only)
		"Bash(git status*)",
		"Bash(git diff*)",
		"Bash(git log*)",
		"Bash(git show*)",
		"Bash(git branch*)",
	}

	// Tools/commands that are never allowed (dangerous operations)
	// NOTE: These use the deprecated ":*" syntax (equivalent to " *").
	// However, like allowedTools, these patterns have the same limitations -
	// they won't match if flags are reordered or pipes are used.
	// Deny rules take precedence over allow rules.
	disallowedTools = []string{
		"Bash(rm -rf *)",
		"Bash(sudo *)",
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

	// Session index cache (lazy-loaded, in-memory)
	indexCache *SessionIndexCache

	// Context for graceful shutdown
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// Live process tracking
	liveProcessCount int32         // atomic counter of running Claude CLI processes
	processExited    chan struct{} // signaled when any process exits
}

// NewManager creates a new session manager
func NewManager() (*Manager, error) {
	ctx, cancel := context.WithCancel(context.Background())

	m := &Manager{
		sessions:      make(map[string]*Session),
		indexCache:    NewSessionIndexCache(),
		ctx:           ctx,
		cancel:        cancel,
		processExited: make(chan struct{}, 100), // buffered to avoid blocking
	}

	// Start background cleanup worker
	m.wg.Add(1)
	go m.cleanupWorker()

	return m, nil
}

// trackProcessStart increments the live process counter
func (m *Manager) trackProcessStart() {
	atomic.AddInt32(&m.liveProcessCount, 1)
	log.Debug().Int32("count", atomic.LoadInt32(&m.liveProcessCount)).Msg("process started, live count increased")
}

// trackProcessExit decrements the live process counter and signals
func (m *Manager) trackProcessExit() {
	count := atomic.AddInt32(&m.liveProcessCount, -1)
	log.Debug().Int32("count", count).Msg("process exited, live count decreased")
	// Non-blocking send to signal a process exited
	select {
	case m.processExited <- struct{}{}:
	default:
	}
}

// LiveProcessCount returns the current number of live Claude CLI processes
func (m *Manager) LiveProcessCount() int32 {
	return atomic.LoadInt32(&m.liveProcessCount)
}

// Shutdown gracefully stops all sessions and goroutines
func (m *Manager) Shutdown(ctx context.Context) error {
	log.Info().Msg("shutting down Claude manager")

	// Shutdown the index cache
	if m.indexCache != nil {
		m.indexCache.Shutdown(ctx)
	}

	// Signal all goroutines to stop
	m.cancel()

	// Wait for live processes to exit naturally (they likely received SIGINT from process group)
	// This should be nearly instant since processes die from SIGINT before we get here
	liveCount := atomic.LoadInt32(&m.liveProcessCount)
	if liveCount > 0 {
		log.Info().Int32("liveProcesses", liveCount).Msg("waiting for Claude processes to exit")

		// Wait for all processes to exit with a short timeout
		// Processes should exit quickly since they got SIGINT from the process group
		waitCtx, waitCancel := context.WithTimeout(ctx, 2*time.Second)
		defer waitCancel()

	waitLoop:
		for atomic.LoadInt32(&m.liveProcessCount) > 0 {
			select {
			case <-m.processExited:
				// A process exited, check if all done
				continue
			case <-waitCtx.Done():
				// Timeout - force kill remaining processes
				remaining := atomic.LoadInt32(&m.liveProcessCount)
				if remaining > 0 {
					log.Warn().Int32("remaining", remaining).Msg("timeout waiting for processes, force killing")
					m.forceKillAllSessions()
				}
				break waitLoop
			}
		}
	}

	log.Debug().Msg("all Claude processes exited")

	// Clean up session map
	m.mu.Lock()
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	// Wait for internal goroutines with timeout
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

// forceKillAllSessions forcefully kills all remaining session processes
func (m *Manager) forceKillAllSessions() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for id, session := range m.sessions {
		log.Warn().Str("sessionId", id).Msg("force killing session")

		// SDK mode
		if session.sdkClient != nil {
			if session.sdkCancel != nil {
				session.sdkCancel()
			}
			session.sdkClient.Close()
			continue
		}

		// Legacy mode
		if session.Cmd != nil && session.Cmd.Process != nil {
			session.Cmd.Process.Kill()
		}
	}
}

// CreateSession spawns a new Claude Code process
// If resumeSessionID is provided, it will resume from that session's conversation history
func (m *Manager) CreateSession(workingDir, title string, mode SessionMode) (*Session, error) {
	return m.CreateSessionWithID(workingDir, title, "", mode)
}

// CreateSessionWithID spawns a new Claude Code process with an optional session ID to resume
func (m *Manager) CreateSessionWithID(workingDir, title, resumeSessionID string, mode SessionMode) (*Session, error) {
	// Quick operations under lock: generate ID, create session object
	m.mu.Lock()

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

	// Add to map early so other operations can see it (status will be "active")
	m.sessions[session.ID] = session
	m.mu.Unlock()

	// Now perform blocking operations WITHOUT holding the lock
	if mode == ModeUI {
		// UI mode: use SDK client for subprocess management
		if err := m.createSessionWithSDK(session, resumeSessionID != ""); err != nil {
			// Remove session from map on failure
			m.mu.Lock()
			delete(m.sessions, session.ID)
			m.mu.Unlock()
			log.Error().Err(err).Str("workingDir", workingDir).Msg("failed to create SDK session")
			return nil, fmt.Errorf("failed to create SDK session: %w", err)
		}
	} else {
		// CLI mode: use PTY for raw terminal I/O (legacy path)
		args := buildClaudeArgs(sessionID, resumeSessionID != "", mode)
		cmd := exec.Command("claude", args...)
		cmd.Dir = workingDir

		ptmx, err := pty.Start(cmd)
		if err != nil {
			// Remove session from map on failure
			m.mu.Lock()
			delete(m.sessions, session.ID)
			m.mu.Unlock()
			log.Error().Err(err).Str("workingDir", workingDir).Msg("failed to start claude process")
			return nil, fmt.Errorf("failed to start claude: %w", err)
		}

		session.PTY = ptmx
		session.Cmd = cmd
		session.ProcessID = cmd.Process.Pid

		// Track live process
		m.trackProcessStart()

		// Start PTY reader that broadcasts to all clients
		m.wg.Add(1)
		go m.readPTY(session)

		// Monitor process state in background (only for CLI mode, SDK handles its own monitoring)
		m.wg.Add(1)
		go m.monitorProcess(session)
	}

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

	// If not found in index, search for JSONL file directly
	// (session might exist but not be in index yet - Claude updates index asynchronously)
	if !found {
		workingDir, found = findSessionByJSONL(id)
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
// Shell sessions are lightweight - just metadata for viewing historical sessions.
func (m *Manager) createShellSession(id, workingDir, title string, mode SessionMode) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if it was added while we were waiting for lock
	if existing, ok := m.sessions[id]; ok {
		return existing, nil
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
	session.ready = make(chan struct{}) // Will be closed when ready

	if session.Mode == ModeUI {
		// UI mode: use SDK client for subprocess management (always resume for activation)
		if err := m.createSessionWithSDK(session, true); err != nil {
			log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to activate SDK session")
			return fmt.Errorf("failed to activate SDK session: %w", err)
		}

		// Signal ready after brief delay (SDK handles initialization internally)
		go func() {
			time.Sleep(100 * time.Millisecond)
			if session.ready != nil {
				close(session.ready)
			}
		}()
	} else {
		// CLI mode: use PTY for raw terminal I/O (legacy path)
		args := buildClaudeArgs(session.ID, true, session.Mode)
		cmd := exec.Command("claude", args...)
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

		// Track live process
		m.trackProcessStart()

		// Start PTY reader that broadcasts to all clients
		m.wg.Add(1)
		go m.readPTY(session)

		// Monitor process state in background (only for CLI mode, SDK handles its own monitoring)
		m.wg.Add(1)
		go m.monitorProcess(session)
	}

	return nil
}

// ListSessions returns all active sessions in the manager's pool
func (m *Manager) ListSessions() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	return sessions
}

// GetIndexCache returns the session index cache
func (m *Manager) GetIndexCache() *SessionIndexCache {
	return m.indexCache
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

	// SDK mode cleanup
	if session.sdkClient != nil {
		if session.sdkCancel != nil {
			session.sdkCancel()
		}
		session.sdkClient.Close()
		delete(m.sessions, id)
		log.Info().Str("sessionId", id).Msg("deleted SDK claude session")
		return nil
	}

	// Legacy mode cleanup: Close stdin/PTY first to signal EOF to Claude
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

	// SDK mode cleanup
	if session.sdkClient != nil {
		if session.sdkCancel != nil {
			session.sdkCancel()
		}
		session.sdkClient.Close()
		delete(m.sessions, id)
		log.Info().Str("sessionId", id).Msg("deactivated SDK claude session")
		return nil
	}

	// Legacy mode cleanup: Close stdin/PTY first to signal EOF to Claude
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

	// Track process exit (only after confirming we have a valid process)
	defer m.trackProcessExit()

	// Wait for process to exit
	err := session.Cmd.Wait()

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

		log.Debug().
			Str("sessionId", session.ID).
			Str("stdout", string(line)).
			Msg("claude stdout raw")

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

// createSessionWithSDK creates a UI mode session using the SDK client.
// The SDK handles subprocess lifecycle, message parsing, and control protocol.
// We bridge it to the existing WebSocket infrastructure via message forwarding.
func (m *Manager) createSessionWithSDK(session *Session, resume bool) error {
	ctx, cancel := context.WithCancel(m.ctx)
	session.sdkCtx = ctx
	session.sdkCancel = cancel

	// Initialize pendingSDKPermissions map before creating the callback
	session.pendingSDKPermissions = make(map[string]*pendingPermission)

	// Build SDK options with CanUseTool callback for permission handling
	// When CanUseTool is set, the SDK automatically enables --permission-prompt-tool stdio
	// which makes the CLI send control_request messages for tool permissions instead of
	// prompting interactively. The callback bridges to WebSocket clients for approval.
	options := sdk.ClaudeAgentOptions{
		Cwd:                session.WorkingDir,
		AllowedTools:       allowedTools,
		PermissionMode:     sdk.PermissionModeDefault,
		CanUseTool:         session.CreatePermissionCallback(),
		SkipInitialization: true, // Standalone CLI doesn't support initialize control request
	}

	// Session management: resume or new session
	if resume {
		options.Resume = session.ID
	} else {
		// For new sessions, pass session ID via ExtraArgs
		sessionIDValue := session.ID
		options.ExtraArgs = map[string]*string{
			"session-id": &sessionIDValue,
		}
	}

	// Create and connect SDK client
	client := sdk.NewClaudeSDKClient(options)
	if err := client.Connect(ctx, ""); err != nil {
		cancel()
		return fmt.Errorf("failed to connect SDK client: %w", err)
	}

	session.sdkClient = client
	session.Status = "active"

	// Track live process
	m.trackProcessStart()

	// Start message forwarding goroutine
	m.wg.Add(1)
	go m.forwardSDKMessages(session)

	log.Info().
		Str("sessionId", session.ID).
		Bool("resume", resume).
		Msg("created SDK-based session")

	return nil
}

// forwardSDKMessages forwards raw JSON messages from SDK to WebSocket clients.
// This runs as a goroutine for the lifetime of the SDK session.
// IMPORTANT: trackProcessExit() is only called when rawMsgs channel closes (actual process exit),
// NOT when ctx is cancelled. This ensures accurate process lifecycle tracking.
func (m *Manager) forwardSDKMessages(session *Session) {
	defer m.wg.Done()

	msgs := session.sdkClient.RawMessages()

	// Normal operation loop - forward messages until shutdown signal
	for {
		select {
		case <-m.ctx.Done():
			// Manager shutting down - wait for process to actually exit
			goto waitForProcessExit

		case <-session.sdkCtx.Done():
			// Session cancelled - wait for process to actually exit
			goto waitForProcessExit

		case msg, ok := <-msgs:
			if !ok {
				// Channel closed = subprocess actually exited
				goto processExited
			}

			// Re-marshal to JSON for WebSocket broadcast
			data, err := json.Marshal(msg)
			if err != nil {
				log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to marshal message for broadcast")
				continue
			}

			// Broadcast to WebSocket clients
			session.BroadcastUIMessage(data)
			session.LastActivity = time.Now()

			log.Debug().
				Str("sessionId", session.ID).
				Int("bytes", len(data)).
				Msg("forwarded SDK message to WebSocket clients")
		}
	}

waitForProcessExit:
	// Shutdown requested - wait for subprocess to actually exit (msgs to close)
	// The subprocess will receive SIGINT from the process group and should exit quickly
	log.Debug().Str("sessionId", session.ID).Msg("SDK message forwarder waiting for process exit")
	for msg := range msgs {
		// Drain remaining messages
		data, err := json.Marshal(msg)
		if err != nil {
			continue
		}
		session.BroadcastUIMessage(data)
	}

processExited:
	// Subprocess actually exited - track it
	m.trackProcessExit()

	log.Info().Str("sessionId", session.ID).Msg("SDK process exited")

	session.mu.Lock()
	session.Status = "dead"
	session.mu.Unlock()

	// Remove from pool
	m.mu.Lock()
	delete(m.sessions, session.ID)
	m.mu.Unlock()

	log.Info().Str("sessionId", session.ID).Msg("removed dead SDK session from pool")
}
