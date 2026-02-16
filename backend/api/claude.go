package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/xiaoyuanzhu-com/my-life-db/claude"
	"github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ListClaudeSessions handles GET /api/claude/sessions
func (h *Handlers) ListClaudeSessions(c *gin.Context) {
	sessions := h.server.Claude().ListSessions()

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
		PermissionMode  string `json:"permissionMode"`  // Optional: "default", "acceptEdits", "plan", "bypassPermissions"
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

	// Parse permission mode (default to "default")
	permissionMode := sdk.PermissionModeDefault
	switch body.PermissionMode {
	case "acceptEdits":
		permissionMode = sdk.PermissionModeAcceptEdits
	case "plan":
		permissionMode = sdk.PermissionModePlan
	case "bypassPermissions":
		permissionMode = sdk.PermissionModeBypassPermissions
	}

	// Create session (will resume if resumeSessionId is provided)
	session, err := h.server.Claude().CreateSessionWithID(body.WorkingDir, body.Title, body.ResumeSessionID, mode, permissionMode)
	if err != nil {
		log.Error().Err(err).Msg("failed to create session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create session"})
		return
	}

	c.JSON(http.StatusOK, session.ToJSON())
}

// GetClaudeSession handles GET /api/claude/sessions/:id
func (h *Handlers) GetClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	session, err := h.server.Claude().GetSession(sessionID)
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

	if err := h.server.Claude().UpdateSession(sessionID, body.Title); err != nil {
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

	if err := h.server.Claude().DeleteSession(sessionID); err != nil {
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

	if err := h.server.Claude().DeactivateSession(sessionID); err != nil {
		if err == claude.ErrSessionNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to deactivate session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// ArchiveClaudeSession handles POST /api/claude/sessions/:id/archive
// Marks a session as archived so it doesn't appear in the default session list
func (h *Handlers) ArchiveClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	if err := db.ArchiveClaudeSession(sessionID); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to archive session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to archive session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// UnarchiveClaudeSession handles POST /api/claude/sessions/:id/unarchive
// Removes the archived mark from a session
func (h *Handlers) UnarchiveClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	if err := db.UnarchiveClaudeSession(sessionID); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to unarchive session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unarchive session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}

// ClaudeWebSocket handles WebSocket connection for terminal I/O
func (h *Handlers) ClaudeWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	// GetSession will auto-resume from history if not active
	session, err := h.server.Claude().GetSession(sessionID)
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

	// Create a cancellable context that responds to:
	// 1. Server shutdown (graceful termination)
	// 2. WebSocket connection close
	// This ensures clean shutdown without "response.WriteHeader on hijacked connection" warnings.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Monitor server shutdown context
	go func() {
		select {
		case <-h.server.ShutdownContext().Done():
			log.Debug().Str("sessionId", sessionID).Msg("server shutdown, closing WebSocket")
			cancel()
		case <-ctx.Done():
			// Handler is exiting, goroutine can stop
		}
	}()

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
		session.LastUserActivity = time.Now()
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
// Returns both active and historical sessions using the SessionManager.
// Supports pagination via query parameters:
//   - limit: number of sessions to return (default 20, max 100)
//   - cursor: pagination cursor from previous response
//   - status: filter by status ("all", "active", "archived", default "all")
func (h *Handlers) ListAllClaudeSessions(c *gin.Context) {
	// Parse pagination parameters
	limit := 20
	if l := c.Query("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	cursor := c.Query("cursor")
	statusFilter := c.DefaultQuery("status", "all")

	// SessionManager handles merging file metadata + runtime state internally
	paginationResult := h.server.Claude().ListAllSessions(cursor, limit, statusFilter)

	log.Debug().
		Int("returnedCount", len(paginationResult.Entries)).
		Int("totalCount", paginationResult.TotalCount).
		Bool("hasMore", paginationResult.HasMore).
		Str("cursor", cursor).
		Str("statusFilter", statusFilter).
		Msg("ListAllClaudeSessions: fetching sessions with pagination")

	// Convert SessionEntry to response format
	result := make([]map[string]interface{}, 0, len(paginationResult.Entries))
	for _, entry := range paginationResult.Entries {
		sessionData := map[string]interface{}{
			"id":               entry.SessionID,
			"title":            entry.DisplayTitle,
			"workingDir":       entry.ProjectPath,
			"createdAt":        entry.Created,
			"lastActivity":     entry.Modified,
			"lastUserActivity": entry.LastUserActivity,
			"messageCount":     entry.MessageCount,
			"isSidechain":      entry.IsSidechain,
			"status":           entry.Status,
		}

		if entry.Git != nil {
			sessionData["git"] = entry.Git
		} else if entry.GitBranch != "" {
			sessionData["git"] = map[string]interface{}{
				"isRepo": true,
				"branch": entry.GitBranch,
			}
		}

		result = append(result, sessionData)
	}

	log.Debug().
		Int("totalReturned", len(result)).
		Bool("hasMore", paginationResult.HasMore).
		Msg("ListAllClaudeSessions: returning paginated sessions")

	c.JSON(http.StatusOK, gin.H{
		"sessions": result,
		"pagination": gin.H{
			"hasMore":    paginationResult.HasMore,
			"nextCursor": paginationResult.NextCursor,
			"totalCount": paginationResult.TotalCount,
		},
	})
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
	session, err := h.server.Claude().GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	// Send message based on mode
	if session.Mode == claude.ModeUI {
		// UI mode: SendInputUI handles activation internally
		if err := session.SendInputUI(req.Content); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send UI message")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to send message to session"})
			return
		}
	} else {
		// CLI mode: ensure activated, then send to PTY
		if err := session.EnsureActivated(); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to activate session")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to activate session"})
			return
		}

		// Send to PTY character by character
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

	// Auto-unarchive: sending a message to an archived session means the user is actively using it
	if archived, err := db.IsClaudeSessionArchived(sessionID); err == nil && archived {
		if err := db.UnarchiveClaudeSession(sessionID); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to auto-unarchive session")
		} else {
			log.Info().Str("sessionId", sessionID).Msg("auto-unarchived session on new message")
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

// GetClaudeSessionMessages handles GET /api/claude/sessions/:id/messages
// Returns cached messages for a session (same as WebSocket initial payload)
// This is useful for debugging without needing a WebSocket connection
func (h *Handlers) GetClaudeSessionMessages(c *gin.Context) {
	sessionID := c.Param("id")

	// GetSession will auto-resume from history if not active
	session, err := h.server.Claude().GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	var messages []json.RawMessage

	if session.Mode == claude.ModeUI {
		// UI mode: Load from cache (same as WebSocket)
		if err := session.LoadMessageCache(); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to load message cache")
		}

		cachedMessages := session.GetCachedMessages()
		for _, msgBytes := range cachedMessages {
			messages = append(messages, json.RawMessage(msgBytes))
		}
	} else {
		// CLI mode: Read from JSONL file including subagent messages
		// ReadSessionWithSubagents loads both main session and subagent JSONL files,
		// injecting parentToolUseID into subagent messages for proper linking
		rawMessages, err := claude.ReadSessionWithSubagents(sessionID, session.WorkingDir)
		if err != nil {
			log.Debug().Err(err).Str("sessionId", sessionID).Msg("no history found")
		} else {
			for _, msg := range rawMessages {
				if msgBytes, err := json.Marshal(msg); err == nil {
					messages = append(messages, json.RawMessage(msgBytes))
				}
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"sessionId": sessionID,
		"mode":      session.Mode,
		"count":     len(messages),
		"messages":  messages,
	})
}

// ClaudeSubscribeWebSocket handles WebSocket connection for real-time session updates
// Similar to claude.ai/code's /v1/sessions/ws/:id/subscribe endpoint
// This provides structured message streaming with tool calls, thinking blocks, etc.
func (h *Handlers) ClaudeSubscribeWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	log.Debug().Str("sessionId", sessionID).Msg("ClaudeSubscribeWebSocket: WebSocket connection request")

	// GetSession will auto-resume from history if not active
	session, err := h.server.Claude().GetSession(sessionID)
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

	// Create a cancellable context that responds to:
	// 1. Server shutdown (graceful termination)
	// 2. WebSocket connection close
	// This ensures clean shutdown without "response.WriteHeader on hijacked connection" warnings.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Monitor server shutdown context
	go func() {
		select {
		case <-h.server.ShutdownContext().Done():
			log.Debug().Str("sessionId", sessionID).Msg("server shutdown, closing subscribe WebSocket")
			cancel()
		case <-ctx.Done():
			// Handler is exiting, goroutine can stop
		}
	}()

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
		initialMessages, err := claude.ReadSessionWithSubagents(sessionID, session.WorkingDir)
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
		// This includes control_request and control_response - the frontend tracks them
		// by request_id to determine which permissions are pending vs resolved.
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
				// Read session history (use Raw version for passthrough serialization)
				messages, err := claude.ReadSessionHistoryRaw(sessionID, session.WorkingDir)
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
			// Send message based on mode
			if session.Mode == claude.ModeUI {
				// UI mode: SendInputUI handles activation internally
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

				// Broadcast synthetic user message back to clients
				// This unifies behavior with CLI mode where user messages come from JSONL.
				// Claude stdin doesn't echo user messages to stdout, so we synthesize one.
				syntheticMsg := map[string]interface{}{
					"type":      "user",
					"uuid":      uuid.New().String(),
					"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
					"sessionId": sessionID,
					"message": map[string]interface{}{
						"role": "user",
						"content": []map[string]interface{}{
							{"type": "text", "text": inMsg.Content},
						},
					},
				}
				if msgBytes, err := json.Marshal(syntheticMsg); err == nil {
					session.BroadcastUIMessage(msgBytes)
				}
			} else {
				// CLI mode: ensure activated, then send to PTY
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
			session.LastUserActivity = time.Now()

			// Auto-unarchive: sending a message to an archived session means the user is actively using it
			if archived, err := db.IsClaudeSessionArchived(sessionID); err == nil && archived {
				if err := db.UnarchiveClaudeSession(sessionID); err != nil {
					log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to auto-unarchive session")
				} else {
					log.Info().Str("sessionId", sessionID).Msg("auto-unarchived session on new message")
				}
			}

			log.Info().
				Str("sessionId", sessionID).
				Str("content", inMsg.Content).
				Str("mode", string(session.Mode)).
				Msg("message sent to claude session via WebSocket")

		case "control_request":
			// UI mode only: Handle control requests (interrupt, etc.)
			if session.Mode != claude.ModeUI {
				log.Debug().Str("sessionId", sessionID).Msg("control_request received for non-UI session, ignoring")
				break
			}

			// Parse the control request
			var controlReq struct {
				Type      string `json:"type"`
				RequestID string `json:"request_id"`
				Request   struct {
					Subtype string `json:"subtype"`
				} `json:"request"`
			}
			if err := json.Unmarshal(msg, &controlReq); err != nil {
				log.Debug().Err(err).Msg("Failed to parse control_request")
				break
			}

			switch controlReq.Request.Subtype {
			case "interrupt":
				if err := session.Interrupt(); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to interrupt session via WebSocket")
					errMsg := map[string]any{
						"type":  "error",
						"error": "Failed to interrupt session: " + err.Error(),
					}
					if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
						conn.Write(ctx, websocket.MessageText, msgBytes)
					}
				} else {
					log.Info().Str("sessionId", sessionID).Msg("session interrupted via WebSocket")
				}

			case "set_permission_mode":
				// Permission Mode Change Flow:
				//
				// This handler supports both active and inactive (historical) sessions:
				//
				// 1. Historical session (not activated):
				//    - Store permission mode on session object
				//    - Call EnsureActivated() which starts Claude CLI with --permission-mode flag
				//    - Claude starts with the correct permission mode from the beginning
				//
				// 2. Active session (already running):
				//    - Send set_permission_mode control request to Claude via SDK
				//    - Claude updates its permission mode mid-conversation
				//
				// This unified approach means the frontend always sends permission mode changes,
				// and the backend handles activation transparently. No need for frontend to track
				// whether a session is active or not.

				// Parse mode from request
				var modeReq struct {
					Request struct {
						Mode string `json:"mode"`
					} `json:"request"`
				}
				if err := json.Unmarshal(msg, &modeReq); err != nil {
					log.Debug().Err(err).Msg("Failed to parse set_permission_mode request")
					break
				}

				// Validate and convert mode
				var permMode sdk.PermissionMode
				switch modeReq.Request.Mode {
				case "default":
					permMode = sdk.PermissionModeDefault
				case "acceptEdits":
					permMode = sdk.PermissionModeAcceptEdits
				case "plan":
					permMode = sdk.PermissionModePlan
				case "bypassPermissions":
					permMode = sdk.PermissionModeBypassPermissions
				default:
					log.Warn().Str("mode", modeReq.Request.Mode).Msg("Invalid permission mode")
					errMsg := map[string]any{
						"type":       "control_response",
						"request_id": controlReq.RequestID,
						"error":      "Invalid permission mode: " + modeReq.Request.Mode,
					}
					if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
						conn.Write(ctx, websocket.MessageText, msgBytes)
					}
					break
				}

				// Store permission mode first (used during activation if not already active)
				wasActivated := session.IsActivated()
				session.PermissionMode = permMode

				// Ensure session is activated (uses session.PermissionMode for CLI args)
				if err := session.EnsureActivated(); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to activate session for permission mode change")
					errMsg := map[string]any{
						"type":       "control_response",
						"request_id": controlReq.RequestID,
						"error":      "Failed to activate session: " + err.Error(),
					}
					if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
						conn.Write(ctx, websocket.MessageText, msgBytes)
					}
					break
				}

				// If session was already active, send permission mode change to Claude
				// (newly activated sessions already have the correct mode from CLI args)
				if wasActivated {
					if err := session.SetPermissionMode(permMode); err != nil {
						log.Error().Err(err).Str("sessionId", sessionID).Str("mode", modeReq.Request.Mode).Msg("failed to set permission mode")
						errMsg := map[string]any{
							"type":       "control_response",
							"request_id": controlReq.RequestID,
							"error":      "Failed to set permission mode: " + err.Error(),
						}
						if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
							conn.Write(ctx, websocket.MessageText, msgBytes)
						}
						break
					}
				}

				log.Info().
					Str("sessionId", sessionID).
					Str("mode", modeReq.Request.Mode).
					Bool("wasActivated", wasActivated).
					Msg("permission mode changed")

				// Send control_response confirmation to all clients
				responseMsg := map[string]any{
					"type":       "control_response",
					"request_id": controlReq.RequestID,
					"response": map[string]any{
						"subtype": "set_permission_mode",
						"mode":    modeReq.Request.Mode,
					},
				}
				if msgBytes, err := json.Marshal(responseMsg); err == nil {
					session.BroadcastUIMessage(msgBytes)
				}

			default:
				log.Debug().Str("subtype", controlReq.Request.Subtype).Msg("Unknown control_request subtype")
			}

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
						Behavior     string         `json:"behavior"`
						Message      string         `json:"message"`       // Denial reason (required for deny)
						UpdatedInput map[string]any `json:"updated_input"` // Updated tool input (for AskUserQuestion answers)
					} `json:"response"`
				} `json:"response"`
				// Extended fields for "always allow" support
				AlwaysAllow bool   `json:"always_allow"`
				ToolName    string `json:"tool_name"`
			}
			if err := json.Unmarshal(msg, &controlResp); err != nil {
				log.Debug().Err(err).Msg("Failed to parse control_response")
				break
			}

			// Ensure session is activated before sending control_response
			// This handles the case where user answers a historical AskUserQuestion:
			// 1. Session is inactive (no Claude CLI process running)
			// 2. User submits answer via control_response
			// 3. We need to activate the session first so Claude can receive the answer
			// NOTE: For historical questions, Claude may create a NEW tool_use with different ID
			// after resuming, so the user might need to answer again. This is expected behavior.
			if err := session.EnsureActivated(); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to activate session for control_response")
				errMsg := map[string]interface{}{
					"type":  "error",
					"error": fmt.Sprintf("Failed to activate session: %v", err),
				}
				if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
					conn.Write(ctx, websocket.MessageText, msgBytes)
				}
				break
			}

			// Send the response to Claude
			if err := session.SendControlResponse(
				controlResp.RequestID,
				controlResp.Response.Subtype,
				controlResp.Response.Response.Behavior,
				controlResp.Response.Response.Message,
				controlResp.ToolName,
				controlResp.AlwaysAllow,
				controlResp.Response.Response.UpdatedInput,
			); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send control response")
			} else {
				log.Info().
					Str("sessionId", sessionID).
					Str("requestId", controlResp.RequestID).
					Str("behavior", controlResp.Response.Response.Behavior).
					Bool("alwaysAllow", controlResp.AlwaysAllow).
					Str("toolName", controlResp.ToolName).
					Bool("hasUpdatedInput", controlResp.Response.Response.UpdatedInput != nil).
					Msg("sent control response to Claude")
			}

		case "tool_result":
			// UI mode only: Handle tool results from the frontend (e.g., AskUserQuestion answers)
			if session.Mode != claude.ModeUI {
				log.Debug().Str("sessionId", sessionID).Msg("tool_result received for non-UI session, ignoring")
				break
			}

			// Parse the tool_result message
			var toolResult struct {
				Type      string `json:"type"`
				ToolUseID string `json:"tool_use_id"`
				Content   string `json:"content"`
			}
			if err := json.Unmarshal(msg, &toolResult); err != nil {
				log.Debug().Err(err).Msg("Failed to parse tool_result")
				break
			}

			// Send the tool result to Claude
			if err := session.SendToolResult(toolResult.ToolUseID, toolResult.Content); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send tool result")
				errMsg := map[string]any{
					"type":  "error",
					"error": "Failed to send tool result: " + err.Error(),
				}
				if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
					conn.Write(ctx, websocket.MessageText, msgBytes)
				}
			} else {
				log.Info().
					Str("sessionId", sessionID).
					Str("toolUseId", toolResult.ToolUseID).
					Msg("sent tool result to Claude")
			}

		default:
			log.Debug().Str("type", inMsg.Type).Msg("Unknown subscribe message type")
		}
	}

	<-pollDone
	<-pingDone
}

