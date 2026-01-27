package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/xiaoyuanzhu-com/my-life-db/claude/models"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SessionIndexCache provides an in-memory cache of Claude session metadata.
// It lazily initializes on first access by:
// 1. Reading all sessions-index.json files
// 2. Scanning for JSONL files not in the index
// 3. Starting an fsnotify watcher for real-time updates
type SessionIndexCache struct {
	mu          sync.RWMutex
	entries     map[string]*CachedSessionEntry
	initialized bool

	// fsnotify watcher
	watcher *fsnotify.Watcher
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup

	// Path to watch
	projectsDir string
}

// CachedSessionEntry holds session metadata in the cache
type CachedSessionEntry struct {
	SessionID    string    `json:"id"`
	FullPath     string    `json:"fullPath"`
	FirstPrompt  string    `json:"firstPrompt"`
	Summary      string    `json:"summary,omitempty"`
	CustomTitle  string    `json:"customTitle,omitempty"`
	DisplayTitle string    `json:"displayTitle"` // Pre-computed display title to avoid disk reads
	MessageCount int       `json:"messageCount"`
	Created      time.Time `json:"created"`
	Modified     time.Time `json:"modified"`
	GitBranch    string    `json:"gitBranch,omitempty"`
	ProjectPath  string    `json:"projectPath"`
	IsSidechain  bool      `json:"isSidechain"`
}

// NewSessionIndexCache creates a new session index cache.
// The cache is lazy - it won't initialize until first access.
func NewSessionIndexCache() *SessionIndexCache {
	homeDir, _ := os.UserHomeDir()
	projectsDir := filepath.Join(homeDir, ".claude", "projects")

	ctx, cancel := context.WithCancel(context.Background())

	return &SessionIndexCache{
		entries:     make(map[string]*CachedSessionEntry),
		projectsDir: projectsDir,
		ctx:         ctx,
		cancel:      cancel,
	}
}

// GetAll returns all cached session entries.
// On first call, this initializes the cache.
func (c *SessionIndexCache) GetAll() []*CachedSessionEntry {
	c.ensureInitialized()

	c.mu.RLock()
	defer c.mu.RUnlock()

	result := make([]*CachedSessionEntry, 0, len(c.entries))
	for _, entry := range c.entries {
		result = append(result, entry)
	}
	return result
}

// Get returns a single session entry by ID, or nil if not found.
func (c *SessionIndexCache) Get(sessionID string) *CachedSessionEntry {
	c.ensureInitialized()

	c.mu.RLock()
	defer c.mu.RUnlock()

	return c.entries[sessionID]
}

// Shutdown stops the fsnotify watcher and cleans up resources.
func (c *SessionIndexCache) Shutdown(ctx context.Context) error {
	log.Info().Msg("shutting down session index cache")

	// Signal watcher goroutine to stop
	c.cancel()

	// Close watcher
	if c.watcher != nil {
		c.watcher.Close()
	}

	// Wait for goroutine with timeout
	done := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Info().Msg("session index cache shutdown complete")
		return nil
	case <-ctx.Done():
		log.Warn().Msg("session index cache shutdown timed out")
		return ctx.Err()
	}
}

// ensureInitialized lazily initializes the cache on first access.
func (c *SessionIndexCache) ensureInitialized() {
	c.mu.Lock()
	if c.initialized {
		c.mu.Unlock()
		return
	}

	log.Info().Str("projectsDir", c.projectsDir).Msg("initializing session index cache")

	// 1. Read all sessions-index.json files
	c.loadFromIndexFiles()

	// 2. Scan for JSONL files not in the index
	c.scanForMissingJSONL()

	// 3. Start fsnotify watcher
	if err := c.startWatcher(); err != nil {
		log.Error().Err(err).Msg("failed to start session watcher, cache will be static")
	}

	c.initialized = true
	c.mu.Unlock()

	log.Info().Int("sessionCount", len(c.entries)).Msg("session index cache initialized")
}

// loadFromIndexFiles reads all sessions-index.json files and populates the cache.
// Must be called with write lock held.
func (c *SessionIndexCache) loadFromIndexFiles() {
	entries, err := os.ReadDir(c.projectsDir)
	if err != nil {
		log.Warn().Err(err).Msg("failed to read projects directory")
		return
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		indexPath := filepath.Join(c.projectsDir, entry.Name(), "sessions-index.json")
		index, err := readSessionIndex(indexPath)
		if err != nil {
			continue // No index file in this directory
		}

		for _, indexEntry := range index.Entries {
			c.entries[indexEntry.SessionID] = convertIndexEntry(&indexEntry)
		}
	}

	log.Debug().Int("count", len(c.entries)).Msg("loaded sessions from index files")
}

// scanForMissingJSONL scans for JSONL files not in the cache and adds them.
// Must be called with write lock held.
func (c *SessionIndexCache) scanForMissingJSONL() {
	entries, err := os.ReadDir(c.projectsDir)
	if err != nil {
		return
	}

	addedCount := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		projectDir := filepath.Join(c.projectsDir, entry.Name())
		files, err := os.ReadDir(projectDir)
		if err != nil {
			continue
		}

		for _, file := range files {
			if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl") {
				continue
			}

			sessionID := strings.TrimSuffix(file.Name(), ".jsonl")
			if _, exists := c.entries[sessionID]; exists {
				continue // Already in cache
			}

			// Parse JSONL to build entry
			jsonlPath := filepath.Join(projectDir, file.Name())
			if cacheEntry := c.parseJSONLFile(sessionID, jsonlPath); cacheEntry != nil {
				c.entries[sessionID] = cacheEntry
				addedCount++
			}
		}
	}

	if addedCount > 0 {
		log.Debug().Int("count", addedCount).Msg("added sessions from JSONL scan")
	}
}

// uselessMessageTypes defines message types that don't constitute meaningful session content.
// A session with ONLY these message types will be ignored.
var uselessMessageTypes = map[string]bool{
	"file-history-snapshot": true,
}

// hasUsefulMessages checks if the session has at least one useful message.
func hasUsefulMessages(messages []models.SessionMessageI) bool {
	for _, msg := range messages {
		if !uselessMessageTypes[msg.GetType()] {
			return true
		}
	}
	return false
}

// parseJSONLFile parses a JSONL file and extracts session metadata.
// Returns nil if the session has no useful messages (sanity check).
func (c *SessionIndexCache) parseJSONLFile(sessionID, jsonlPath string) *CachedSessionEntry {
	messages, err := ReadSessionHistoryRaw(sessionID, "")
	if err != nil {
		log.Debug().Err(err).Str("path", jsonlPath).Msg("failed to parse JSONL file")
		return nil
	}

	if len(messages) == 0 {
		return nil
	}

	// Sanity check: ignore sessions with only useless messages
	if !hasUsefulMessages(messages) {
		log.Debug().Str("sessionId", sessionID).Int("messageCount", len(messages)).Msg("ignoring session with no useful messages")
		return nil
	}

	// Get file info for timestamps
	fileInfo, err := os.Stat(jsonlPath)
	if err != nil {
		return nil
	}

	entry := &CachedSessionEntry{
		SessionID:    sessionID,
		FullPath:     jsonlPath,
		MessageCount: len(messages),
		Modified:     fileInfo.ModTime(),
	}

	// Extract metadata from messages
	for i, msg := range messages {
		msgType := msg.GetType()
		timestamp := msg.GetTimestamp()

		// First message gives us created time
		if i == 0 && timestamp != "" {
			if t, err := time.Parse(time.RFC3339, timestamp); err == nil {
				entry.Created = t
			}
		}

		// Extract envelope fields (cwd, gitBranch, isSidechain) from user/assistant messages
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
			// Get first user prompt (skip compact summary messages)
			if entry.FirstPrompt == "" && !userMsg.IsCompactSummary {
				entry.FirstPrompt = userMsg.GetUserPrompt()
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

		// Get summary if present
		if msgType == "summary" {
			if summaryMsg, ok := msg.(*models.SummarySessionMessage); ok && summaryMsg.Summary != "" {
				entry.Summary = summaryMsg.Summary
			}
		}

		// Get custom title if present
		if msgType == "custom-title" {
			if titleMsg, ok := msg.(*models.CustomTitleSessionMessage); ok && titleMsg.CustomTitle != "" {
				entry.CustomTitle = titleMsg.CustomTitle
			}
		}
	}

	// Pre-compute display title to avoid disk reads later
	entry.DisplayTitle = entry.computeDisplayTitle()

	return entry
}

// startWatcher starts the fsnotify watcher for the projects directory.
// Must be called with write lock held.
func (c *SessionIndexCache) startWatcher() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	c.watcher = watcher

	// Watch each project subdirectory
	entries, err := os.ReadDir(c.projectsDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		projectDir := filepath.Join(c.projectsDir, entry.Name())
		if err := watcher.Add(projectDir); err != nil {
			log.Debug().Err(err).Str("dir", projectDir).Msg("failed to watch directory")
		}
	}

	// Also watch the projects directory itself for new project directories
	if err := watcher.Add(c.projectsDir); err != nil {
		log.Warn().Err(err).Msg("failed to watch projects directory")
	}

	// Start watcher goroutine
	c.wg.Add(1)
	go c.watchLoop()

	log.Debug().Int("watchedDirs", len(entries)+1).Msg("started session directory watcher")
	return nil
}

// watchLoop handles fsnotify events.
func (c *SessionIndexCache) watchLoop() {
	defer c.wg.Done()

	for {
		select {
		case <-c.ctx.Done():
			log.Debug().Msg("session watcher stopping")
			return

		case event, ok := <-c.watcher.Events:
			if !ok {
				return
			}
			c.handleFSEvent(event)

		case err, ok := <-c.watcher.Errors:
			if !ok {
				return
			}
			log.Debug().Err(err).Msg("fsnotify error")
		}
	}
}

// handleFSEvent processes a single fsnotify event.
func (c *SessionIndexCache) handleFSEvent(event fsnotify.Event) {
	// Check if it's a new project directory
	if event.Op&fsnotify.Create != 0 {
		info, err := os.Stat(event.Name)
		if err == nil && info.IsDir() && filepath.Dir(event.Name) == c.projectsDir {
			// New project directory - add to watcher
			if err := c.watcher.Add(event.Name); err == nil {
				log.Debug().Str("dir", event.Name).Msg("watching new project directory")
			}
			return
		}
	}

	// Check if it's a JSONL file
	if !strings.HasSuffix(event.Name, ".jsonl") {
		return
	}

	sessionID := strings.TrimSuffix(filepath.Base(event.Name), ".jsonl")

	switch {
	case event.Op&fsnotify.Create != 0, event.Op&fsnotify.Write != 0:
		// New or modified JSONL - parse and update cache
		if cacheEntry := c.parseJSONLFile(sessionID, event.Name); cacheEntry != nil {
			c.mu.Lock()
			c.entries[sessionID] = cacheEntry
			c.mu.Unlock()
			log.Debug().Str("sessionId", sessionID).Str("op", event.Op.String()).Msg("updated session in cache")
		}

	case event.Op&fsnotify.Remove != 0, event.Op&fsnotify.Rename != 0:
		// Removed JSONL - remove from cache
		c.mu.Lock()
		delete(c.entries, sessionID)
		c.mu.Unlock()
		log.Debug().Str("sessionId", sessionID).Msg("removed session from cache")
	}
}

// convertIndexEntry converts a SessionIndexEntry to a CachedSessionEntry.
// Note: FirstPrompt is computed via GetFirstUserPrompt() to handle compacted sessions correctly.
// The index's firstPrompt is unreliable after context compaction.
func convertIndexEntry(entry *models.SessionIndexEntry) *CachedSessionEntry {
	created, _ := time.Parse(time.RFC3339, entry.Created)
	modified, _ := time.Parse(time.RFC3339, entry.Modified)

	cached := &CachedSessionEntry{
		SessionID:    entry.SessionID,
		FullPath:     entry.FullPath,
		FirstPrompt:  GetFirstUserPrompt(entry.SessionID, entry.ProjectPath), // Parse JSONL for accurate first prompt
		Summary:      entry.Summary,
		CustomTitle:  entry.CustomTitle,
		MessageCount: entry.MessageCount,
		Created:      created,
		Modified:     modified,
		GitBranch:    entry.GitBranch,
		ProjectPath:  entry.ProjectPath,
		IsSidechain:  entry.IsSidechain,
	}
	// Pre-compute display title to avoid disk reads later
	cached.DisplayTitle = cached.computeDisplayTitle()
	return cached
}

// computeDisplayTitle computes the display title.
// Priority: CustomTitle > Summary > FirstPrompt > "Untitled"
// Note: FirstPrompt is pre-computed via GetFirstUserPrompt() which already filters
// out system tags and compact summary messages.
func (e *CachedSessionEntry) computeDisplayTitle() string {
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

// GetDisplayTitle returns the pre-computed display title.
// Falls back to computing it if not cached (for backwards compatibility).
func (e *CachedSessionEntry) GetDisplayTitle() string {
	if e.DisplayTitle != "" {
		return e.DisplayTitle
	}
	// Fallback for entries loaded before DisplayTitle was cached
	return e.computeDisplayTitle()
}
