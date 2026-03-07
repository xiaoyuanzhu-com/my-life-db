package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/xiaoyuanzhu-com/my-life-db/claude"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ShareClaudeSession handles POST /api/claude/sessions/:id/share
// Creates or returns an existing share token for the session.
func (h *Handlers) ShareClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	// Check if already shared
	existing, err := db.GetShareToken(sessionID)
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to check share token")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check share status"})
		return
	}
	if existing != "" {
		c.JSON(http.StatusOK, gin.H{
			"shareToken": existing,
			"shareUrl":   "/share/" + existing,
		})
		return
	}

	// Generate new share token
	shareToken := uuid.New().String()
	if err := db.ShareClaudeSession(sessionID, shareToken); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to share session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to share session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"shareToken": shareToken,
		"shareUrl":   "/share/" + shareToken,
	})
}

// UnshareClaudeSession handles DELETE /api/claude/sessions/:id/share
// Removes the share token from a session.
func (h *Handlers) UnshareClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	if err := db.UnshareClaudeSession(sessionID); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to unshare session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unshare session"})
		return
	}

	c.Status(http.StatusNoContent)
}

// GetSharedSession handles GET /api/share/:token
// Returns session metadata for a shared session (no auth required).
func (h *Handlers) GetSharedSession(c *gin.Context) {
	token := c.Param("token")

	sessionID, err := db.GetSessionIDByShareToken(token)
	if err != nil {
		log.Error().Err(err).Str("token", token).Msg("failed to resolve share token")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to resolve share token"})
		return
	}
	if sessionID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Shared session not found"})
		return
	}

	session, err := h.server.Claude().GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	c.JSON(http.StatusOK, session.ToJSON())
}

// GetSharedSessionMessages handles GET /api/share/:token/messages
// Returns messages for a shared session (no auth required).
func (h *Handlers) GetSharedSessionMessages(c *gin.Context) {
	token := c.Param("token")

	sessionID, err := db.GetSessionIDByShareToken(token)
	if err != nil {
		log.Error().Err(err).Str("token", token).Msg("failed to resolve share token")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to resolve share token"})
		return
	}
	if sessionID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Shared session not found"})
		return
	}

	// Set the session ID param and delegate to the existing handler
	c.Params = append(c.Params, gin.Param{Key: "id", Value: sessionID})
	h.GetClaudeSessionMessages(c)
}

// SharedSessionSubscribeWebSocket handles GET /api/share/:token/subscribe
// Read-only WebSocket for shared sessions (no auth required).
// Stripped-down version of ClaudeSubscribeWebSocket: no read state tracking,
// no incoming message processing.
func (h *Handlers) SharedSessionSubscribeWebSocket(c *gin.Context) {
	token := c.Param("token")

	sessionID, err := db.GetSessionIDByShareToken(token)
	if err != nil || sessionID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Shared session not found"})
		return
	}

	session, err := h.server.Claude().GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	// Get the underlying http.ResponseWriter from Gin's wrapper
	var w http.ResponseWriter = c.Writer
	if unwrapper, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		w = unwrapper.Unwrap()
	}

	conn, err := websocket.Accept(w, c.Request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Error().Err(err).Str("token", token).Msg("shared subscribe WebSocket upgrade failed")
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Abort Gin context to prevent middleware from writing headers on hijacked connection
	c.Abort()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Monitor server shutdown context
	go func() {
		select {
		case <-h.server.ShutdownContext().Done():
			log.Debug().Str("token", token).Msg("server shutdown, closing shared subscribe WebSocket")
			cancel()
		case <-ctx.Done():
		}
	}()

	// Load raw messages
	if err := session.LoadRawMessages(); err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to load raw messages for shared session")
	}

	// Send session_info metadata frame
	totalPages := session.TotalPages()
	lowestBurstPage := totalPages - 2
	if lowestBurstPage < 0 {
		lowestBurstPage = 0
	}

	sessionInfo := map[string]any{
		"type":            "session_info",
		"totalPages":      totalPages,
		"lowestBurstPage": lowestBurstPage,
	}
	if infoBytes, err := json.Marshal(sessionInfo); err == nil {
		if err := conn.Write(ctx, websocket.MessageText, infoBytes); err != nil {
			return
		}
	}

	// Send initial burst (last 2 pages)
	burstMessages := session.GetPageRange(lowestBurstPage, totalPages)
	for _, msgBytes := range burstMessages {
		if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
			return
		}
	}

	// Register as broadcast client for live updates
	uiClient := &claude.Client{
		Conn: conn,
		Send: make(chan []byte, 256),
	}
	session.AddClient(uiClient)
	defer session.RemoveClient(uiClient)

	// Forward broadcasts to WebSocket
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
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
						log.Debug().Err(err).Str("token", token).Msg("shared WebSocket write failed")
					}
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

	// Read loop — read-only, ignore all incoming messages but detect close
	for {
		_, _, err := conn.Read(ctx)
		if err != nil {
			cancel()
			break
		}
	}

	<-pollDone
	<-pingDone
}
