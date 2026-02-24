package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/claude/models"
	"github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SessionEventType represents the type of session event
type SessionEventType string

const (
	SessionEventCreated     SessionEventType = "created"
	SessionEventUpdated     SessionEventType = "updated"
	SessionEventActivated   SessionEventType = "activated"
	SessionEventDeactivated SessionEventType = "deactivated"
	SessionEventDeleted     SessionEventType = "deleted"
)

// defaultSystemPrompt is the system prompt sent to every new Claude session.
// This is an internal implementation detail shipped with the app — users customize
// Claude's behavior through CLAUDE.md files instead.
const defaultSystemPrompt = `When the user asks for a chart, diagram, or visualization, return it as a fenced code block. The frontend auto-renders these — do not describe the output unless asked.

Two formats are supported:
- Mermaid code blocks for flowcharts, sequence diagrams, Gantt charts, ER diagrams, etc.
- HTML code blocks for anything richer or interactive (data-driven charts, styled layouts, computed tables). These render in a sandboxed iframe with scripts enabled.

Prefer mermaid when it can express the visualization. Use HTML when it cannot.

HTML output must be mobile-friendly and responsive — use relative units, flexbox/grid, and ensure readability on small screens.`

// SessionEvent represents a change in session state
type SessionEvent struct {
	Type      SessionEventType `json:"type"`
	SessionID string           `json:"sessionId"`
}

// SessionEventCallback is called when session state changes
type SessionEventCallback func(event SessionEvent)

// SessionEntry represents unified session data combining file metadata and runtime state
type SessionEntry struct {
	// Identity
	SessionID   string `json:"id"`
	FullPath    string `json:"fullPath,omitempty"` // Path to JSONL file
	ProjectPath string `json:"projectPath"`        // Working directory

	// Metadata (from filesystem)
	DisplayTitle         string    `json:"displayTitle"`
	FirstPrompt          string    `json:"firstPrompt,omitempty"`
	FirstUserMessageUUID string    `json:"firstUserMessageUuid,omitempty"`
	Summary              string    `json:"summary,omitempty"`
	CustomTitle          string    `json:"customTitle,omitempty"`
	MessageCount         int       `json:"messageCount"`
	// ResultCount from JSONL cache — STALE for active sessions due to fsnotify delay.
	// For active sessions, GetAllSessionEntries() overwrites this with Session.ResultCount()
	// which is the source of truth. Do not read this field directly for active sessions.
	ResultCount int `json:"-"`
	Created              time.Time `json:"created"`
	Modified             time.Time `json:"modified"`
	LastUserActivity     time.Time `json:"lastUserActivity"`
	GitBranch            string    `json:"gitBranch,omitempty"`
	IsSidechain          bool      `json:"isSidechain"`

	// Runtime state (internal, not exposed to API)
	IsActivated          bool               `json:"-"`
	IsProcessing         bool               `json:"-"` // Claude is actively generating (mid-turn)
	HasPendingPermission bool               `json:"-"` // Waiting for user permission input
	HasUnseenPermission  bool               `json:"-"` // Pending permissions the user hasn't seen yet
	ProcessID            int                `json:"-"`
	ClientCount          int                `json:"-"`
	PermissionMode       sdk.PermissionMode `json:"-"` // From active session (empty for historical)

	// User preference (from database) — drives Status
	IsArchived bool   `json:"-"`
	Status     string `json:"status"` // "active" or "archived" (derived from IsArchived)

	// Git info (for active sessions)
	Git *GitInfo `json:"git,omitempty"`

	// Internal: whether metadata has been enriched from JSONL
	enriched bool
}

// computeDisplayTitle computes the display title from available fields
func (e *SessionEntry) computeDisplayTitle() string {
	if e.CustomTitle != "" {
		return e.CustomTitle
	}
	if e.Summary != "" {
		return e.Summary
	}
	if e.FirstPrompt != "" {
		return e.FirstPrompt
	}
	return "Untitled"
}

// Enrich loads accurate FirstPrompt and FirstUserMessageUUID from the JSONL file.
func (e *SessionEntry) Enrich() bool {
	if e.enriched {
		return false
	}

	firstPrompt, firstUUID := GetFirstUserPromptAndUUID(e.SessionID, e.ProjectPath)
	if firstPrompt != "" {
		e.FirstPrompt = firstPrompt
		e.DisplayTitle = e.computeDisplayTitle()
	}
	e.FirstUserMessageUUID = firstUUID
	e.enriched = true
	return true
}

// SessionManager is the single source of truth for all session state.
// It aggregates data from:
// - Filesystem (JSONL files, session indexes)
// - Runtime (active processes, WebSocket clients)
// And provides:
// - Unified query API
// - Mutation methods that emit events
// - Event subscription for real-time updates
type SessionManager struct {
	mu sync.RWMutex

	// File-based metadata cache (from JSONL files)
	entries     map[string]*SessionEntry
	initialized bool

	// Active session processes
	sessions map[string]*Session

	// Event subscribers
	subscribersMu sync.RWMutex
	subscribers   map[chan SessionEvent]struct{}

	// FS watcher
	watcher     *fsnotify.Watcher
	projectsDir string

	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// Live process tracking
	liveProcessCount int32
	processExited    chan struct{}
}

// NewSessionManager creates a new session manager
func NewSessionManager() (*SessionManager, error) {
	homeDir, _ := os.UserHomeDir()
	projectsDir := filepath.Join(homeDir, ".claude", "projects")

	ctx, cancel := context.WithCancel(context.Background())

	m := &SessionManager{
		entries:       make(map[string]*SessionEntry),
		sessions:      make(map[string]*Session),
		subscribers:   make(map[chan SessionEvent]struct{}),
		projectsDir:   projectsDir,
		ctx:           ctx,
		cancel:        cancel,
		processExited: make(chan struct{}, 100),
	}

	// Start background cleanup worker
	m.wg.Add(1)
	go m.cleanupWorker()

	log.Info().Msg("SessionManager created")
	return m, nil
}

// Subscribe registers a callback for session events.
// Returns an unsubscribe function. The goroutine is tracked and will be
// cleaned up on Shutdown even if unsubscribe is not called.
func (m *SessionManager) Subscribe(callback SessionEventCallback) func() {
	ch := make(chan SessionEvent, 10)

	m.subscribersMu.Lock()
	m.subscribers[ch] = struct{}{}
	m.subscribersMu.Unlock()

	// Track this goroutine in the wait group
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		for {
			select {
			case <-m.ctx.Done():
				// Manager shutting down, exit
				return
			case event, ok := <-ch:
				if !ok {
					// Channel closed by unsubscribe
					return
				}
				callback(event)
			}
		}
	}()

	// Return unsubscribe function
	return func() {
		m.subscribersMu.Lock()
		defer m.subscribersMu.Unlock()
		if _, exists := m.subscribers[ch]; exists {
			delete(m.subscribers, ch)
			close(ch)
		}
	}
}

// notify broadcasts an event to all subscribers
func (m *SessionManager) notify(event SessionEvent) {
	m.subscribersMu.RLock()
	defer m.subscribersMu.RUnlock()

	subscriberCount := len(m.subscribers)
	droppedCount := 0

	for ch := range m.subscribers {
		select {
		case ch <- event:
		default:
			droppedCount++
		}
	}

	if droppedCount > 0 {
		log.Warn().
			Str("sessionId", event.SessionID).
			Str("eventType", string(event.Type)).
			Int("droppedCount", droppedCount).
			Int("totalSubscribers", subscriberCount).
			Msg("dropped session events due to full subscriber channels")
	}
}

// SignalShutdown marks all sessions as shutting down.
// Call this early in shutdown sequence so process exit errors are expected.
func (m *SessionManager) SignalShutdown() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, session := range m.sessions {
		session.SignalShutdown()
	}
}

// Shutdown gracefully stops the session manager
func (m *SessionManager) Shutdown(ctx context.Context) error {
	log.Info().Msg("shutting down SessionManager")

	// Signal goroutines to stop
	m.cancel()

	// Close FS watcher
	if m.watcher != nil {
		m.watcher.Close()
	}

	// Wait for live processes to exit
	liveCount := atomic.LoadInt32(&m.liveProcessCount)
	if liveCount > 0 {
		log.Info().Int32("liveProcesses", liveCount).Msg("waiting for Claude processes to exit")

		waitCtx, waitCancel := context.WithTimeout(ctx, 2*time.Second)
		defer waitCancel()

	waitLoop:
		for atomic.LoadInt32(&m.liveProcessCount) > 0 {
			select {
			case <-m.processExited:
				continue
			case <-waitCtx.Done():
				remaining := atomic.LoadInt32(&m.liveProcessCount)
				if remaining > 0 {
					log.Warn().Int32("remaining", remaining).Msg("timeout waiting for processes, force killing")
					m.forceKillAllSessions()
				}
				break waitLoop
			}
		}
	}

	// Clean up session map
	m.mu.Lock()
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	// Close all subscriber channels
	m.subscribersMu.Lock()
	for ch := range m.subscribers {
		close(ch)
	}
	m.subscribers = make(map[chan SessionEvent]struct{})
	m.subscribersMu.Unlock()

	// Wait for internal goroutines
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Info().Msg("SessionManager shutdown complete")
		return nil
	case <-ctx.Done():
		log.Warn().Msg("SessionManager shutdown timed out")
		return ctx.Err()
	}
}

// =============================================================================
// Query Methods
// =============================================================================

// GetSession retrieves a session by ID.
// Returns the merged session entry with both metadata and runtime state.
// If session is archived but exists in history, creates a shell session for viewing.
func (m *SessionManager) GetSession(id string) (*Session, error) {
	m.ensureInitialized()

	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if ok {
		return session, nil
	}

	// Session not active - check if it exists in metadata cache
	m.mu.RLock()
	entry, exists := m.entries[id]
	m.mu.RUnlock()

	if !exists {
		// Not in cache - search for JSONL file directly
		workingDir, found := findSessionByJSONL(id)
		if !found {
			return nil, ErrSessionNotFound
		}
		// Create shell session for this archived session
		return m.createShellSession(id, workingDir, "Archived Session")
	}

	// Create shell session from cached metadata
	return m.createShellSession(id, entry.ProjectPath, entry.DisplayTitle)
}

// GetSessionEntry retrieves a session entry by ID (metadata only, no process)
func (m *SessionManager) GetSessionEntry(id string) *SessionEntry {
	m.ensureInitialized()

	m.mu.RLock()
	defer m.mu.RUnlock()

	entry := m.entries[id]
	if entry == nil {
		return nil
	}

	// Copy and add git info from active session
	result := *entry
	if session, ok := m.sessions[id]; ok {
		result.Git = session.Git
	}

	// Derive status from DB archived state
	if archived, err := db.IsClaudeSessionArchived(id); err == nil && archived {
		result.IsArchived = true
		result.Status = "archived"
	} else {
		result.Status = "active"
	}

	return &result
}

// ListSessions returns active sessions (processes in memory)
func (m *SessionManager) ListSessions() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	return sessions
}

// SessionPaginationResult holds the result of a paginated session query
type SessionPaginationResult struct {
	Entries    []*SessionEntry
	HasMore    bool
	NextCursor string
	TotalCount int
}

// ListAllSessions returns paginated session entries with optional filters
func (m *SessionManager) ListAllSessions(cursor string, limit int, statusFilter string) *SessionPaginationResult {
	m.ensureInitialized()

	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	m.mu.RLock()

	// Get all entries and add runtime state (internal only)
	allEntries := make([]*SessionEntry, 0, len(m.entries))
	seenIDs := make(map[string]bool)

	for _, entry := range m.entries {
		// Skip empty sessions (no messages ever sent)
		if entry.MessageCount == 0 {
			continue
		}

		entryCopy := *entry
		seenIDs[entry.SessionID] = true

		// Copy runtime state from active session if available
		if session, ok := m.sessions[entry.SessionID]; ok {
			entryCopy.Git = session.Git
			entryCopy.IsActivated = true
			entryCopy.IsProcessing = session.IsProcessing()
			entryCopy.HasPendingPermission = session.HasPendingPermission()
			entryCopy.HasUnseenPermission = session.HasUnseenPermission()
			entryCopy.PermissionMode = session.PermissionMode
			// For active sessions, always use the live result count — it's the source
			// of truth (initialized from JSONL in LoadRawMessages, then incremented by
			// live stdout results). The JSONL cache lags behind due to fsnotify delay.
			entryCopy.ResultCount = session.ResultCount()
			// Use the active session's LastUserActivity if it's newer
			if !session.LastUserActivity.IsZero() && session.LastUserActivity.After(entryCopy.LastUserActivity) {
				entryCopy.LastUserActivity = session.LastUserActivity
			}
		}

		allEntries = append(allEntries, &entryCopy)
	}

	// Add any active sessions not in cache (just created).
	// Skip empty sessions (no completed turns and not currently processing) —
	// these are warm sessions created for slash command discovery or idle sessions
	// that haven't been used yet. Previously we also required ClientCount == 0,
	// but that let empty sessions with connected viewers slip through.
	for id, session := range m.sessions {
		if seenIDs[id] || (session.ResultCount() == 0 && !session.IsProcessing()) {
			continue
		}
		entry := &SessionEntry{
			SessionID:            id,
			ProjectPath:          session.WorkingDir,
			DisplayTitle:         session.Title,
			Created:              session.CreatedAt,
			Modified:             session.LastActivity,
			LastUserActivity:     session.LastUserActivity,
			Git:                  session.Git,
			IsActivated:          true,
			IsProcessing:         session.IsProcessing(),
			HasPendingPermission: session.HasPendingPermission(),
			HasUnseenPermission:  session.HasUnseenPermission(),
			PermissionMode:       session.PermissionMode,
			ResultCount:          session.ResultCount(),
		}
		allEntries = append(allEntries, entry)
	}

	m.mu.RUnlock()

	// Load archived session IDs from database and derive Status
	archivedIDs, err := db.GetArchivedClaudeSessionIDs()
	if err != nil {
		log.Warn().Err(err).Msg("failed to load archived session IDs")
		archivedIDs = make(map[string]bool)
	}

	for _, entry := range allEntries {
		entry.IsArchived = archivedIDs[entry.SessionID]
		if entry.IsArchived {
			entry.Status = "archived"
		} else {
			entry.Status = "active"
		}
	}

	// Deduplicate by FirstUserMessageUUID (keep session with most messages)
	allEntries = m.deduplicateEntries(allEntries)

	// Sort by LastUserActivity time (descending) for stable ordering
	// This prevents sessions from jumping around when Claude is actively responding
	sort.Slice(allEntries, func(i, j int) bool {
		if allEntries[i].LastUserActivity.Equal(allEntries[j].LastUserActivity) {
			return allEntries[i].SessionID > allEntries[j].SessionID
		}
		return allEntries[i].LastUserActivity.After(allEntries[j].LastUserActivity)
	})

	// Find cursor position
	startIdx := 0
	if cursor != "" {
		startIdx = m.findCursorIndex(allEntries, cursor)
	}

	// Filter and collect results
	result := make([]*SessionEntry, 0, limit)
	totalFiltered := 0
	filteredAfterCursor := 0

	for i := 0; i < len(allEntries); i++ {
		entry := allEntries[i]

		// Apply status filter
		// "active" = not archived (default view), "archived" = archived only, "all" = everything
		if statusFilter == "active" && entry.IsArchived {
			continue
		}
		if statusFilter == "archived" && !entry.IsArchived {
			continue
		}

		totalFiltered++

		if i < startIdx {
			continue
		}

		filteredAfterCursor++

		if len(result) < limit {
			// Enrich on demand
			entry.Enrich()
			result = append(result, entry)
		}
	}

	// Build pagination info
	hasMore := len(result) == limit && filteredAfterCursor > limit
	var nextCursor string
	if hasMore && len(result) > 0 {
		last := result[len(result)-1]
		nextCursor = fmt.Sprintf("%d_%s", last.LastUserActivity.UnixMilli(), last.SessionID)
	}

	return &SessionPaginationResult{
		Entries:    result,
		HasMore:    hasMore,
		NextCursor: nextCursor,
		TotalCount: totalFiltered,
	}
}

// deduplicateEntries removes duplicate sessions (same FirstUserMessageUUID)
func (m *SessionManager) deduplicateEntries(entries []*SessionEntry) []*SessionEntry {
	groups := make(map[string][]*SessionEntry)
	for _, entry := range entries {
		key := entry.FirstUserMessageUUID
		groups[key] = append(groups[key], entry)
	}

	result := make([]*SessionEntry, 0, len(entries))
	for uuid, group := range groups {
		if uuid == "" {
			result = append(result, group...)
			continue
		}
		// Keep entry with most messages
		var best *SessionEntry
		for _, e := range group {
			if best == nil || e.MessageCount > best.MessageCount {
				best = e
			}
		}
		if best != nil {
			result = append(result, best)
		}
	}
	return result
}

// findCursorIndex finds the index after the cursor position
func (m *SessionManager) findCursorIndex(entries []*SessionEntry, cursor string) int {
	parts := strings.SplitN(cursor, "_", 2)
	if len(parts) != 2 {
		return 0
	}

	cursorMs, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		// Legacy: try parsing RFC3339
		if t, parseErr := time.Parse(time.RFC3339Nano, parts[0]); parseErr == nil {
			cursorMs = t.UnixMilli()
		} else if t, parseErr := time.Parse(time.RFC3339, parts[0]); parseErr == nil {
			cursorMs = t.UnixMilli()
		} else {
			return 0
		}
	}
	cursorTime := time.UnixMilli(cursorMs)
	cursorSessionID := parts[1]

	for i, entry := range entries {
		if entry.LastUserActivity.After(cursorTime) {
			continue
		}
		if entry.LastUserActivity.Equal(cursorTime) && entry.SessionID >= cursorSessionID {
			continue
		}
		return i
	}
	return len(entries)
}

// =============================================================================
// Mutation Methods (all emit events)
// =============================================================================

// CreateSession spawns a new Claude Code process
func (m *SessionManager) CreateSession(workingDir, title string, permissionMode sdk.PermissionMode) (*Session, error) {
	return m.CreateSessionWithID(workingDir, title, "", permissionMode)
}

// CreateSessionWithID spawns a new Claude Code process with optional resume.
func (m *SessionManager) CreateSessionWithID(workingDir, title, resumeSessionID string, permissionMode sdk.PermissionMode) (*Session, error) {
	m.mu.Lock()

	var sessionID string
	if resumeSessionID != "" {
		sessionID = resumeSessionID
		log.Info().Str("sessionId", sessionID).Msg("resuming session with existing ID")
	} else {
		sessionID = uuid.New().String()
	}

	if workingDir == "" {
		workingDir = config.Get().UserDataDir
	}

	if title == "" {
		if resumeSessionID != "" {
			title = "Resumed Session"
		} else {
			title = fmt.Sprintf("Session %d", len(m.sessions)+1)
		}
	}

	if permissionMode == "" {
		permissionMode = sdk.PermissionModeDefault
	}

	// When resuming, preserve LastUserActivity from cached entry so the session
	// doesn't jump to the top of the list just from being re-activated.
	lastUserActivity := time.Now()
	if resumeSessionID != "" {
		if entry, ok := m.entries[resumeSessionID]; ok {
			lastUserActivity = entry.LastUserActivity
		}
	}

	session := &Session{
		ID:                    sessionID,
		WorkingDir:            workingDir,
		Title:                 title,
		PermissionMode:        permissionMode,
		CreatedAt:             time.Now(),
		LastActivity:          time.Now(),
		LastUserActivity:      lastUserActivity,
		Status:                "active",
		Clients:               make(map[*Client]bool),
		activated:             true,
		pendingToolNames: make(map[string]string),
		Git:                   GetGitInfo(workingDir),
		onStateChanged: func() {
			m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: sessionID})
		},
	}

	m.sessions[session.ID] = session
	m.mu.Unlock()

	// Start the SDK process
	if err := m.createSessionWithSDK(session, resumeSessionID != ""); err != nil {
		m.mu.Lock()
		delete(m.sessions, session.ID)
		m.mu.Unlock()
		log.Error().Err(err).Str("workingDir", workingDir).Msg("failed to create SDK session")
		return nil, fmt.Errorf("failed to create SDK session: %w", err)
	}

	log.Info().
		Str("sessionId", sessionID).
		Int("pid", session.ProcessID).
		Str("workingDir", workingDir).
		Msg("created claude session")

	// Emit events
	if resumeSessionID != "" {
		m.notify(SessionEvent{Type: SessionEventActivated, SessionID: sessionID})
	} else {
		m.notify(SessionEvent{Type: SessionEventCreated, SessionID: sessionID})
	}

	return session, nil
}

// ActivateSession spawns a process for an archived session
func (m *SessionManager) ActivateSession(id string) error {
	session, err := m.GetSession(id)
	if err != nil {
		return err
	}

	if session.IsActivated() {
		return nil // Already activated
	}

	if err := session.EnsureActivated(); err != nil {
		return err
	}

	// Emit event
	m.notify(SessionEvent{Type: SessionEventActivated, SessionID: id})

	return nil
}

// DeactivateSession stops a session process but keeps it in history
func (m *SessionManager) DeactivateSession(id string) error {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return ErrSessionNotFound
	}
	delete(m.sessions, id)
	m.mu.Unlock()

	// Cleanup in background
	go m.cleanupSession(session, id)

	// Emit event
	m.notify(SessionEvent{Type: SessionEventDeactivated, SessionID: id})

	return nil
}

// DeleteSession kills a session and removes it completely
func (m *SessionManager) DeleteSession(id string) error {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return ErrSessionNotFound
	}
	delete(m.sessions, id)
	m.mu.Unlock()

	// Cleanup in background
	go m.cleanupSession(session, id)

	// Emit event
	m.notify(SessionEvent{Type: SessionEventDeleted, SessionID: id})

	return nil
}

// UpdateSession updates session metadata
func (m *SessionManager) UpdateSession(id string, title string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.sessions[id]
	if !ok {
		return ErrSessionNotFound
	}

	if title != "" {
		session.Title = title
	}

	// Emit event
	m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: id})

	return nil
}

// =============================================================================
// Initialization and FS Watcher
// =============================================================================

// ensureInitialized lazily initializes the cache using double-checked locking.
// This prevents blocking all requests during slow filesystem initialization.
func (m *SessionManager) ensureInitialized() {
	// Fast path: already initialized (read lock only)
	m.mu.RLock()
	if m.initialized {
		m.mu.RUnlock()
		return
	}
	m.mu.RUnlock()

	// Slow path: need to initialize (write lock)
	m.mu.Lock()
	defer m.mu.Unlock()

	// Double-check after acquiring write lock
	if m.initialized {
		return
	}

	log.Info().Str("projectsDir", m.projectsDir).Msg("initializing SessionManager cache")

	m.loadFromIndexFiles()
	m.scanForMissingJSONL()

	if err := m.startWatcher(); err != nil {
		log.Error().Err(err).Msg("failed to start session watcher")
	}

	m.initialized = true

	log.Info().Int("sessionCount", len(m.entries)).Msg("SessionManager initialized")
}

// loadFromIndexFiles reads all sessions-index.json files
func (m *SessionManager) loadFromIndexFiles() {
	entries, err := os.ReadDir(m.projectsDir)
	if err != nil {
		log.Warn().Err(err).Msg("failed to read projects directory")
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		indexPath := filepath.Join(m.projectsDir, entry.Name(), "sessions-index.json")
		index, err := readSessionIndex(indexPath)
		if err != nil {
			continue
		}

		for _, indexEntry := range index.Entries {
			m.entries[indexEntry.SessionID] = convertToSessionEntry(&indexEntry)
		}
	}

	log.Debug().Int("count", len(m.entries)).Msg("loaded sessions from index files")
}

// convertToSessionEntry converts a SessionIndexEntry to SessionEntry
func convertToSessionEntry(entry *models.SessionIndexEntry) *SessionEntry {
	created, _ := time.Parse(time.RFC3339, entry.Created)
	modified, _ := time.Parse(time.RFC3339, entry.Modified)

	e := &SessionEntry{
		SessionID:        entry.SessionID,
		FullPath:         entry.FullPath,
		FirstPrompt:      entry.FirstPrompt,
		Summary:          entry.Summary,
		CustomTitle:      entry.CustomTitle,
		MessageCount:     entry.MessageCount,
		Created:          created,
		Modified:         modified,
		LastUserActivity: modified, // fallback until JSONL is parsed for accurate value
		GitBranch:        entry.GitBranch,
		ProjectPath:      entry.ProjectPath,
		IsSidechain:      entry.IsSidechain,
		Status:           "active",
		enriched:         false,
	}
	e.DisplayTitle = e.computeDisplayTitle()
	return e
}

// scanForMissingJSONL scans for JSONL files not in the cache
func (m *SessionManager) scanForMissingJSONL() {
	entries, err := os.ReadDir(m.projectsDir)
	if err != nil {
		return
	}

	addedCount := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		projectDir := filepath.Join(m.projectsDir, entry.Name())
		files, err := os.ReadDir(projectDir)
		if err != nil {
			continue
		}

		for _, file := range files {
			if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl") {
				continue
			}

			sessionID := strings.TrimSuffix(file.Name(), ".jsonl")
			if _, exists := m.entries[sessionID]; exists {
				continue
			}

			jsonlPath := filepath.Join(projectDir, file.Name())
			if entry := m.parseJSONLFile(sessionID, jsonlPath); entry != nil {
				m.entries[sessionID] = entry
				addedCount++
			}
		}
	}

	if addedCount > 0 {
		log.Debug().Int("count", addedCount).Msg("added sessions from JSONL scan")
	}
}

// hasUsefulMessages checks if the session has at least one useful message.
// Uses each message's HasUsefulContent() method for unified filtering logic.
func hasUsefulMessages(messages []models.SessionMessageI) bool {
	for _, msg := range messages {
		if msg.HasUsefulContent() {
			return true
		}
	}
	return false
}

// parseJSONLFile parses a JSONL file and extracts session metadata
func (m *SessionManager) parseJSONLFile(sessionID, jsonlPath string) *SessionEntry {
	messages, err := ReadSessionHistoryRaw(sessionID, "")
	if err != nil {
		log.Debug().Err(err).Str("path", jsonlPath).Msg("failed to parse JSONL file")
		return nil
	}

	if len(messages) == 0 {
		return nil
	}

	if !hasUsefulMessages(messages) {
		log.Debug().Str("sessionId", sessionID).Int("messageCount", len(messages)).Msg("ignoring session with no useful messages")
		return nil
	}

	fileInfo, err := os.Stat(jsonlPath)
	if err != nil {
		return nil
	}

	entry := &SessionEntry{
		SessionID:    sessionID,
		FullPath:     jsonlPath,
		MessageCount: len(messages),
		Modified:     fileInfo.ModTime(),
		Status:       "active",
	}

	for i, msg := range messages {
		msgType := msg.GetType()
		timestamp := msg.GetTimestamp()

		if i == 0 && timestamp != "" {
			if t, err := time.Parse(time.RFC3339, timestamp); err == nil {
				entry.Created = t
			}
		}

		if userMsg, ok := msg.(*models.UserSessionMessage); ok {
			if i == 0 || entry.ProjectPath == "" {
				if userMsg.CWD != "" {
					entry.ProjectPath = userMsg.CWD
				}
				if userMsg.GitBranch != "" {
					entry.GitBranch = userMsg.GitBranch
				}
				if userMsg.IsSidechain != nil {
					entry.IsSidechain = *userMsg.IsSidechain
				}
			}
			if entry.FirstPrompt == "" && !userMsg.IsCompactSummary {
				entry.FirstPrompt = userMsg.GetUserPrompt()
				entry.FirstUserMessageUUID = userMsg.GetUUID()
			}

			// Track last user message timestamp for stable list ordering.
			// Only count actual user input — tool use results (auto-generated when
			// Claude calls tools) and compact summaries are not user activity.
			if len(userMsg.ToolUseResult) == 0 && !userMsg.IsCompactSummary {
				if timestamp != "" {
					if t, err := time.Parse(time.RFC3339, timestamp); err == nil {
						entry.LastUserActivity = t
					}
				}
			}
		}

		if assistantMsg, ok := msg.(*models.AssistantSessionMessage); ok {
			if entry.ProjectPath == "" && assistantMsg.CWD != "" {
				entry.ProjectPath = assistantMsg.CWD
			}
			if entry.GitBranch == "" && assistantMsg.GitBranch != "" {
				entry.GitBranch = assistantMsg.GitBranch
			}
		}

		if msgType == "summary" {
			if summaryMsg, ok := msg.(*models.SummarySessionMessage); ok && summaryMsg.Summary != "" {
				entry.Summary = summaryMsg.Summary
			}
		}

		if msgType == "custom-title" {
			if titleMsg, ok := msg.(*models.CustomTitleSessionMessage); ok && titleMsg.CustomTitle != "" {
				entry.CustomTitle = titleMsg.CustomTitle
			}
		}

		if msgType == "result" {
			entry.ResultCount++
		}

	}

	entry.DisplayTitle = entry.computeDisplayTitle()
	entry.enriched = true

	// Fall back to file modification time if no user messages found
	if entry.LastUserActivity.IsZero() {
		entry.LastUserActivity = entry.Modified
	}

	return entry
}

// startWatcher starts the fsnotify watcher
func (m *SessionManager) startWatcher() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	m.watcher = watcher

	entries, err := os.ReadDir(m.projectsDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		projectDir := filepath.Join(m.projectsDir, entry.Name())
		if err := watcher.Add(projectDir); err != nil {
			log.Debug().Err(err).Str("dir", projectDir).Msg("failed to watch directory")
		}
	}

	if err := watcher.Add(m.projectsDir); err != nil {
		log.Warn().Err(err).Msg("failed to watch projects directory")
	}

	m.wg.Add(1)
	go m.watchLoop()

	log.Debug().Int("watchedDirs", len(entries)+1).Msg("started session directory watcher")
	return nil
}

// watchLoop handles fsnotify events
func (m *SessionManager) watchLoop() {
	defer m.wg.Done()

	for {
		select {
		case <-m.ctx.Done():
			log.Debug().Msg("session watcher stopping")
			return

		case event, ok := <-m.watcher.Events:
			if !ok {
				return
			}
			m.handleFSEvent(event)

		case err, ok := <-m.watcher.Errors:
			if !ok {
				return
			}
			log.Debug().Err(err).Msg("fsnotify error")
		}
	}
}

// handleFSEvent processes a single fsnotify event
func (m *SessionManager) handleFSEvent(event fsnotify.Event) {
	// Check for new project directory
	if event.Op&fsnotify.Create != 0 {
		info, err := os.Stat(event.Name)
		if err == nil && info.IsDir() && filepath.Dir(event.Name) == m.projectsDir {
			if err := m.watcher.Add(event.Name); err == nil {
				log.Debug().Str("dir", event.Name).Msg("watching new project directory")
			}
			return
		}
	}

	if !strings.HasSuffix(event.Name, ".jsonl") {
		return
	}

	sessionID := strings.TrimSuffix(filepath.Base(event.Name), ".jsonl")

	switch {
	case event.Op&fsnotify.Create != 0, event.Op&fsnotify.Write != 0:
		if newEntry := m.parseJSONLFile(sessionID, event.Name); newEntry != nil {
			m.mu.Lock()
			oldEntry, existed := m.entries[sessionID]

			// Only notify for meaningful changes
			shouldNotify := !existed
			if existed {
				if oldEntry.DisplayTitle != newEntry.DisplayTitle {
					shouldNotify = true
				}
				// Notify when a turn completes (result count changes) — drives "ready" state
				if oldEntry.ResultCount != newEntry.ResultCount {
					shouldNotify = true
				}
			}

			// Preserve git info from active session
			if session, ok := m.sessions[sessionID]; ok {
				newEntry.Git = session.Git
			}

			m.entries[sessionID] = newEntry
			m.mu.Unlock()

			eventType := SessionEventUpdated
			if !existed {
				eventType = SessionEventCreated
			}
			log.Debug().Str("sessionId", sessionID).Str("op", event.Op.String()).Str("event", string(eventType)).Bool("notify", shouldNotify).Msg("updated session in cache")

			if shouldNotify {
				m.notify(SessionEvent{Type: eventType, SessionID: sessionID})
			}
		}

	case event.Op&fsnotify.Remove != 0, event.Op&fsnotify.Rename != 0:
		m.mu.Lock()
		delete(m.entries, sessionID)
		m.mu.Unlock()
		log.Debug().Str("sessionId", sessionID).Msg("removed session from cache")

		m.notify(SessionEvent{Type: SessionEventDeleted, SessionID: sessionID})
	}
}

// =============================================================================
// Process Management (from Manager)
// =============================================================================

func (m *SessionManager) trackProcessStart() {
	atomic.AddInt32(&m.liveProcessCount, 1)
	log.Debug().Int32("count", atomic.LoadInt32(&m.liveProcessCount)).Msg("process started, live count increased")
}

func (m *SessionManager) trackProcessExit() {
	count := atomic.AddInt32(&m.liveProcessCount, -1)
	log.Debug().Int32("count", count).Msg("process exited, live count decreased")
	select {
	case m.processExited <- struct{}{}:
	default:
	}
}

func (m *SessionManager) LiveProcessCount() int32 {
	return atomic.LoadInt32(&m.liveProcessCount)
}

func (m *SessionManager) forceKillAllSessions() {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for id, session := range m.sessions {
		log.Warn().Str("sessionId", id).Msg("force killing session")

		if session.sdkClient != nil {
			if session.sdkCancel != nil {
				session.sdkCancel()
			}
			session.sdkClient.Close()
		}
	}
}

// createShellSession creates a non-activated session (metadata only)
func (m *SessionManager) createShellSession(id, workingDir, title string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.sessions[id]; ok {
		return existing, nil
	}

	// Preserve the original LastUserActivity from cached entry if available.
	// This is a shell session created for viewing — NOT user interaction —
	// so we must not set LastUserActivity to time.Now() or it will cause
	// the session to jump to the top of the list when merely viewed.
	var lastUserActivity time.Time
	if entry, ok := m.entries[id]; ok {
		lastUserActivity = entry.LastUserActivity
	}

	session := &Session{
		ID:                    id,
		WorkingDir:            workingDir,
		Title:                 title,
		PermissionMode:        sdk.PermissionModeDefault,
		CreatedAt:             time.Now(),
		LastActivity:          time.Now(),
		LastUserActivity:      lastUserActivity,
		Status:                "active",
		Clients:               make(map[*Client]bool),
		activated:             false,
		pendingToolNames: make(map[string]string),
		Git:                   GetGitInfo(workingDir),
		onStateChanged: func() {
			m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: id})
		},
	}

	session.activateFn = func() error {
		return m.activateSession(session)
	}

	m.sessions[id] = session

	log.Debug().Str("sessionId", id).Msg("created shell session (not activated)")

	return session, nil
}

// activateSession spawns the actual Claude process for a shell session
func (m *SessionManager) activateSession(session *Session) error {
	session.ready = make(chan struct{})

	if err := m.createSessionWithSDK(session, true); err != nil {
		log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to activate SDK session")
		return fmt.Errorf("failed to activate SDK session: %w", err)
	}

	go func() {
		time.Sleep(100 * time.Millisecond)
		if session.ready != nil {
			close(session.ready)
		}
	}()

	// Note: Event emission is handled by the public ActivateSession() method
	// to avoid duplicate events when called via session.EnsureActivated()

	return nil
}

// cleanupSession terminates a Claude session and releases resources.
// Shutdown path: sdkClient.Close() → SIGINT → 5s timeout → SIGKILL
//
// Note: Claude CLI (Node.js) responds to SIGINT but ignores SIGTERM.
// See docs/agent/components/claude-code.md for details.
func (m *SessionManager) cleanupSession(session *Session, id string) {
	if session.sdkClient != nil {
		if session.sdkCancel != nil {
			session.sdkCancel()
		}
		session.sdkClient.Close()
		log.Info().Str("sessionId", id).Msg("deactivated SDK claude session")
		return
	}

	log.Info().Str("sessionId", id).Msg("deactivated claude session")
}

func (m *SessionManager) cleanupWorker() {
	defer m.wg.Done()

	// Dead session cleanup runs every minute; idle session GC runs hourly.
	deadTicker := time.NewTicker(1 * time.Minute)
	defer deadTicker.Stop()

	gcTicker := time.NewTicker(1 * time.Hour)
	defer gcTicker.Stop()

	for {
		select {
		case <-m.ctx.Done():
			log.Debug().Msg("cleanup worker stopping")
			return

		case <-deadTicker.C:
			m.mu.Lock()
			for id, session := range m.sessions {
				session.mu.RLock()
				isDead := session.Status == "dead"
				session.mu.RUnlock()
				if isDead {
					log.Info().Str("sessionId", id).Msg("cleaning up dead session")
					delete(m.sessions, id)
				}
			}
			m.mu.Unlock()

		case <-gcTicker.C:
			m.gcIdleSessions()
		}
	}
}

// gcIdleSessions deactivates sessions that have been idle for more than 1 hour
// with no connected WebSocket clients. Re-activation is transparent via
// EnsureActivated(), so GC has zero user-facing downside — it just frees
// the CLI process memory.
func (m *SessionManager) gcIdleSessions() {
	now := time.Now()
	const gcTimeout = 1 * time.Hour

	// Collect candidates first (DeactivateSession acquires m.mu).
	type gcCandidate struct {
		id     string
		reason string
	}
	var candidates []gcCandidate

	m.mu.RLock()
	for id, session := range m.sessions {
		if session.ClientCount() > 0 {
			continue
		}
		age := now.Sub(session.LastActivity)
		if age > gcTimeout {
			candidates = append(candidates, gcCandidate{
				id:     id,
				reason: fmt.Sprintf("no clients, idle for %s", age.Round(time.Minute)),
			})
		}
	}
	m.mu.RUnlock()

	if len(candidates) == 0 {
		return
	}

	log.Info().Int("count", len(candidates)).Msg("GC: deactivating idle sessions")
	for _, c := range candidates {
		log.Info().Str("sessionId", c.id).Str("reason", c.reason).Msg("GC: deactivating session")
		if err := m.DeactivateSession(c.id); err != nil {
			log.Warn().Err(err).Str("sessionId", c.id).Msg("GC: failed to deactivate session")
		}
	}
}

func (m *SessionManager) createSessionWithSDK(session *Session, resume bool) error {
	ctx, cancel := context.WithCancel(m.ctx)
	session.sdkCtx = ctx
	session.sdkCancel = cancel

	// Enable adaptive thinking (extended thinking) by default.
	// 31999 aligns with the VSCode extension's hardcoded default.
	// See: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
	maxThinkingTokens := 31999

	options := sdk.ClaudeAgentOptions{
		Cwd:                    session.WorkingDir,
		SystemPrompt:           defaultSystemPrompt,
		PermissionMode:         session.PermissionMode,
		CanUseTool:             session.CreatePermissionCallback(),
		SkipInitialization:     true,
		IncludePartialMessages: true,  // Enable progressive streaming updates
		MaxThinkingTokens:      &maxThinkingTokens,
	}

	if resume {
		options.Resume = session.ID
	} else {
		sessionIDValue := session.ID
		options.ExtraArgs = map[string]*string{
			"session-id": &sessionIDValue,
		}
	}

	client := sdk.NewClaudeSDKClient(options)
	if err := client.Connect(ctx, ""); err != nil {
		cancel()
		return fmt.Errorf("failed to connect SDK client: %w", err)
	}

	session.sdkClient = client
	session.Status = "active"

	m.trackProcessStart()

	m.wg.Add(1)
	go m.forwardSDKMessages(session)

	log.Info().Str("sessionId", session.ID).Bool("resume", resume).Msg("created SDK-based session")

	return nil
}

func (m *SessionManager) forwardSDKMessages(session *Session) {
	defer m.wg.Done()

	msgs := session.sdkClient.RawMessages()

	for {
		select {
		case <-m.ctx.Done():
			goto waitForProcessExit

		case <-session.sdkCtx.Done():
			goto waitForProcessExit

		case msg, ok := <-msgs:
			if !ok {
				goto processExited
			}

			// Track tool names for forwarded control_requests (needed for "always allow" auto-approve)
			if msgType, _ := msg["type"].(string); msgType == "control_request" {
				if reqID, _ := msg["request_id"].(string); reqID != "" {
					if request, _ := msg["request"].(map[string]any); request != nil {
						if toolName, _ := request["tool_name"].(string); toolName != "" {
							session.pendingToolNamesMu.Lock()
							if session.pendingToolNames == nil {
								session.pendingToolNames = make(map[string]string)
							}
							session.pendingToolNames[reqID] = toolName
							session.pendingToolNamesMu.Unlock()
						}
					}
				}
			}

			data, err := json.Marshal(msg)
			if err != nil {
				log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to marshal message for broadcast")
				continue
			}

			session.BroadcastUIMessage(data)
			session.LastActivity = time.Now()

			log.Debug().Str("sessionId", session.ID).Int("bytes", len(data)).Msg("forwarded SDK message to WebSocket clients")
		}
	}

waitForProcessExit:
	log.Debug().Str("sessionId", session.ID).Msg("SDK message forwarder waiting for process exit")
	for msg := range msgs {
		data, err := json.Marshal(msg)
		if err != nil {
			continue
		}
		session.BroadcastUIMessage(data)
	}

processExited:
	m.trackProcessExit()

	log.Info().Str("sessionId", session.ID).Msg("SDK process exited")

	session.mu.Lock()
	session.Status = "dead"
	session.mu.Unlock()

	m.mu.Lock()
	delete(m.sessions, session.ID)
	m.mu.Unlock()

	log.Info().Str("sessionId", session.ID).Msg("removed dead SDK session from pool")
}
