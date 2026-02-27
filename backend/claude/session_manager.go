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

HTML output must be mobile-friendly and responsive — use relative units, flexbox/grid, and ensure readability on small screens.

This applies even when your workflow generates intermediate files (e.g., a script that outputs HTML to a temp file). The pipeline is fine — but present the final result as a fenced code block in your response, not as a file path. Users may be on mobile where opening local files is inconvenient.`

// SessionEvent represents a change in session state
type SessionEvent struct {
	Type      SessionEventType `json:"type"`
	SessionID string           `json:"sessionId"`
}

// SessionEventCallback is called when session state changes
type SessionEventCallback func(event SessionEvent)

// sessionMetadata is a package-private struct for transferring parsed JSONL data
// into Session objects. Used by parseJSONLFile and handleFSEvent.
type sessionMetadata struct {
	FullPath             string
	ProjectPath          string // Working directory from JSONL
	Title                string // First user prompt (used as fallback display title)
	FirstUserMessageUUID string
	Summary              string
	CustomTitle          string
	MessageCount         int
	ResultCount          int
	Created              time.Time
	Modified             time.Time
	LastUserActivity     time.Time
	GitBranch            string
	IsSidechain          bool
	enriched             bool
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

	// All sessions — the single store for both active and historical sessions.
	// Active sessions have activated=true and sdkClient set.
	// Historical sessions have activated=false and metadata from JSONL.
	sessions    map[string]*Session
	initialized bool

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

// GetSession retrieves a session by ID from the single store.
// All sessions (active + historical) are in m.sessions.
// If not found in memory, searches for JSONL on disk as a fallback.
func (m *SessionManager) GetSession(id string) (*Session, error) {
	m.ensureInitialized()

	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if ok {
		return session, nil
	}

	// Not in the store — could be a session that wasn't picked up during init.
	// Search for the JSONL file on disk.
	workingDir, found := findSessionByJSONL(id)
	if !found {
		return nil, ErrSessionNotFound
	}

	// Create a historical session and add it to the store.
	return m.createShellSession(id, workingDir, "Archived Session")
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

// SessionPaginationResult holds the result of a paginated session query.
// Contains SessionSnapshots (point-in-time copies), not live Session pointers.
type SessionPaginationResult struct {
	Sessions   []SessionSnapshot
	HasMore    bool
	NextCursor string
	TotalCount int
}

// sessionRef pairs a live Session with its point-in-time snapshot.
// Used internally by ListAllSessions for lock-free sorting and filtering.
type sessionRef struct {
	session *Session
	snap    SessionSnapshot
}

// ListAllSessions returns paginated sessions with optional filters.
// Reads from the single m.sessions store — no overlay or sync needed.
// All session data is captured in SessionSnapshots under lock to eliminate TOCTOU races.
func (m *SessionManager) ListAllSessions(cursor string, limit int, statusFilter string) *SessionPaginationResult {
	m.ensureInitialized()

	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	// Collect snapshots under m.mu.RLock. Each session.Snapshot() acquires session.mu.RLock
	// internally, so all fields (including runtime state like isProcessing) are consistent.
	m.mu.RLock()
	all := make([]sessionRef, 0, len(m.sessions))
	for _, session := range m.sessions {
		snap := session.Snapshot()
		// Skip empty inactive sessions (no messages, not currently processing).
		if snap.MessageCount == 0 && !snap.IsProcessing && snap.ResultCount == 0 {
			continue
		}
		all = append(all, sessionRef{session: session, snap: snap})
	}
	m.mu.RUnlock()

	// Load archived session IDs from database.
	// Protected with recover() because db.GetArchivedClaudeSessionIDs panics
	// when the DB is not initialized (e.g., in tests).
	// If the DB call fails, preserve existing IsArchived values from the snapshot.
	var archivedIDs map[string]bool
	dbOK := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				log.Warn().Msgf("recovered from panic loading archived sessions: %v", r)
			}
		}()
		var err error
		archivedIDs, err = db.GetArchivedClaudeSessionIDs()
		if err != nil {
			log.Warn().Err(err).Msg("failed to load archived session IDs")
		} else {
			dbOK = true
		}
	}()

	if dbOK {
		for i := range all {
			archived := archivedIDs[all[i].snap.ID]
			all[i].snap.IsArchived = archived
			// Also update the live session for persistence across calls
			all[i].session.SetIsArchived(archived)
		}
	}

	// Deduplicate by FirstUserMessageUUID (keep session with most messages)
	all = deduplicateSessionRefs(all)

	// Sort by snapshot.LastUserActivity (descending) for stable ordering.
	// All reads are from the snapshot — no lock needed during sort.
	sort.Slice(all, func(i, j int) bool {
		if all[i].snap.LastUserActivity.Equal(all[j].snap.LastUserActivity) {
			return all[i].snap.ID > all[j].snap.ID
		}
		return all[i].snap.LastUserActivity.After(all[j].snap.LastUserActivity)
	})

	// Find cursor position
	startIdx := 0
	if cursor != "" {
		startIdx = findRefCursorIndex(all, cursor)
	}

	// Filter and collect results
	result := make([]SessionSnapshot, 0, limit)
	totalFiltered := 0
	filteredAfterCursor := 0

	for i := 0; i < len(all); i++ {
		snap := &all[i].snap

		// Apply status filter
		// "active" = not archived (default view), "archived" = archived only, "all" = everything
		if statusFilter == "active" && snap.IsArchived {
			continue
		}
		if statusFilter == "archived" && !snap.IsArchived {
			continue
		}

		totalFiltered++

		if i < startIdx {
			continue
		}

		filteredAfterCursor++

		if len(result) < limit {
			// Enrich on demand (may update DisplayTitle, FirstUserMessageUUID)
			if all[i].session.Enrich() {
				// Re-snapshot after enrichment to pick up the new data
				*snap = all[i].session.Snapshot()
				if dbOK {
					snap.IsArchived = archivedIDs[snap.ID]
				}
			}
			result = append(result, *snap)
		}
	}

	// Build pagination info
	hasMore := len(result) == limit && filteredAfterCursor > limit
	var nextCursor string
	if hasMore && len(result) > 0 {
		last := result[len(result)-1]
		nextCursor = fmt.Sprintf("%d_%s", last.LastUserActivity.UnixMilli(), last.ID)
	}

	return &SessionPaginationResult{
		Sessions:   result,
		HasMore:    hasMore,
		NextCursor: nextCursor,
		TotalCount: totalFiltered,
	}
}

// deduplicateSessionRefs removes duplicate sessions (same FirstUserMessageUUID).
// Operates on snapshots — no lock needed.
func deduplicateSessionRefs(refs []sessionRef) []sessionRef {
	groups := make(map[string][]int) // uuid -> indices into refs
	for i, ref := range refs {
		key := ref.snap.FirstUserMessageUUID
		groups[key] = append(groups[key], i)
	}

	result := make([]sessionRef, 0, len(refs))
	for uuid, indices := range groups {
		if uuid == "" {
			for _, i := range indices {
				result = append(result, refs[i])
			}
			continue
		}
		// Keep session with most messages
		bestIdx := indices[0]
		for _, i := range indices[1:] {
			if refs[i].snap.MessageCount > refs[bestIdx].snap.MessageCount {
				bestIdx = i
			}
		}
		result = append(result, refs[bestIdx])
	}
	return result
}

// findRefCursorIndex finds the index after the cursor position.
// Operates on snapshots — no lock needed.
func findRefCursorIndex(refs []sessionRef, cursor string) int {
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

	for i, ref := range refs {
		if ref.snap.LastUserActivity.After(cursorTime) {
			continue
		}
		if ref.snap.LastUserActivity.Equal(cursorTime) && ref.snap.ID >= cursorSessionID {
			continue
		}
		return i
	}
	return len(refs)
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

	// When resuming, preserve LastUserActivity from existing session so it
	// doesn't jump to the top of the list just from being re-activated.
	lastUserActivity := time.Now()
	if resumeSessionID != "" {
		if existing, ok := m.sessions[resumeSessionID]; ok {
			lastUserActivity = existing.LastUserActivity
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

// DeactivateSession stops a session process but keeps it in the store.
// The session remains in m.sessions with activated=false so it still appears in the list.
func (m *SessionManager) DeactivateSession(id string) error {
	m.mu.RLock()
	session, ok := m.sessions[id]
	m.mu.RUnlock()

	if !ok {
		return ErrSessionNotFound
	}

	session.mu.Lock()
	if !session.activated {
		session.mu.Unlock()
		return nil // Already deactivated
	}
	// Prevent re-activation until process is fully dead (processExited re-enables it)
	session.activated = false
	session.activateFn = nil
	session.mu.Unlock()

	// Cleanup in background (kills the process; forwardSDKMessages handles state reset)
	go m.cleanupSession(session, id)

	// Emit event
	m.notify(SessionEvent{Type: SessionEventDeactivated, SessionID: id})

	return nil
}

// DeleteSession kills a session and removes it from the store entirely.
// This is the only mutation that removes from m.sessions (user explicitly deletes).
func (m *SessionManager) DeleteSession(id string) error {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return ErrSessionNotFound
	}
	delete(m.sessions, id) // Actually remove — user explicitly deleted
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
	m.applyPersistedPreferences()

	if err := m.startWatcher(); err != nil {
		log.Error().Err(err).Msg("failed to start session watcher")
	}

	m.initialized = true

	log.Info().Int("sessionCount", len(m.sessions)).Msg("SessionManager initialized")
}

// loadFromIndexFiles reads all sessions-index.json files into m.sessions
func (m *SessionManager) loadFromIndexFiles() {
	entries, err := os.ReadDir(m.projectsDir)
	if err != nil {
		log.Warn().Err(err).Msg("failed to read projects directory")
		return
	}

	loadedCount := 0
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
			session := m.newHistoricalSessionFromIndex(&indexEntry)
			m.sessions[session.ID] = session
			loadedCount++
		}
	}

	log.Debug().Int("count", loadedCount).Msg("loaded sessions from index files")
}

// newHistoricalSessionFromIndex creates a historical Session from a session index entry.
func (m *SessionManager) newHistoricalSessionFromIndex(entry *models.SessionIndexEntry) *Session {
	created, _ := time.Parse(time.RFC3339, entry.Created)
	modified, _ := time.Parse(time.RFC3339, entry.Modified)

	session := &Session{
		ID:               entry.SessionID,
		WorkingDir:       entry.ProjectPath,
		CreatedAt:        created,
		LastActivity:     modified,
		LastUserActivity: modified, // fallback until JSONL is parsed for accurate value
		Status:           "active",
		Clients:          make(map[*Client]bool),
		pendingToolNames: make(map[string]string),
		// Metadata
		Title:        entry.FirstPrompt, // Seed from index; enriched later from JSONL
		FullPath:     entry.FullPath,
		Summary:      entry.Summary,
		CustomTitle:  entry.CustomTitle,
		MessageCount: entry.MessageCount,
		GitBranch:    entry.GitBranch,
		IsSidechain:  entry.IsSidechain,
	}
	session.activateFn = func() error {
		return m.activateSession(session)
	}
	session.onStateChanged = func() {
		m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: session.ID})
	}
	return session
}

// scanForMissingJSONL scans for JSONL files not already in m.sessions
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
			if _, exists := m.sessions[sessionID]; exists {
				continue
			}

			jsonlPath := filepath.Join(projectDir, file.Name())
			if meta := m.parseJSONLFile(sessionID, jsonlPath); meta != nil {
				session := m.newHistoricalSessionFromMetadata(sessionID, meta)
				m.sessions[sessionID] = session
				addedCount++
			}
		}
	}

	if addedCount > 0 {
		log.Debug().Int("count", addedCount).Msg("added sessions from JSONL scan")
	}
}

// applyPersistedPreferences loads permission mode and always-allowed tools
// from the database and applies them to loaded sessions. This makes backend
// restarts transparent — sessions retain their preferences.
func (m *SessionManager) applyPersistedPreferences() {
	// Wrap in recover() like ListAllSessions does, because DB may not be
	// initialized in tests.
	var prefs map[string]*db.ClaudeSessionPreferences
	func() {
		defer func() {
			if r := recover(); r != nil {
				log.Warn().Msgf("recovered from panic loading session preferences: %v", r)
			}
		}()
		var err error
		prefs, err = db.GetAllClaudeSessionPreferences()
		if err != nil {
			log.Warn().Err(err).Msg("failed to load session preferences")
		}
	}()

	if prefs == nil {
		return
	}

	applied := 0
	for sessionID, pref := range prefs {
		session, exists := m.sessions[sessionID]
		if !exists {
			continue
		}

		if pref.PermissionMode != "" {
			session.PermissionMode = sdk.PermissionMode(pref.PermissionMode)
		}

		if len(pref.AlwaysAllowedTools) > 0 {
			session.alwaysAllowedTools = make(map[string]bool, len(pref.AlwaysAllowedTools))
			for _, tool := range pref.AlwaysAllowedTools {
				session.alwaysAllowedTools[tool] = true
			}
		}

		applied++
	}

	if applied > 0 {
		log.Info().Int("count", applied).Msg("applied persisted session preferences")
	}
}

// newHistoricalSessionFromMetadata creates a historical Session from parsed JSONL metadata.
func (m *SessionManager) newHistoricalSessionFromMetadata(id string, meta *sessionMetadata) *Session {
	session := &Session{
		ID:               id,
		WorkingDir:       meta.ProjectPath,
		CreatedAt:        meta.Created,
		LastActivity:     meta.Modified,
		LastUserActivity: meta.LastUserActivity,
		Status:           "active",
		Clients:          make(map[*Client]bool),
		pendingToolNames: make(map[string]string),
		// Metadata
		Title:                meta.Title,
		FullPath:             meta.FullPath,
		FirstUserMessageUUID: meta.FirstUserMessageUUID,
		Summary:              meta.Summary,
		CustomTitle:          meta.CustomTitle,
		MessageCount:         meta.MessageCount,
		GitBranch:            meta.GitBranch,
		IsSidechain:          meta.IsSidechain,
		enriched:             meta.enriched,
	}
	session.resultCount = meta.ResultCount
	session.activateFn = func() error {
		return m.activateSession(session)
	}
	session.onStateChanged = func() {
		m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: session.ID})
	}
	return session
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

// parseJSONLFile parses a JSONL file and extracts session metadata.
// Returns a sessionMetadata struct (not a Session) for data transfer.
func (m *SessionManager) parseJSONLFile(sessionID, jsonlPath string) *sessionMetadata {
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

	meta := &sessionMetadata{
		FullPath:     jsonlPath,
		MessageCount: len(messages),
		Modified:     fileInfo.ModTime(),
		enriched:     true,
	}

	for i, msg := range messages {
		msgType := msg.GetType()
		timestamp := msg.GetTimestamp()

		if i == 0 && timestamp != "" {
			if t, err := time.Parse(time.RFC3339, timestamp); err == nil {
				meta.Created = t
			}
		}

		if userMsg, ok := msg.(*models.UserSessionMessage); ok {
			if i == 0 || meta.ProjectPath == "" {
				if userMsg.CWD != "" {
					meta.ProjectPath = userMsg.CWD
				}
				if userMsg.GitBranch != "" {
					meta.GitBranch = userMsg.GitBranch
				}
				if userMsg.IsSidechain != nil {
					meta.IsSidechain = *userMsg.IsSidechain
				}
			}
			if meta.Title == "" && !userMsg.IsCompactSummary {
				meta.Title = userMsg.GetUserPrompt()
				meta.FirstUserMessageUUID = userMsg.GetUUID()
			}

			// Track last user message timestamp for stable list ordering.
			// Only count actual user input — tool use results (auto-generated when
			// Claude calls tools) and compact summaries are not user activity.
			if len(userMsg.ToolUseResult) == 0 && !userMsg.IsCompactSummary {
				if timestamp != "" {
					if t, err := time.Parse(time.RFC3339, timestamp); err == nil {
						meta.LastUserActivity = t
					}
				}
			}
		}

		if assistantMsg, ok := msg.(*models.AssistantSessionMessage); ok {
			if meta.ProjectPath == "" && assistantMsg.CWD != "" {
				meta.ProjectPath = assistantMsg.CWD
			}
			if meta.GitBranch == "" && assistantMsg.GitBranch != "" {
				meta.GitBranch = assistantMsg.GitBranch
			}
		}

		if msgType == "summary" {
			if summaryMsg, ok := msg.(*models.SummarySessionMessage); ok && summaryMsg.Summary != "" {
				meta.Summary = summaryMsg.Summary
			}
		}

		if msgType == "custom-title" {
			if titleMsg, ok := msg.(*models.CustomTitleSessionMessage); ok && titleMsg.CustomTitle != "" {
				meta.CustomTitle = titleMsg.CustomTitle
			}
		}

		if msgType == "result" {
			meta.ResultCount++
		}
	}

	// Fall back to file modification time if no user messages found
	if meta.LastUserActivity.IsZero() {
		meta.LastUserActivity = meta.Modified
	}

	return meta
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
		if meta := m.parseJSONLFile(sessionID, event.Name); meta != nil {
			m.mu.Lock()
			session, existed := m.sessions[sessionID]

			shouldNotify := !existed
			if existed {
				// Only notify for meaningful changes (title changed)
				oldTitle := session.ComputeDisplayTitle()
				// Merge metadata into existing session
				session.mergeMetadata(meta)
				if session.ComputeDisplayTitle() != oldTitle {
					shouldNotify = true
				}
			} else {
				// New session from disk — create historical Session
				session = m.newHistoricalSessionFromMetadata(sessionID, meta)
				m.sessions[sessionID] = session
			}
			m.mu.Unlock()

			eventType := SessionEventUpdated
			if !existed {
				eventType = SessionEventCreated
			}
			log.Debug().Str("sessionId", sessionID).Str("op", event.Op.String()).Str("event", string(eventType)).Bool("notify", shouldNotify).Msg("updated session in store")

			if shouldNotify {
				m.notify(SessionEvent{Type: eventType, SessionID: sessionID})
			}
		}

	case event.Op&fsnotify.Remove != 0, event.Op&fsnotify.Rename != 0:
		// Don't delete — session might still be active or have connected clients.
		// Just clear the FullPath to indicate the file is gone.
		m.mu.RLock()
		if session, ok := m.sessions[sessionID]; ok {
			session.FullPath = ""
		}
		m.mu.RUnlock()
		log.Debug().Str("sessionId", sessionID).Msg("JSONL file removed, cleared FullPath")
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

		session.mu.RLock()
		client := session.sdkClient
		cancel := session.sdkCancel
		session.mu.RUnlock()

		if client != nil {
			if cancel != nil {
				cancel()
			}
			client.Close()
		}
	}
}

// createShellSession creates a non-activated session for a session found on disk
// but not yet in m.sessions. This is the fallback path in GetSession.
func (m *SessionManager) createShellSession(id, workingDir, title string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.sessions[id]; ok {
		return existing, nil
	}

	session := &Session{
		ID:               id,
		WorkingDir:       workingDir,
		Title:            title,
		PermissionMode:   sdk.PermissionModeDefault,
		CreatedAt:        time.Now(),
		LastActivity:     time.Now(),
		Status:           "active",
		Clients:          make(map[*Client]bool),
		activated:        false,
		pendingToolNames: make(map[string]string),
		Git:              GetGitInfo(workingDir),
	}
	session.activateFn = func() error {
		return m.activateSession(session)
	}
	session.onStateChanged = func() {
		m.notify(SessionEvent{Type: SessionEventUpdated, SessionID: id})
	}

	m.sessions[id] = session

	log.Debug().Str("sessionId", id).Msg("created shell session (not activated)")

	return session, nil
}

// activateSession spawns the actual Claude process for a shell session.
// The ready channel is created by EnsureActivated before calling this.
func (m *SessionManager) activateSession(session *Session) error {
	if err := m.createSessionWithSDK(session, true); err != nil {
		log.Error().Err(err).Str("sessionId", session.ID).Msg("failed to activate SDK session")
		return fmt.Errorf("failed to activate SDK session: %w", err)
	}

	// Close the ready channel after a small delay to signal the SDK is up.
	// The channel was created by EnsureActivated under lock.
	go func() {
		time.Sleep(100 * time.Millisecond)
		session.mu.Lock()
		readyChan := session.ready
		session.mu.Unlock()
		if readyChan != nil {
			close(readyChan)
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
	session.mu.RLock()
	client := session.sdkClient
	cancel := session.sdkCancel
	session.mu.RUnlock()

	if client != nil {
		if cancel != nil {
			cancel()
		}
		client.Close()
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
			// Safety net: if a session is stuck as "dead" (should be handled by
			// forwardSDKMessages processExited), reset its state.
			m.mu.RLock()
			for id, session := range m.sessions {
				session.mu.RLock()
				isDead := session.Status == "dead"
				session.mu.RUnlock()
				if isDead {
					log.Warn().Str("sessionId", id).Msg("found dead session not cleaned up by processExited, resetting")
					m.resetProcessState(session)
				}
			}
			m.mu.RUnlock()

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
		session.mu.RLock()
		lastActivity := session.LastActivity
		session.mu.RUnlock()
		age := now.Sub(lastActivity)
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
	session.mu.Lock()
	session.sdkCtx = ctx
	session.sdkCancel = cancel
	permMode := session.PermissionMode
	session.mu.Unlock()

	// Enable adaptive thinking (extended thinking) by default.
	// 31999 aligns with the VSCode extension's hardcoded default.
	// See: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
	maxThinkingTokens := 31999

	options := sdk.ClaudeAgentOptions{
		Cwd:                    session.WorkingDir,
		SystemPrompt:           defaultSystemPrompt,
		PermissionMode:         permMode,
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

	session.mu.Lock()
	session.sdkClient = client
	session.Status = "active"
	session.mu.Unlock()

	m.trackProcessStart()

	m.wg.Add(1)
	go m.forwardSDKMessages(session)

	log.Info().Str("sessionId", session.ID).Bool("resume", resume).Msg("created SDK-based session")

	return nil
}

func (m *SessionManager) forwardSDKMessages(session *Session) {
	defer m.wg.Done()

	client := session.getSDKClient()
	msgs := client.RawMessages()

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
			session.TouchActivity()

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

	// Reset process state — session stays in m.sessions with activated=false.
	m.resetProcessState(session)

	m.notify(SessionEvent{Type: SessionEventDeactivated, SessionID: session.ID})

	log.Info().Str("sessionId", session.ID).Msg("reset session state after process exit")
}

// resetProcessState clears all process-related state from a session,
// returning it to a historical (non-activated) state that can be re-activated.
// Must be called after the process has exited.
func (m *SessionManager) resetProcessState(session *Session) {
	session.mu.Lock()
	session.activated = false
	session.activating = false
	session.isProcessing = false
	session.pendingPermissionCount = 0
	session.seenPermissionCount = 0
	session.Status = "active"
	session.sdkClient = nil
	session.sdkCtx = nil
	session.sdkCancel = nil
	session.ready = nil
	// Re-enable lazy activation now that the process is fully dead
	session.activateFn = func() error {
		return m.activateSession(session)
	}
	cb := session.onStateChanged
	session.mu.Unlock()

	if cb != nil {
		cb()
	}
}
