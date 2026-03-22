package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// GetAgentInfo returns available agents and their metadata.
// GET /api/agent/info
func (h *Handlers) GetAgentInfo(c *gin.Context) {
	agents := h.server.AgentClient().AvailableAgents()

	type agentResponse struct {
		Type    string `json:"type"`
		Name    string `json:"name"`
		Version string `json:"version,omitempty"`
	}

	var resp []agentResponse
	for _, a := range agents {
		resp = append(resp, agentResponse{
			Type:    string(a.Type),
			Name:    a.Name,
			Version: a.Version,
		})
	}

	c.JSON(http.StatusOK, gin.H{"agents": resp})
}

// CreateAgentSession creates a new agent session record in the DB.
// The ACP session is created lazily on first WebSocket message.
// POST /api/agent/sessions
func (h *Handlers) CreateAgentSession(c *gin.Context) {
	var req struct {
		Title          string `json:"title"`
		WorkingDir     string `json:"workingDir"`
		AgentType      string `json:"agentType"`
		PermissionMode string `json:"permissionMode"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	sessionID := uuid.New().String()
	agentType := req.AgentType
	if agentType == "" {
		agentType = "claude_code"
	}

	if err := db.CreateAgentSession(sessionID, agentType, req.WorkingDir, req.Title); err != nil {
		log.Error().Err(err).Msg("failed to create agent session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create session"})
		return
	}

	// Save permission mode if provided
	if req.PermissionMode != "" {
		db.SaveClaudeSessionPermissionMode(sessionID, req.PermissionMode)
	}

	log.Info().
		Str("sessionId", sessionID).
		Str("agentType", agentType).
		Str("workingDir", req.WorkingDir).
		Msg("created agent session")

	c.JSON(http.StatusOK, gin.H{
		"id":         sessionID,
		"agentType":  agentType,
		"workingDir": req.WorkingDir,
		"title":      req.Title,
	})
}

// GetAgentSessions lists agent sessions from the DB.
// GET /api/agent/sessions, GET /api/agent/sessions/all
func (h *Handlers) GetAgentSessions(c *gin.Context) {
	statusFilter := c.DefaultQuery("status", "active")
	includeArchived := statusFilter == "all" || statusFilter == "archived"

	sessions, err := db.ListAgentSessions(includeArchived)
	if err != nil {
		log.Error().Err(err).Msg("failed to list agent sessions")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list sessions"})
		return
	}

	// Filter archived-only if requested
	if statusFilter == "archived" {
		var archived []db.AgentSessionRecord
		for _, s := range sessions {
			if s.ArchivedAt != nil {
				archived = append(archived, s)
			}
		}
		sessions = archived
	}

	// Load read states for unread tracking
	readStates, _ := db.GetAllSessionReadStates()

	// Convert to response format matching what the frontend expects
	result := make([]map[string]any, 0, len(sessions))
	for _, s := range sessions {
		state := "idle"
		if s.ArchivedAt != nil {
			state = "archived"
		} else if readCount, ok := readStates[s.SessionID]; ok {
			// If there are results the user hasn't seen, mark unread
			// (simplified — the old code checked IsProcessing too)
			_ = readCount
		}

		entry := map[string]any{
			"id":           s.SessionID,
			"title":        s.Title,
			"workingDir":   s.WorkingDir,
			"agentType":    s.AgentType,
			"sessionState": state,
			"createdAt":    s.CreatedAt,
			"lastActivity": s.UpdatedAt,
		}
		result = append(result, entry)
	}

	c.JSON(http.StatusOK, gin.H{
		"sessions": result,
		"pagination": gin.H{
			"hasMore":    false,
			"nextCursor": nil,
			"totalCount": len(result),
		},
	})
}

// GetAgentSession returns a single session record.
// GET /api/agent/sessions/:id
func (h *Handlers) GetAgentSession(c *gin.Context) {
	sessionID := c.Param("id")

	session, err := db.GetAgentSession(sessionID)
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to get agent session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get session"})
		return
	}
	if session == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
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

// UpdateAgentSession updates session metadata (title).
// PATCH /api/agent/sessions/:id
func (h *Handlers) UpdateAgentSession(c *gin.Context) {
	sessionID := c.Param("id")

	var req struct {
		Title string `json:"title"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Title != "" {
		if err := db.UpdateAgentSessionTitle(sessionID, req.Title); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to update session title")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update session"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeleteAgentSession deletes a session record.
// DELETE /api/agent/sessions/:id
func (h *Handlers) DeleteAgentSession(c *gin.Context) {
	sessionID := c.Param("id")

	// Delete from DB (simple DELETE — the old handler also cleaned up the Claude session manager)
	_, err := db.Run("DELETE FROM agent_sessions WHERE session_id = ?", sessionID)
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to delete agent session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ArchiveAgentSession archives a session.
// POST /api/agent/sessions/:id/archive
func (h *Handlers) ArchiveAgentSession(c *gin.Context) {
	sessionID := c.Param("id")
	if err := db.ArchiveClaudeSession(sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to archive session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// UnarchiveAgentSession unarchives a session.
// POST /api/agent/sessions/:id/unarchive
func (h *Handlers) UnarchiveAgentSession(c *gin.Context) {
	sessionID := c.Param("id")
	if err := db.UnarchiveClaudeSession(sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to unarchive session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ShareAgentSession creates a share token for a session.
// POST /api/agent/sessions/:id/share
func (h *Handlers) ShareAgentSession(c *gin.Context) {
	sessionID := c.Param("id")
	shareToken := uuid.New().String()
	if err := db.ShareClaudeSession(sessionID, shareToken); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to share session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"shareToken": shareToken,
		"shareUrl":   "/shared/claude/" + shareToken,
	})
}

// UnshareAgentSession removes the share token.
// DELETE /api/agent/sessions/:id/share
func (h *Handlers) UnshareAgentSession(c *gin.Context) {
	sessionID := c.Param("id")
	if err := db.UnshareClaudeSession(sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to unshare session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GetAgentMessages returns messages for a session.
// GET /api/agent/sessions/:id/messages
func (h *Handlers) GetAgentMessages(c *gin.Context) {
	// Messages are stored in-memory (SessionState) and replayed via WebSocket.
	// This endpoint returns an empty list — the WS connection handles history.
	c.JSON(http.StatusOK, gin.H{"messages": []any{}})
}

// DeactivateAgentSession is a no-op for ACP sessions (they're ephemeral).
// POST /api/agent/sessions/:id/deactivate
func (h *Handlers) DeactivateAgentSession(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
