package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"

	"github.com/xiaoyuanzhu-com/my-life-db/claude"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var claudeManager *claude.Manager

// InitClaudeManager initializes the Claude session manager
func InitClaudeManager() error {
	var err error
	claudeManager, err = claude.NewManager()
	if err != nil {
		return err
	}
	log.Info().Msg("Claude Code manager initialized")
	return nil
}

// ShutdownClaudeManager gracefully shuts down the Claude session manager
func ShutdownClaudeManager(ctx context.Context) error {
	if claudeManager == nil {
		return nil
	}
	return claudeManager.Shutdown(ctx)
}

// ListClaudeSessions handles GET /api/claude/sessions
func (h *Handlers) ListClaudeSessions(c *gin.Context) {
	sessions := claudeManager.ListSessions()

	// Convert to JSON-safe format
	result := make([]map[string]interface{}, len(sessions))
	for i, s := range sessions {
		result[i] = s.ToJSON()
	}

	c.JSON(http.StatusOK, gin.H{
		"sessions": result,
	})
}

// CreateClaudeSession handles POST /api/claude/sessions
func (h *Handlers) CreateClaudeSession(c *gin.Context) {
	var body struct {
		WorkingDir      string `json:"workingDir"`
		Title           string `json:"title"`
		ResumeSessionID string `json:"resumeSessionId"` // Optional: resume from this session ID
		Mode            string `json:"mode"`            // Optional: "ui" (default) or "cli"
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// Use data directory as default working dir
	if body.WorkingDir == "" {
		body.WorkingDir = config.Get().UserDataDir
	}

	// Parse mode (default to UI)
	mode := claude.ModeUI
	if body.Mode == "cli" {
		mode = claude.ModeCLI
	}

	// Create session (will resume if resumeSessionId is provided)
	session, err := claudeManager.CreateSessionWithID(body.WorkingDir, body.Title, body.ResumeSessionID, mode)
	if err != nil {
		if err == claude.ErrTooManySessions {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many sessions"})
			return
		}
		log.Error().Err(err).Msg("failed to create session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
		return
	}

	c.JSON(http.StatusOK, session.ToJSON())
}

// GetClaudeSession handles GET /api/claude/sessions/:id
func (h *Handlers) GetClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	session, err := claudeManager.GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	c.JSON(http.StatusOK, session.ToJSON())
}

// UpdateClaudeSession handles PATCH /api/claude/sessions/:id
func (h *Handlers) UpdateClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	var body struct {
		Title string `json:"title"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if err := claudeManager.UpdateSession(sessionID, body.Title); err != nil {
		if err == claude.ErrSessionNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// DeleteClaudeSession handles DELETE /api/claude/sessions/:id
func (h *Handlers) DeleteClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	if err := claudeManager.DeleteSession(sessionID); err != nil {
		if err == claude.ErrSessionNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// DeactivateClaudeSession handles POST /api/claude/sessions/:id/deactivate
// Deactivates (archives) a session without deleting it from history
func (h *Handlers) DeactivateClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	if err := claudeManager.DeactivateSession(sessionID); err != nil {
		if err == claude.ErrSessionNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to deactivate session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// ClaudeWebSocket handles WebSocket connection for terminal I/O
func (h *Handlers) ClaudeWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	// GetSession will auto-resume from history if not active
	session, err := claudeManager.GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	// Get the underlying http.ResponseWriter from Gin's wrapper
	// Gin wraps the response writer to track state, but WebSocket needs the raw writer
	var w http.ResponseWriter = c.Writer

	// Try to unwrap to get the actual response writer
	// Gin's ResponseWriter may wrap the original, we need the original for hijacking
	if unwrapper, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		w = unwrapper.Unwrap()
	}

	// Accept WebSocket connection (coder/websocket)
	conn, err := websocket.Accept(w, c.Request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,                              // Skip origin check - auth is handled at higher layer
		CompressionMode:    websocket.CompressionContextTakeover, // Enable permessage-deflate compression
	})
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("WebSocket upgrade failed")
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Abort Gin context to prevent middleware from writing headers on hijacked connection
	c.Abort()

	// Create a cancellable context - we cancel it when WebSocket closes
	// Gin's request context doesn't cancel when WebSocket connection closes
	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	// Ensure session is activated before connecting client
	if err := session.EnsureActivated(); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to activate session")
		conn.Close(websocket.StatusInternalError, "Failed to activate session")
		return
	}

	// Create a new client and register it with the session
	client := &claude.Client{
		Conn: conn,
		Send: make(chan []byte, 256),
	}
	session.AddClient(client)
	defer session.RemoveClient(client)

	// Goroutine to send data from client.Send channel to WebSocket
	sendDone := make(chan struct{})
	go func() {
		defer close(sendDone)
		for {
			select {
			case <-ctx.Done():
				return
			case data, ok := <-client.Send:
				if !ok {
					return // Channel closed
				}
				if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
					// Only log as error if context wasn't cancelled
					if ctx.Err() == nil {
						log.Error().Err(err).Str("sessionId", sessionID).Msg("WebSocket write failed")
					}
					return
				}
			}
		}
	}()

	// Goroutine to send periodic pings to keep connection alive
	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		for {
			select {
			case <-ctx.Done():
				return
			case <-pingTicker.C:
				if err := conn.Ping(ctx); err != nil {
					log.Debug().Err(err).Msg("WebSocket ping failed")
					return
				}
			}
		}
	}()

	// WebSocket → PTY (read from browser, send to claude process)
	for {
		msgType, msg, err := conn.Read(ctx)
		if err != nil {
			// Normal closures (page refresh, navigation, switching sessions) → DEBUG
			// Unexpected errors → INFO
			closeStatus := websocket.CloseStatus(err)
			if closeStatus == websocket.StatusGoingAway ||
			   closeStatus == websocket.StatusNormalClosure ||
			   closeStatus == websocket.StatusNoStatusRcvd {
				log.Debug().Str("sessionId", sessionID).Int("closeStatus", int(closeStatus)).Msg("Terminal WebSocket closed normally")
			} else {
				log.Info().Err(err).Str("sessionId", sessionID).Msg("Terminal WebSocket read error")
			}
			cancel() // Signal goroutines to stop
			break
		}

		// Only handle binary messages (terminal I/O)
		if msgType != websocket.MessageBinary {
			continue
		}

		// Log what xterm is sending (debug level - very noisy)
		log.Debug().
			Str("sessionId", sessionID).
			Str("source", "xterm").
			Str("data", string(msg)).
			Int("length", len(msg)).
			Str("hex", fmt.Sprintf("%x", msg)).
			Msg("xterm → PTY")

		if _, err := session.PTY.Write(msg); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed")
			cancel() // Signal goroutines to stop
			conn.Close(websocket.StatusInternalError, "PTY write error")
			break
		}

		session.LastActivity = time.Now()
	}

	// Wait for send goroutine to finish
	<-sendDone
	<-pingDone
}

// ChatMessage represents a message in the chat WebSocket protocol
type ChatMessage struct {
	Type      string      `json:"type"`
	MessageID string      `json:"messageId,omitempty"`
	Data      interface{} `json:"data,omitempty"`
}

// ListAllClaudeSessions handles GET /api/claude/sessions/all
// Returns both active and historical sessions from all Claude project directories
func (h *Handlers) ListAllClaudeSessions(c *gin.Context) {
	// Get all sessions from our manager's pool (includes newly created sessions)
	activeSessions := claudeManager.ListSessions()
	activeSessionMap := make(map[string]*claude.Session)
	for _, s := range activeSessions {
		activeSessionMap[s.ID] = s
	}

	log.Debug().
		Int("managerSessionCount", len(activeSessions)).
		Msg("ListAllClaudeSessions: fetching sessions")

	// Track which sessions we've already added (to avoid duplicates)
	addedSessions := make(map[string]bool)
	result := make([]map[string]interface{}, 0)

	// Read sessions from all Claude project directories
	index, err := claude.GetAllSessionIndexes()
	if err != nil {
		// If no sessions found, just return active sessions from manager
		log.Info().Err(err).Msg("no session indexes found, returning active sessions only")
		for _, s := range activeSessions {
			sessionData := s.ToJSON()
			sessionData["isActive"] = s.IsActivated()
			result = append(result, sessionData)
		}
		c.JSON(http.StatusOK, gin.H{"sessions": result})
		return
	}

	log.Debug().Int("indexEntryCount", len(index.Entries)).Msg("ListAllClaudeSessions: read all indexes")

	// Convert index entries to response format
	for _, entry := range index.Entries {
		addedSessions[entry.SessionID] = true

		// Compute display title with priority: customTitle > summary > firstUserPrompt
		title := claude.GetSessionDisplayTitle(entry)

		sessionData := map[string]interface{}{
			"id":           entry.SessionID,
			"title":        title,
			"workingDir":   entry.ProjectPath,
			"createdAt":    entry.Created,
			"lastActivity": entry.Modified,
			"messageCount": entry.MessageCount,
			"gitBranch":    entry.GitBranch,
			"isSidechain":  entry.IsSidechain,
		}

		// Check if session is in our manager's pool
		if activeSession, ok := activeSessionMap[entry.SessionID]; ok {
			sessionData["isActive"] = activeSession.IsActivated()
			sessionData["status"] = activeSession.Status
			sessionData["processId"] = activeSession.ProcessID
			sessionData["clients"] = len(activeSession.Clients)
		} else {
			sessionData["isActive"] = false
			sessionData["status"] = "archived"
		}

		result = append(result, sessionData)
	}

	// Add any sessions from manager that aren't in the index yet (newly created)
	addedFromManager := 0
	for _, s := range activeSessions {
		if addedSessions[s.ID] {
			continue // Already added from index
		}
		sessionData := s.ToJSON()
		sessionData["isActive"] = s.IsActivated()
		result = append(result, sessionData)
		addedFromManager++
		log.Debug().Str("sessionId", s.ID).Msg("ListAllClaudeSessions: adding session from manager (not in index)")
	}

	log.Debug().
		Int("totalSessions", len(result)).
		Int("fromIndex", len(index.Entries)).
		Int("fromManager", addedFromManager).
		Msg("ListAllClaudeSessions: returning sessions")

	c.JSON(http.StatusOK, gin.H{"sessions": result})
}

// SendClaudeMessage handles POST /api/claude/sessions/:id/messages
// Sends a message to a Claude session via HTTP (alternative to WebSocket)
func (h *Handlers) SendClaudeMessage(c *gin.Context) {
	sessionID := c.Param("id")

	var req struct {
		Content string `json:"content" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request: " + err.Error()})
		return
	}

	// Get or create session (will auto-resume from history if not active)
	session, err := claudeManager.GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	// Ensure session is activated
	wasInactive := !session.IsActivated()
	if err := session.EnsureActivated(); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to activate session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to activate session"})
		return
	}

	// Wait for Claude to be ready if we just activated it
	if wasInactive {
		if err := session.WaitUntilReady(5 * time.Second); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("session not ready in time")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Session activation timed out"})
			return
		}

		// Brief delay for CLI mode to ensure readline is fully initialized
		if session.Mode == claude.ModeCLI {
			time.Sleep(200 * time.Millisecond)
		}
		log.Info().Str("sessionId", sessionID).Msg("Session ready, sending message")
	}

	// Send message based on mode
	if session.Mode == claude.ModeUI {
		// UI mode: send JSON message to stdin
		if err := session.SendInputUI(req.Content); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send UI message")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to send message to session"})
			return
		}
	} else {
		// CLI mode: send to PTY character by character
		for _, ch := range req.Content {
			charByte := []byte(string(ch))
			if _, err := session.PTY.Write(charByte); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed (char)")
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to send message to session"})
				return
			}
		}

		// Small delay before Enter to ensure readline processes the input correctly
		time.Sleep(50 * time.Millisecond)
		if _, err := session.PTY.Write([]byte("\r")); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed (enter)")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to send message to session"})
			return
		}
	}

	log.Info().
		Str("sessionId", sessionID).
		Str("content", req.Content).
		Str("mode", string(session.Mode)).
		Msg("message sent to claude session via HTTP")

	c.JSON(http.StatusOK, gin.H{
		"sessionId": sessionID,
		"status":    "sent",
	})
}

// ClaudeSubscribeWebSocket handles WebSocket connection for real-time session updates
// Similar to claude.ai/code's /v1/sessions/ws/:id/subscribe endpoint
// This provides structured message streaming with tool calls, thinking blocks, etc.
func (h *Handlers) ClaudeSubscribeWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	log.Debug().Str("sessionId", sessionID).Msg("ClaudeSubscribeWebSocket: WebSocket connection request")

	// GetSession will auto-resume from history if not active
	session, err := claudeManager.GetSession(sessionID)
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("ClaudeSubscribeWebSocket: session not found")
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	log.Debug().Str("sessionId", sessionID).Bool("activated", session.IsActivated()).Msg("ClaudeSubscribeWebSocket: got session")

	// Get the underlying http.ResponseWriter from Gin's wrapper
	var w http.ResponseWriter = c.Writer
	if unwrapper, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		w = unwrapper.Unwrap()
	}

	// Accept WebSocket connection
	conn, err := websocket.Accept(w, c.Request, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Skip origin check - auth is handled at higher layer
	})
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("Subscribe WebSocket upgrade failed")
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Abort Gin context to prevent middleware from writing headers on hijacked connection
	c.Abort()

	// Create a cancellable context - we cancel it when WebSocket closes
	// Gin's request context doesn't cancel when WebSocket connection closes
	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()

	// DON'T activate on connection - wait for first message
	// This allows viewing historical sessions without activating them
	log.Debug().Str("sessionId", sessionID).Str("mode", string(session.Mode)).Msg("Subscribe WebSocket connected (not activated yet)")

	// Track last known message count to detect new messages (CLI mode only)
	lastMessageCount := 0
	lastTodoCount := 0
	var updateMutex sync.Mutex // Protect concurrent access to lastMessageCount/lastTodoCount

	// For CLI mode only: Send existing messages from JSONL file on connect
	// For UI mode: Claude outputs history on stdout when session activates, so no need to read JSONL
	if session.Mode == claude.ModeCLI {
		initialMessages, err := claude.ReadSessionHistory(sessionID, session.WorkingDir)
		if err == nil && len(initialMessages) > 0 {
			log.Debug().
				Str("sessionId", sessionID).
				Int("messageCount", len(initialMessages)).
				Msg("sending initial messages (CLI mode)")

			for _, msg := range initialMessages {
				if msgBytes, err := json.Marshal(msg); err == nil {
					if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
						log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send initial message")
						return
					}
				}
			}
			lastMessageCount = len(initialMessages)
		} else if err != nil {
			log.Debug().Err(err).Str("sessionId", sessionID).Msg("no initial history found (new session)")
		}
	}

	// For UI mode: Register as a broadcast client to receive real-time JSON messages
	// For CLI mode: Use file watcher/polling for updates
	var uiClient *claude.Client
	pollDone := make(chan struct{})

	if session.Mode == claude.ModeUI {
		// Load message cache from JSONL (if not already loaded or activated)
		// This allows viewing history before activation
		if err := session.LoadMessageCache(); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to load message cache")
		}

		// Send all cached messages to this client
		cachedMessages := session.GetCachedMessages()
		if len(cachedMessages) > 0 {
			log.Debug().
				Str("sessionId", sessionID).
				Int("messageCount", len(cachedMessages)).
				Msg("sending cached messages to new client")

			for _, msgBytes := range cachedMessages {
				if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send cached message")
					return
				}
			}
		}

		// UI mode: Create a client to receive broadcasts from readJSON
		uiClient = &claude.Client{
			Conn: conn,
			Send: make(chan []byte, 256),
		}
		session.AddClient(uiClient)
		defer session.RemoveClient(uiClient)

		// Start goroutine to forward broadcasts to WebSocket
		go func() {
			defer close(pollDone) // Reuse pollDone for consistency
			for {
				select {
				case <-ctx.Done():
					return
				case data, ok := <-uiClient.Send:
					if !ok {
						return
					}
					if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
						if ctx.Err() == nil {
							log.Debug().Err(err).Str("sessionId", sessionID).Msg("UI mode WebSocket write failed")
						}
						return
					}
				}
			}
		}()
	} else {
		// CLI mode: Setup hybrid watcher (fsnotify + polling fallback)
		watcher, err := claude.NewSessionWatcher(sessionID, session.WorkingDir)
		if err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to create session watcher, falling back to polling only")
			watcher = nil // Explicitly set to nil for safety
		} else {
			defer watcher.Close()
			if err := watcher.Start(ctx); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to start session watcher")
				watcher.Close()
				watcher = nil
			}
		}

		// Helper function to send updates (CLI mode only)
		sendUpdates := func(updateType string) {
			updateMutex.Lock()
			defer updateMutex.Unlock()

			if updateType == "messages" || updateType == "all" {
				// Read session history
				messages, err := claude.ReadSessionHistory(sessionID, session.WorkingDir)
				if err != nil {
					log.Debug().Err(err).Str("sessionId", sessionID).Msg("failed to read session history")
				} else if len(messages) > lastMessageCount {
					// Send any new messages (including progress messages)
					newMessages := messages[lastMessageCount:]

					for _, msg := range newMessages {
						// Send ALL message types (user, assistant, progress, queue-operation, etc.)
						if msgBytes, err := json.Marshal(msg); err == nil {
							if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
								return
							}
						}
					}
					lastMessageCount = len(messages)
				}
			}

			if updateType == "todos" || updateType == "all" {
				// Read todos
				todos, err := claude.ReadSessionTodos(sessionID)
				if err != nil {
					log.Debug().Err(err).Str("sessionId", sessionID).Msg("failed to read todos")
				} else if len(todos) != lastTodoCount {
					// Send todos if they changed
					todoMsg := map[string]interface{}{
						"type": "todo_update",
						"data": map[string]interface{}{
							"todos": todos,
						},
					}
					if msgBytes, err := json.Marshal(todoMsg); err == nil {
						if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
							log.Debug().Err(err).Str("sessionId", sessionID).Msg("Subscribe WebSocket write failed")
							return
						}
					}
					lastTodoCount = len(todos)
				}
			}
		}

		// Polling + fsnotify goroutine (hybrid approach) - CLI mode only
		pollTicker := time.NewTicker(5 * time.Second) // Reduced frequency - fsnotify handles most updates

		go func() {
			defer close(pollDone)
			defer pollTicker.Stop()

			// Get update channel (nil-safe)
			var updateChan <-chan string
			if watcher != nil {
				updateChan = watcher.Updates()
			}

			for {
				select {
				case <-ctx.Done():
					return

				case updateType, ok := <-updateChan:
					// Fast path: fsnotify detected a change
					if !ok {
						return
					}
					if updateType != "" {
						sendUpdates(updateType)
					}

				case <-pollTicker.C:
					// Slow path: safety net polling to catch anything fsnotify missed
					sendUpdates("all")
				}
			}
		}()
	}

	// Ping goroutine
	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		for {
			select {
			case <-ctx.Done():
				return
			case <-pingTicker.C:
				if err := conn.Ping(ctx); err != nil {
					return
				}
			}
		}
	}()

	// Read messages from client (for sending user messages)
	for {
		msgType, msg, err := conn.Read(ctx)
		if err != nil {
			// Normal closures (page refresh, navigation, switching sessions) → DEBUG
			// Unexpected errors → INFO
			closeStatus := websocket.CloseStatus(err)
			if closeStatus == websocket.StatusGoingAway ||
			   closeStatus == websocket.StatusNormalClosure ||
			   closeStatus == websocket.StatusNoStatusRcvd {
				log.Debug().Str("sessionId", sessionID).Int("closeStatus", int(closeStatus)).Msg("WebSocket closed normally")
			} else {
				log.Debug().Err(err).Str("sessionId", sessionID).Msg("WebSocket read error")
			}
			cancel() // Signal goroutines to stop
			break
		}

		if msgType != websocket.MessageText {
			log.Debug().Str("sessionId", sessionID).Int("msgType", int(msgType)).Msg("Ignoring non-text message")
			continue
		}

		// Parse incoming message
		var inMsg struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(msg, &inMsg); err != nil {
			log.Debug().Err(err).Msg("Failed to parse subscribe message")
			continue
		}

		log.Debug().Str("sessionId", sessionID).Str("type", inMsg.Type).Msg("Received subscribe message")

		switch inMsg.Type {
		case "user_message":
			// Activate session on first message (lazy activation)
			wasInactive := !session.IsActivated()
			if wasInactive {
				log.Debug().Str("sessionId", sessionID).Msg("Activating session on first message")
				if err := session.EnsureActivated(); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to activate session")
					errMsg := map[string]interface{}{
						"type":  "error",
						"error": "Failed to activate session",
					}
					if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
						conn.Write(ctx, websocket.MessageText, msgBytes)
					}
					break
				}

				// Wait for Claude to be ready (first output received)
				if err := session.WaitUntilReady(5 * time.Second); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("session not ready in time")
					errMsg := map[string]interface{}{
						"type":  "error",
						"error": "Session activation timed out",
					}
					if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
						conn.Write(ctx, websocket.MessageText, msgBytes)
					}
					break
				}

				// Brief delay for CLI mode to ensure readline is fully initialized
				if session.Mode == claude.ModeCLI {
					time.Sleep(200 * time.Millisecond)
				}
			}

			// Send message based on mode
			if session.Mode == claude.ModeUI {
				// UI mode: send JSON message to stdin
				if err := session.SendInputUI(inMsg.Content); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send UI message")
					errMsg := map[string]interface{}{
						"type":  "error",
						"error": "Failed to send message to session",
					}
					if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
						conn.Write(ctx, websocket.MessageText, msgBytes)
					}
					break
				}
			} else {
				// CLI mode: Send message to Claude by writing to PTY
				// Send each character separately to avoid readline paste detection
				for _, ch := range inMsg.Content {
					charByte := []byte(string(ch))
					if _, err := session.PTY.Write(charByte); err != nil {
						log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed (char)")
						errMsg := map[string]interface{}{
							"type":  "error",
							"error": "Failed to send message to session",
						}
						if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
							conn.Write(ctx, websocket.MessageText, msgBytes)
						}
						break
					}
				}

				// Small delay before Enter to ensure readline processes the input correctly
				time.Sleep(50 * time.Millisecond)
				if _, err := session.PTY.Write([]byte("\r")); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed (enter)")
				}
			}

			session.LastActivity = time.Now()

			log.Info().
				Str("sessionId", sessionID).
				Str("content", inMsg.Content).
				Str("mode", string(session.Mode)).
				Msg("message sent to claude session via WebSocket")

		case "control_response":
			// UI mode only: Handle permission responses from the frontend
			if session.Mode != claude.ModeUI {
				log.Debug().Str("sessionId", sessionID).Msg("control_response received for non-UI session, ignoring")
				break
			}

			// Parse the control response (nested structure from frontend)
			var controlResp struct {
				Type      string `json:"type"`
				RequestID string `json:"request_id"`
				Response  struct {
					Subtype  string `json:"subtype"`
					Response struct {
						Behavior string `json:"behavior"`
					} `json:"response"`
				} `json:"response"`
			}
			if err := json.Unmarshal(msg, &controlResp); err != nil {
				log.Debug().Err(err).Msg("Failed to parse control_response")
				break
			}

			// Send the response to Claude
			if err := session.SendControlResponse(controlResp.RequestID, controlResp.Response.Subtype, controlResp.Response.Response.Behavior); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send control response")
			} else {
				log.Info().
					Str("sessionId", sessionID).
					Str("requestId", controlResp.RequestID).
					Str("behavior", controlResp.Response.Response.Behavior).
					Msg("sent control response to Claude")
			}

		default:
			log.Debug().Str("type", inMsg.Type).Msg("Unknown subscribe message type")
		}
	}

	<-pollDone
	<-pingDone
}
