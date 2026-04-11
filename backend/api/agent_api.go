package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
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

// CreateAgentSession creates a new agent session by eagerly spawning the ACP
// agent process. The ACP session ID becomes the DB primary key.
// POST /api/agent/sessions
func (h *Handlers) CreateAgentSession(c *gin.Context) {
	var req struct {
		Title          string `json:"title"`
		Message        string `json:"message"`
		WorkingDir     string `json:"workingDir"`
		AgentType      string `json:"agentType"`
		PermissionMode string `json:"permissionMode"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Map agentType string to agentsdk.AgentType
	agentTypeStr := req.AgentType
	if agentTypeStr == "" {
		agentTypeStr = "claude_code"
	}
	agentType := agentsdk.AgentClaudeCode
	if agentTypeStr == "codex" {
		agentType = agentsdk.AgentCodex
	}

	// Spawn ACP agent process eagerly.
	// Use background context — the ACP process must outlive this HTTP request.
	sess, err := h.server.AgentClient().CreateSession(context.Background(), agentsdk.SessionConfig{
		Agent:      agentType,
		Mode:       req.PermissionMode,
		WorkingDir: req.WorkingDir,
	})
	if err != nil {
		log.Error().Err(err).Msg("failed to create ACP session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create agent session: " + err.Error()})
		return
	}

	// Use ACP session ID as DB primary key
	sessionID := sess.ID()

	if err := db.CreateAgentSession(sessionID, agentTypeStr, req.WorkingDir, req.Title, "user", ""); err != nil {
		log.Error().Err(err).Msg("failed to create agent session in DB")
		sess.Close()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create session"})
		return
	}

	// Save permission mode if provided
	if req.PermissionMode != "" {
		db.SaveAgentSessionPermissionMode(sessionID, req.PermissionMode)
	}

	// Wire onFrame BEFORE storing — ensures any Send() (from here or from the
	// WebSocket handler) delivers agent_message_chunk frames to connected clients.
	sessionState := GetOrCreateSessionState(sessionID)
	sess.SetOnFrame(func(data []byte) {
		sessionState.AppendAndBroadcast(data)
	})

	// Set mode AFTER onFrame so the mode-change event is captured and forwarded
	if req.PermissionMode != "" {
		if err := sess.SetMode(context.Background(), req.PermissionMode); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Str("mode", req.PermissionMode).Msg("failed to set initial mode")
		}
	}

	// Store the ACP session in the in-memory map so the WS handler can find it
	StoreAcpSession(sessionID, sess)

	log.Info().
		Str("sessionId", sessionID).
		Str("agentType", agentTypeStr).
		Str("workingDir", req.WorkingDir).
		Msg("created agent session with ACP session ID as primary key")

	// If a message was provided, start processing it in a background goroutine
	if req.Message != "" {
		// Synthesize user_message_chunk BEFORE Send() so the user's message
		// is in rawMessages for burst replay on page refresh. ACP does not
		// echo user messages during live Prompt() calls.
		sessionState.AppendAndBroadcast(agentsdk.SynthUserMessageChunk(req.Message))

		// Send prompt and forward raw frames in a background goroutine
		go func(acpSess agentsdk.Session, prompt string) {
			// Mark processing BEFORE Send() so any WS client connecting
			// between turn.start and the first event sees the correct state.
			sessionState.Mu.Lock()
			sessionState.IsProcessing = true
			sessionState.IsActive = true
			sessionState.Mu.Unlock()
			h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "working")

			// Create a cancellable context so we can abort if the process exits.
			ctx, cancel := context.WithCancel(h.server.ShutdownContext())
			defer cancel()

			// Monitor process exit — cancel prompt context if process dies,
			// which unblocks Prompt() and causes the events channel to close.
			go func() {
				select {
				case <-acpSess.Done():
					log.Info().Str("sessionId", sessionID).Msg("agent process exited during initial prompt")
					cancel()
				case <-ctx.Done():
				}
			}()

			events, err := acpSess.Send(ctx, prompt)
			if err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send initial prompt to ACP session")
				sessionState.Mu.Lock()
				sessionState.IsProcessing = false
				sessionState.Mu.Unlock()
				if errBytes, err := json.Marshal(map[string]any{
					"type": "error", "message": "Failed to send message: " + err.Error(), "code": "SEND_ERROR",
				}); err == nil {
					sessionState.AppendAndBroadcast(errBytes)
				}
				h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "result")
				return
			}

			for frame := range events {
				sessionState.AppendAndBroadcast(frame)
			}
			// Channel closed = turn complete
			sessionState.Mu.Lock()
			sessionState.ResultCount++
			sessionState.IsProcessing = false
			sessionState.Mu.Unlock()
			h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "result")
		}(sess, req.Message)

		log.Info().
			Str("sessionId", sessionID).
			Str("prompt", req.Message).
			Msg("initial prompt sent to agent session during creation")
	}

	c.JSON(http.StatusOK, gin.H{
		"id":         sessionID,
		"agentType":  agentTypeStr,
		"workingDir": req.WorkingDir,
		"title":      req.Title,
	})
}

// GetAgentSessions lists agent sessions from the DB with cursor-based pagination.
// GET /api/agent/sessions, GET /api/agent/sessions/all
//
// Query params:
//   - status: "active" (default), "archived", or "all"
//   - limit:  page size (default 50)
//   - cursor: updated_at of the last item from the previous page
func (h *Handlers) GetAgentSessions(c *gin.Context) {
	statusFilter := c.DefaultQuery("status", "active")
	includeArchived := statusFilter == "all" || statusFilter == "archived"

	limit := 50
	if l, err := strconv.Atoi(c.DefaultQuery("limit", "50")); err == nil && l > 0 {
		limit = l
	}

	var cursor int64
	if cs := c.Query("cursor"); cs != "" {
		if v, err := strconv.ParseInt(cs, 10, 64); err == nil {
			cursor = v
		}
	}

	// Fetch limit+1 to determine if there are more results
	sessions, err := db.ListAgentSessions(includeArchived, cursor, limit+1)
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

	hasMore := len(sessions) > limit
	if hasMore {
		sessions = sessions[:limit]
	}

	// Load read states and runtime states for sessionState computation
	readStates, _ := db.GetAllSessionReadStates()
	runtimeStates := GetAllSessionRuntimeStates()

	// Convert to response format matching what the frontend expects
	result := make([]map[string]any, 0, len(sessions))
	for _, s := range sessions {
		state := computeSessionState(s.SessionID, s.ArchivedAt != nil, readStates, runtimeStates)

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

	// Build pagination response
	var nextCursor any
	if hasMore && len(sessions) > 0 {
		nextCursor = strconv.FormatInt(sessions[len(sessions)-1].UpdatedAt, 10)
	}

	c.JSON(http.StatusOK, gin.H{
		"sessions": result,
		"pagination": gin.H{
			"hasMore":    hasMore,
			"nextCursor": nextCursor,
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

	// Compute state using same logic as list endpoint
	readStates, _ := db.GetAllSessionReadStates()
	runtimeStates := GetAllSessionRuntimeStates()
	state := computeSessionState(session.SessionID, session.ArchivedAt != nil, readStates, runtimeStates)

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


// ArchiveAgentSession archives a session.
// POST /api/agent/sessions/:id/archive
func (h *Handlers) ArchiveAgentSession(c *gin.Context) {
	sessionID := c.Param("id")
	if err := db.ArchiveAgentSession(sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to archive session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// UnarchiveAgentSession unarchives a session.
// POST /api/agent/sessions/:id/unarchive
func (h *Handlers) UnarchiveAgentSession(c *gin.Context) {
	sessionID := c.Param("id")
	if err := db.UnarchiveAgentSession(sessionID); err != nil {
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
	if err := db.ShareAgentSession(sessionID, shareToken); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to share session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"shareToken": shareToken,
		"shareUrl":   "/share/" + shareToken,
	})
}

// UnshareAgentSession removes the share token.
// DELETE /api/agent/sessions/:id/share
func (h *Handlers) UnshareAgentSession(c *gin.Context) {
	sessionID := c.Param("id")
	if err := db.UnshareAgentSession(sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to unshare session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GetAgentMessages returns messages for a session (for debugging).
// GET /api/agent/sessions/:id/messages
func (h *Handlers) GetAgentMessages(c *gin.Context) {
	sessionID := c.Param("id")
	ss := GetOrCreateSessionState(sessionID)
	raw := ss.GetRecentMessages(0) // 0 = all messages

	// Write a JSON array of raw JSON objects directly.
	c.Header("Content-Type", "application/json")
	c.Writer.WriteString("[")
	for i, msg := range raw {
		if i > 0 {
			c.Writer.WriteString(",")
		}
		c.Writer.Write(msg)
	}
	c.Writer.WriteString("]")
}

// DeactivateAgentSession is a no-op for ACP sessions (they're ephemeral).
// POST /api/agent/sessions/:id/deactivate
func (h *Handlers) DeactivateAgentSession(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// computeSessionState derives a unified session state string from archived flag,
// DB read state, and in-memory runtime state.
//
// Priority: archived > working > unread > idle
//   - "archived": session is archived
//   - "working":  agent is actively processing (IsProcessing=true)
//   - "unread":   agent finished but user hasn't viewed results (ResultCount > lastReadCount)
//   - "idle":     all caught up
func computeSessionState(
	sessionID string,
	isArchived bool,
	readStates map[string]int,
	runtimeStates map[string]struct{ IsProcessing bool; ResultCount int },
) string {
	if isArchived {
		return "archived"
	}

	rt, hasRuntime := runtimeStates[sessionID]
	if hasRuntime && rt.IsProcessing {
		return "working"
	}

	// Check for unread results: ResultCount (in-memory) > last_read_count (DB)
	if hasRuntime && rt.ResultCount > 0 {
		lastRead := readStates[sessionID] // 0 if not found
		if rt.ResultCount > lastRead {
			return "unread"
		}
	}

	return "idle"
}
