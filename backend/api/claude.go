package api

import (
	"context"
	"encoding/json"
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
		WorkingDir string `json:"workingDir"`
		Title      string `json:"title"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// Use data directory as default working dir
	if body.WorkingDir == "" {
		body.WorkingDir = config.Get().UserDataDir
	}

	session, err := claudeManager.CreateSession(body.WorkingDir, body.Title)
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

// ClaudeChatWebSocket handles WebSocket connection for chat-style interface
// This endpoint provides a JSON-based protocol on top of the terminal session
func (h *Handlers) ClaudeChatWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

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
			break
		}

		if msgType != websocket.MessageText {
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

		switch inMsg.Type {
		case "user_message":
			// Write user message to PTY (add newline to submit)
			if _, err := session.PTY.Write([]byte(inMsg.Content + "\n")); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed")
				errMsg := ChatMessage{
					Type: "error",
					Data: map[string]string{"message": "Failed to send message"},
				}
				if msgBytes, err := json.Marshal(errMsg); err == nil {
					conn.Write(ctx, websocket.MessageText, msgBytes)
				}
			}
			session.LastActivity = time.Now()

		default:
			log.Debug().Str("type", inMsg.Type).Msg("Unknown chat message type")
		}
	}

	<-sendDone
	<-pingDone
}
