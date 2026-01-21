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
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// Use data directory as default working dir
	if body.WorkingDir == "" {
		body.WorkingDir = config.Get().UserDataDir
	}

	// Create session (will resume if resumeSessionId is provided)
	session, err := claudeManager.CreateSessionWithID(body.WorkingDir, body.Title, body.ResumeSessionID)
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
// Returns both active and historical sessions from Claude's session index
func (h *Handlers) ListAllClaudeSessions(c *gin.Context) {
	// Get working directory (project path)
	projectPath := config.Get().UserDataDir

	// Read sessions index from Claude's directory
	index, err := claude.GetSessionIndexForProject(projectPath)
	if err != nil {
		// If no sessions-index.json exists yet, just return active sessions
		log.Debug().Err(err).Msg("no session index found, returning active sessions only")
		activeSessions := claudeManager.ListSessions()
		result := make([]map[string]interface{}, len(activeSessions))
		for i, s := range activeSessions {
			sessionData := s.ToJSON()
			sessionData["isActive"] = true
			result[i] = sessionData
		}
		c.JSON(http.StatusOK, gin.H{"sessions": result})
		return
	}

	// Get active session IDs for quick lookup
	// IMPORTANT: Only mark as active if the session process is actually running (activated)
	activeSessionIDs := make(map[string]bool)
	activeSessions := claudeManager.ListSessions()
	for _, s := range activeSessions {
		if s.IsActivated() {
			activeSessionIDs[s.ID] = true
		}
	}

	// Convert index entries to response format
	result := make([]map[string]interface{}, 0, len(index.Entries))
	for _, entry := range index.Entries {
		sessionData := map[string]interface{}{
			"id":           entry.SessionID,
			"title":        entry.FirstPrompt,
			"workingDir":   entry.ProjectPath,
			"createdAt":    entry.Created,
			"lastActivity": entry.Modified,
			"messageCount": entry.MessageCount,
			"gitBranch":    entry.GitBranch,
			"isActive":     activeSessionIDs[entry.SessionID],
			"isSidechain":  entry.IsSidechain,
		}

		// If session is active (activated), add additional live data
		if activeSessionIDs[entry.SessionID] {
			activeSession, _ := claudeManager.GetSession(entry.SessionID)
			if activeSession != nil {
				sessionData["status"] = activeSession.Status
				sessionData["processId"] = activeSession.ProcessID
				sessionData["clients"] = len(activeSession.Clients)
			}
		} else {
			sessionData["status"] = "archived"
		}

		result = append(result, sessionData)
	}

	c.JSON(http.StatusOK, gin.H{"sessions": result})
}

// GetClaudeSessionHistory handles GET /api/claude/sessions/:id/history
func (h *Handlers) GetClaudeSessionHistory(c *gin.Context) {
	sessionID := c.Param("id")

	log.Debug().Str("sessionId", sessionID).Msg("GetClaudeSessionHistory: fetching history")

	// Try to get project path from active session first
	var projectPath string
	session, err := claudeManager.GetSession(sessionID)
	if err == nil {
		projectPath = session.WorkingDir
		log.Debug().Str("sessionId", sessionID).Bool("activated", session.IsActivated()).Msg("GetClaudeSessionHistory: got session from manager")
	} else {
		// If not in active sessions, try to find it in Claude's session files
		// Use empty project path - the reader will search all projects
		projectPath = ""
		log.Debug().Str("sessionId", sessionID).Msg("GetClaudeSessionHistory: session not found in manager")
	}

	// Read JSONL file using the session reader
	messages, err := claude.ReadSessionHistory(sessionID, projectPath)
	if err != nil {
		// Check if it's a "file not found" error - this is OK for new sessions
		if err.Error() == "session file not found for session "+sessionID {
			// Session exists but has no history yet (no conversation started)
			log.Debug().Str("sessionId", sessionID).Msg("session has no history file yet")
			c.JSON(http.StatusOK, gin.H{
				"sessionId": sessionID,
				"messages":  []claude.SessionMessage{},
			})
			return
		}

		// Other errors are actual failures
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to read session history")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read session history"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"sessionId": sessionID,
		"messages":  messages,
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

		// Brief delay to ensure readline is fully initialized
		time.Sleep(200 * time.Millisecond)
		log.Info().Str("sessionId", sessionID).Msg("Session ready, sending message")
	}

	// Send message to Claude by writing to PTY
	// Send each character separately to avoid readline paste detection
	// No delay between characters for faster input
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

	log.Info().
		Str("sessionId", sessionID).
		Str("content", req.Content).
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
	log.Debug().Str("sessionId", sessionID).Msg("Subscribe WebSocket connected (not activated yet)")

	// Track last known message count to detect new messages
	lastMessageCount := 0
	lastTodoCount := 0
	var updateMutex sync.Mutex // Protect concurrent access to lastMessageCount/lastTodoCount

	// Send existing messages immediately on connect
	initialMessages, err := claude.ReadSessionHistory(sessionID, session.WorkingDir)
	if err == nil && len(initialMessages) > 0 {
		log.Debug().
			Str("sessionId", sessionID).
			Int("messageCount", len(initialMessages)).
			Msg("sending initial messages")

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

	// Setup hybrid watcher (fsnotify + polling fallback)
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

	// Helper function to send updates
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

	// Polling + fsnotify goroutine (hybrid approach)
	pollTicker := time.NewTicker(5 * time.Second) // Reduced frequency - fsnotify handles most updates
	defer pollTicker.Stop()

	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)

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

				// Brief delay to ensure readline is fully initialized
				time.Sleep(200 * time.Millisecond)
			}

			// Send message to Claude by writing to PTY
			// Send each character separately to avoid readline paste detection
			// No delay between characters for faster input
			for _, ch := range inMsg.Content {
				charByte := []byte(string(ch))
				if _, err := session.PTY.Write(charByte); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed (char)")
					// Send error back to client
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

			session.LastActivity = time.Now()

			log.Info().
				Str("sessionId", sessionID).
				Str("content", inMsg.Content).
				Msg("message sent to claude session via WebSocket")

		default:
			log.Debug().Str("type", inMsg.Type).Msg("Unknown subscribe message type")
		}
	}

	<-pollDone
	<-pingDone
}
