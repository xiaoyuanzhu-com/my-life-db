package api

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// GetSharedSession handles GET /api/share/:token
// Returns session metadata for a shared session (no auth required).
func (h *Handlers) GetSharedSession(c *gin.Context) {
	token := c.Param("token")

	sessionID, err := h.server.DB().GetSessionIDByShareToken(token)
	if err != nil {
		log.Error().Err(err).Str("token", token).Msg("failed to resolve share token")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to resolve share token"})
		return
	}
	if sessionID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Shared session not found"})
		return
	}

	session, err := h.server.DB().GetAgentSession(sessionID)
	if err != nil || session == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	state := "idle"
	if session.ArchivedAt != nil {
		state = "archived"
	}

	c.JSON(http.StatusOK, gin.H{
		"id":           session.SessionID,
		"title":        session.Title,
		"workingDir":   session.WorkingDir,
		"agentType":    session.AgentType,
		"sessionState": state,
		"createdAt":    session.CreatedAt,
		"lastActivity": session.UpdatedAt,
	})
}

// GetSharedSessionMessages handles GET /api/share/:token/messages
// Returns messages for a shared session (no auth required).
func (h *Handlers) GetSharedSessionMessages(c *gin.Context) {
	token := c.Param("token")

	sessionID, err := h.server.DB().GetSessionIDByShareToken(token)
	if err != nil {
		log.Error().Err(err).Str("token", token).Msg("failed to resolve share token")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to resolve share token"})
		return
	}
	if sessionID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Shared session not found"})
		return
	}

	// Delegate to the agent messages handler
	c.Params = append(c.Params, gin.Param{Key: "id", Value: sessionID})
	h.GetAgentMessages(c)
}

// SharedSessionSubscribeWebSocket handles GET /api/share/:token/subscribe
// Read-only WebSocket for shared sessions (no auth required).
// Uses the agent session state for message broadcast.
func (h *Handlers) SharedSessionSubscribeWebSocket(c *gin.Context) {
	token := c.Param("token")

	sessionID, err := h.server.DB().GetSessionIDByShareToken(token)
	if err != nil || sessionID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Shared session not found"})
		return
	}

	sessionState := h.agentMgr.GetOrCreateState(sessionID)

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

	// Register client with cursor at 0 to replay all stored messages,
	// then pick up live frames via notification.
	uiClient := agentsdk.NewWSClient(uuid.New().String(), 0)
	sessionState.AddClient(uiClient)
	defer sessionState.RemoveClient(uiClient)

	// Write loop: drains rawMessages from cursor position at its own pace.
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		for {
			msgs := sessionState.Drain(uiClient)
			for _, data := range msgs {
				if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
					if ctx.Err() == nil {
						log.Debug().Err(err).Str("token", token).Msg("shared WebSocket write failed")
					}
					return
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-uiClient.Notify:
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
