package api

import (
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
		body.WorkingDir = config.Get().DataDir
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

	log.Info().Str("sessionId", sessionID).Msg("WebSocket client connected")

	// Goroutine to send data from client.Send channel to WebSocket
	go func() {
		for data := range client.Send {
			if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
				log.Error().Err(err).Msg("WebSocket write error")
				return
			}
		}
	}()

	// WebSocket → PTY (read from browser, send to claude process)
	for {
		msgType, msg, err := conn.Read(ctx)
		if err != nil {
			log.Info().Str("sessionId", sessionID).Msg("WebSocket client disconnected")
			break
		}

		// Only handle binary messages (terminal I/O)
		if msgType != websocket.MessageBinary {
			continue
		}

		if _, err := session.PTY.Write(msg); err != nil {
			log.Error().Err(err).Msg("PTY write error")
			conn.Close(websocket.StatusInternalError, "PTY write error")
			break
		}

		session.LastActivity = time.Now()
	}
}
