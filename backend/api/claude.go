package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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
		InsecureSkipVerify: true, // Skip origin check - auth is handled at higher layer
	})
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("WebSocket upgrade failed")
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx := c.Request.Context()

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
		for data := range client.Send {
			if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("WebSocket write failed")
				return
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
			// Silent disconnect - normal for page refresh, tab close, etc.
			break
		}

		// Only handle binary messages (terminal I/O)
		if msgType != websocket.MessageBinary {
			continue
		}

		// Log what xterm is sending
		log.Info().
			Str("sessionId", sessionID).
			Str("source", "xterm").
			Str("data", string(msg)).
			Int("length", len(msg)).
			Str("hex", fmt.Sprintf("%x", msg)).
			Msg("xterm → PTY")

		if _, err := session.PTY.Write(msg); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed")
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
	activeSessionIDs := make(map[string]bool)
	activeSessions := claudeManager.ListSessions()
	for _, s := range activeSessions {
		activeSessionIDs[s.ID] = true
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

		// If session is active, add additional live data
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

	// Try to get project path from active session first
	var projectPath string
	session, err := claudeManager.GetSession(sessionID)
	if err == nil {
		projectPath = session.WorkingDir
	} else {
		// If not in active sessions, try to find it in Claude's session files
		// Use empty project path - the reader will search all projects
		projectPath = ""
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
	if err := session.EnsureActivated(); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to activate session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to activate session"})
		return
	}

	// Send message to Claude by writing to PTY
	// Send each character separately to avoid readline paste detection
	messageWithNewline := req.Content + "\n"
	for _, ch := range messageWithNewline {
		charByte := []byte(string(ch))
		if _, err := session.PTY.Write(charByte); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to send message to session"})
			return
		}
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

// ClaudeChatWebSocket handles WebSocket connection for chat-style interface
// This endpoint provides a JSON-based protocol on top of the terminal session
func (h *Handlers) ClaudeChatWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	// GetSession will auto-resume from history if not active
	session, err := claudeManager.GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

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
		log.Error().Err(err).Str("sessionId", sessionID).Msg("Chat WebSocket upgrade failed")
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx := c.Request.Context()

	// Ensure session is activated before proceeding
	if err := session.EnsureActivated(); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to activate session")
		conn.Close(websocket.StatusInternalError, "Failed to activate session")
		return
	}

	// Send connected message
	connectedMsg := ChatMessage{
		Type: "connected",
		Data: map[string]interface{}{
			"sessionId":  sessionID,
			"workingDir": session.WorkingDir,
		},
	}
	if msgBytes, err := json.Marshal(connectedMsg); err == nil {
		conn.Write(ctx, websocket.MessageText, msgBytes)
	}

	// Create a client to receive PTY output
	client := &claude.Client{
		Conn: conn,
		Send: make(chan []byte, 256),
	}
	session.AddClient(client)
	defer session.RemoveClient(client)

	// Goroutine to forward PTY output as text_delta messages
	sendDone := make(chan struct{})
	go func() {
		defer close(sendDone)
		for data := range client.Send {
			// Forward terminal output as text_delta
			// Note: This is raw terminal output, not parsed Claude responses
			msg := ChatMessage{
				Type: "text_delta",
				Data: map[string]interface{}{
					"delta": string(data),
					"raw":   true, // Indicates this is raw terminal output
				},
			}
			if msgBytes, err := json.Marshal(msg); err == nil {
				if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
					log.Debug().Err(err).Str("sessionId", sessionID).Msg("Chat WebSocket write failed")
					return
				}
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

	// Read messages from client
	for {
		msgType, msg, err := conn.Read(ctx)
		if err != nil {
			log.Info().Err(err).Str("sessionId", sessionID).Msg("Chat WebSocket read error (client disconnected)")
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
			log.Debug().Err(err).Msg("Failed to parse chat message")
			continue
		}

		log.Info().Str("sessionId", sessionID).Str("type", inMsg.Type).Msg("Received chat message")

		switch inMsg.Type {
		case "user_message":
			// Send each character separately to avoid readline paste detection
			// No delay between characters for faster input
			for _, ch := range inMsg.Content {
				charByte := []byte(string(ch))
				log.Info().
					Str("sessionId", sessionID).
					Str("source", "chat").
					Str("char", string(ch)).
					Str("hex", fmt.Sprintf("%x", charByte)).
					Msg("chat → PTY (char)")
				if _, err := session.PTY.Write(charByte); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed (char)")
					break
				}
			}

			// Small delay before Enter to ensure readline processes the input correctly
			time.Sleep(50 * time.Millisecond)
			log.Info().
				Str("sessionId", sessionID).
				Str("source", "chat").
				Str("hex", "0d").
				Msg("chat → PTY (enter)")
			if _, err := session.PTY.Write([]byte("\r")); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed (enter)")
			}

			session.LastActivity = time.Now()

		default:
			log.Debug().Str("type", inMsg.Type).Msg("Unknown chat message type")
		}
	}

	<-sendDone
	<-pingDone
}
