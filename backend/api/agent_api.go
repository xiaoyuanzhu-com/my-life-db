package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

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
		Model          string `json:"model"`
		StorageID      string `json:"storageId"` // optional — set when client did an upload first
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.StorageID != "" && !validStorageID(req.StorageID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid storageId"})
		return
	}

	agentTypeStr := req.AgentType
	if agentTypeStr == "" {
		agentTypeStr = "claude_code"
	}

	// Use requested model, or fall back to first gateway model compatible with this agent.
	// Validate req.Model against the current gateway list — a stale value from the
	// client (e.g. cached in localStorage) would otherwise bake a dead model name
	// into ANTHROPIC_MODEL/OPENAI_MODEL at process spawn and fail on first call.
	gatewayModels := h.agentMgr.GatewayModels(agentTypeStr)
	model := req.Model
	if model != "" && len(gatewayModels) > 0 {
		valid := false
		for _, m := range gatewayModels {
			if m.Value == model {
				valid = true
				break
			}
		}
		if !valid {
			log.Warn().Str("requestedModel", model).Str("agentType", agentTypeStr).Msg("requested model not in gateway list, falling back to default")
			model = ""
		}
	}
	if model == "" && len(gatewayModels) > 0 {
		model = gatewayModels[0].Value
	}

	handle, err := h.agentMgr.CreateSession(
		context.Background(), // ACP process must outlive this HTTP request
		SessionParams{
			AgentType:      agentTypeStr,
			WorkingDir:     req.WorkingDir,
			Title:          req.Title,
			Message:        req.Message,
			PermissionMode: req.PermissionMode,
			DefaultModel:   model,
			Source:         "user",
			StorageID:      req.StorageID,
		},
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to create agent session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create agent session: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":         handle.ID,
		"agentType":  agentTypeStr,
		"workingDir": req.WorkingDir,
		"title":      req.Title,
		"storageId":  handle.StorageID,
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
	sessions, err := h.server.AppDB().ListAgentSessions(includeArchived, cursor, limit+1)
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

	// Load read states, runtime states, and persisted result counts for
	// sessionState computation. Persisted counts let the unread (green) dot
	// survive a server restart.
	readStates, _ := h.server.AppDB().GetAllSessionReadStates()
	runtimeStates := h.agentMgr.AllRuntimeStates()
	persistedResultCounts, _ := h.server.AppDB().GetAllSessionResultCounts()

	// Convert to response format matching what the frontend expects
	result := make([]map[string]any, 0, len(sessions))
	for _, s := range sessions {
		rt := runtimeStates[s.SessionID]
		state := computeSessionState(s.ArchivedAt != nil, rt.IsProcessing, s.LastTurnOutcome)
		hasUnread := computeHasUnread(s.SessionID, readStates, runtimeStates, persistedResultCounts)

		entry := map[string]any{
			"id":               s.SessionID,
			"title":            s.Title,
			"workingDir":       s.WorkingDir,
			"agentType":        s.AgentType,
			"sessionState":     state,
			"hasUnread":        hasUnread,
			"lastTurnOutcome":  s.LastTurnOutcome,
			"lastErrorMessage": s.LastErrorMessage,
			"createdAt":        s.CreatedAt,
			"lastActivity":     s.UpdatedAt,
			"source":           s.Source,
			"storageId":        s.StorageID,
		}
		if s.LastTurnOutcomeAt != nil {
			entry["lastTurnOutcomeAt"] = *s.LastTurnOutcomeAt
		}
		if s.GroupID != nil {
			entry["groupId"] = *s.GroupID
		}
		if s.PinnedAt != nil {
			entry["pinnedAt"] = *s.PinnedAt
		}
		if s.AgentName != "" {
			entry["agentName"] = s.AgentName
		}
		if s.TriggerKind != "" {
			entry["triggerKind"] = s.TriggerKind
		}
		if s.TriggerData != "" {
			// Parse on the wire so the frontend gets a structured object
			// instead of having to JSON.parse twice.
			var td map[string]any
			if err := json.Unmarshal([]byte(s.TriggerData), &td); err == nil {
				entry["triggerData"] = td
			}
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

	session, err := h.server.AppDB().GetAgentSession(sessionID)
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
	readStates, _ := h.server.AppDB().GetAllSessionReadStates()
	runtimeStates := h.agentMgr.AllRuntimeStates()
	persistedResultCounts, _ := h.server.AppDB().GetAllSessionResultCounts()
	rt := runtimeStates[session.SessionID]
	state := computeSessionState(session.ArchivedAt != nil, rt.IsProcessing, session.LastTurnOutcome)
	hasUnread := computeHasUnread(session.SessionID, readStates, runtimeStates, persistedResultCounts)

	resp := gin.H{
		"id":               session.SessionID,
		"title":            session.Title,
		"workingDir":       session.WorkingDir,
		"agentType":        session.AgentType,
		"sessionState":     state,
		"hasUnread":        hasUnread,
		"lastTurnOutcome":  session.LastTurnOutcome,
		"lastErrorMessage": session.LastErrorMessage,
		"createdAt":        session.CreatedAt,
		"lastActivity":     session.UpdatedAt,
		"source":           session.Source,
		"storageId":        session.StorageID,
	}
	if session.LastTurnOutcomeAt != nil {
		resp["lastTurnOutcomeAt"] = *session.LastTurnOutcomeAt
	}
	if session.GroupID != nil {
		resp["groupId"] = *session.GroupID
	}
	if session.PinnedAt != nil {
		resp["pinnedAt"] = *session.PinnedAt
	}
	if session.AgentName != "" {
		resp["agentName"] = session.AgentName
	}
	if session.TriggerKind != "" {
		resp["triggerKind"] = session.TriggerKind
	}
	if session.TriggerData != "" {
		var td map[string]any
		if err := json.Unmarshal([]byte(session.TriggerData), &td); err == nil {
			resp["triggerData"] = td
		}
	}
	c.JSON(http.StatusOK, resp)
}

// UpdateAgentSession updates session metadata: title, group assignment, and
// pin state. Each field is independently optional — only fields whose pointers
// are non-nil are applied. (For Title, an empty pointer is also a no-op.)
//
// PATCH /api/agent/sessions/:id
//
//	body: {
//	  "title":   "..."          (string, optional)
//	  "groupId": "..." | null    (string|null, optional)
//	  "pinned":  true|false      (bool, optional)
//	}
func (h *Handlers) UpdateAgentSession(c *gin.Context) {
	sessionID := c.Param("id")

	// Use json.RawMessage / pointer fields so we can distinguish "absent" from
	// "explicit null" — needed for groupId where null = move to ungrouped.
	var req struct {
		Title        *string `json:"title"`
		GroupID      *string `json:"groupId"`
		Pinned       *bool   `json:"pinned"`
		ClearOutcome *bool   `json:"clearOutcome"`
	}
	// Capture which keys were present so a `"groupId": null` clears the group
	// while an absent `groupId` is a no-op. ShouldBindJSON alone can't tell
	// them apart for *string, so we re-parse the raw body for key detection.
	rawBody, _ := c.GetRawData()
	if err := json.Unmarshal(rawBody, &req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var keys map[string]json.RawMessage
	_ = json.Unmarshal(rawBody, &keys)

	if req.Title != nil && *req.Title != "" {
		if err := h.server.AppDB().UpdateAgentSessionTitle(c.Request.Context(), sessionID, *req.Title); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to update session title")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update session"})
			return
		}
	}

	if _, hasGroupID := keys["groupId"]; hasGroupID {
		groupID := ""
		if req.GroupID != nil {
			groupID = *req.GroupID
		}
		if groupID != "" {
			// Validate that the target group exists, otherwise the update is silently a no-op.
			g, err := h.server.AppDB().GetAgentSessionGroup(groupID)
			if err != nil {
				log.Error().Err(err).Str("groupId", groupID).Msg("failed to look up group")
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update session"})
				return
			}
			if g == nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "group not found"})
				return
			}
		}
		if err := h.server.AppDB().SetAgentSessionGroup(c.Request.Context(), sessionID, groupID); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to set session group")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update session"})
			return
		}
	}

	if req.Pinned != nil {
		if err := h.server.AppDB().SetAgentSessionPinned(c.Request.Context(), sessionID, *req.Pinned); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to set session pinned")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update session"})
			return
		}
	}

	if req.ClearOutcome != nil && *req.ClearOutcome {
		if err := h.server.AppDB().ClearLastOutcome(c.Request.Context(), sessionID); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to clear last outcome")
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
	if err := h.server.AppDB().ArchiveAgentSession(c.Request.Context(), sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to archive session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// UnarchiveAgentSession unarchives a session.
// POST /api/agent/sessions/:id/unarchive
func (h *Handlers) UnarchiveAgentSession(c *gin.Context) {
	sessionID := c.Param("id")
	if err := h.server.AppDB().UnarchiveAgentSession(c.Request.Context(), sessionID); err != nil {
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
	if err := h.server.AppDB().ShareAgentSession(c.Request.Context(), sessionID, shareToken); err != nil {
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
	if err := h.server.AppDB().UnshareAgentSession(c.Request.Context(), sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to unshare session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GetAgentMessages returns messages for a session (for debugging).
// GET /api/agent/sessions/:id/messages
func (h *Handlers) GetAgentMessages(c *gin.Context) {
	sessionID := c.Param("id")
	ss := h.agentMgr.GetOrCreateState(sessionID)
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

// GetAgentTurns returns turn summaries for a session.
// GET /api/agent/sessions/:id/turns
func (h *Handlers) GetAgentTurns(c *gin.Context) {
	sessionID := c.Param("id")
	ss := h.agentMgr.GetOrCreateState(sessionID)

	// If session has no messages in memory, try loading from disk first.
	if ss.MessageCount() == 0 {
		if fs := h.server.FrameStore(); fs != nil {
			if frames, err := fs.Load(sessionID); err == nil && len(frames) > 0 {
				ss.LoadHistoricalFrames(frames)
			}
		}
	}

	raw := ss.GetRecentMessages(0)
	log.Info().Str("sessionId", sessionID).Int("frameCount", len(raw)).Msg("GetAgentTurns: starting frame parse")

	type TurnSummary struct {
		TurnNumber int    `json:"turnNumber"`
		Question   string `json:"question"`
		StopReason string `json:"stopReason,omitempty"`
	}

	var turns []TurnSummary
	turnNum := 0
	inTurn := false
	var currentQuestion string
	var currentStopReason string

	for _, data := range raw {
		var frame map[string]any
		if err := json.Unmarshal(data, &frame); err != nil {
			continue
		}

		// ACP-native frames use sessionUpdate; host-synthesized frames use type.
		ft, _ := frame["type"].(string)
		if ft == "" {
			ft, _ = frame["sessionUpdate"].(string)
		}

		switch ft {
		case "turn.start":
			turnNum++
			inTurn = true
			currentQuestion = ""
			currentStopReason = ""
		case "user_message_chunk":
			if inTurn && currentQuestion == "" {
				log.Info().Str("sessionId", sessionID).Int("turnNum", turnNum).Interface("content", frame["content"]).Msg("GetAgentTurns: user_message_chunk content")
				currentQuestion = extractContentText(frame["content"])
				log.Info().Str("sessionId", sessionID).Int("turnNum", turnNum).Str("extracted", currentQuestion).Msg("GetAgentTurns: extracted question")
			}
		case "turn.complete":
			if inTurn {
				if sr, ok := frame["stopReason"].(string); ok {
					currentStopReason = sr
				}
				if currentQuestion == "" {
					currentQuestion = "(non-text prompt)"
				}
				if len([]rune(currentQuestion)) > 80 {
					q := []rune(currentQuestion)
					currentQuestion = string(q[:80]) + "..."
				}
				turns = append(turns, TurnSummary{
					TurnNumber: turnNum,
					Question:   currentQuestion,
					StopReason: currentStopReason,
				})
				inTurn = false
				currentQuestion = ""
				currentStopReason = ""
			}
		}
	}
	// Include in-progress turn if session is active
	if inTurn && currentQuestion != "" {
		turns = append(turns, TurnSummary{TurnNumber: turnNum, Question: currentQuestion})
	}

	log.Info().Str("sessionId", sessionID).Int("turnCount", len(turns)).Msg("GetAgentTurns: done")
	c.JSON(http.StatusOK, gin.H{"turns": turns})
}

// extractContentText pulls the first text snippet from a ContentBlock.
// Content may be a single object {type, text} or an array [{type, text}, ...].
func extractContentText(content any) string {
	switch c := content.(type) {
	case map[string]any:
		if text, ok := c["text"].(string); ok && text != "" {
			return text
		}
	case []any:
		for _, item := range c {
			if obj, ok := item.(map[string]any); ok {
				if text, ok := obj["text"].(string); ok && text != "" {
					return text
				}
			}
		}
	}
	return ""
}

// DeactivateAgentSession is a no-op for ACP sessions (they're ephemeral).
// POST /api/agent/sessions/:id/deactivate
func (h *Handlers) DeactivateAgentSession(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// RestartAgentSession kills the live ACP process and resets runtime state
// so the session can start fresh. The DB record is preserved.
// POST /api/agent/sessions/:id/restart
func (h *Handlers) RestartAgentSession(c *gin.Context) {
	sessionID := c.Param("id")

	// Verify session exists in DB
	session, err := h.server.AppDB().GetAgentSession(sessionID)
	if err != nil || session == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}

	if err := h.agentMgr.RestartSession(sessionID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// computeSessionState derives the unified session lifecycle state. Returns one
// of: 'archived' | 'working' | 'idle' | 'interrupted' | 'cancelled' | 'error'.
//
// Priority (top wins):
//   - 'archived':    archived_at != null
//   - 'working':     in-memory IsProcessing == true
//   - 'interrupted': last_turn_outcome == 'interrupted' (set by the boot sweep
//                    when a previous server instance was killed mid-turn)
//   - 'cancelled':   last_turn_outcome == 'cancelled'  (user stopped the turn)
//   - 'error':       last_turn_outcome == 'errored'    (note: verb→noun at API)
//   - 'idle':        anything else (covers 'completed' and '')
//
// The 'unread' view-state is intentionally NOT in this enum — see computeHasUnread.
func computeSessionState(
	isArchived bool,
	isProcessing bool,
	lastTurnOutcome string,
) string {
	if isArchived {
		return "archived"
	}
	if isProcessing {
		return "working"
	}
	switch lastTurnOutcome {
	case "interrupted":
		return "interrupted"
	case "cancelled":
		return "cancelled"
	case "errored":
		return "error"
	}
	return "idle"
}

// computeHasUnread returns true when the session has completed turns the user
// hasn't seen yet. Effective ResultCount prefers the in-memory counter and
// falls back to the persisted result_count so the unread signal survives a
// server restart.
func computeHasUnread(
	sessionID string,
	readStates map[string]int,
	runtimeStates map[string]SessionRuntimeState,
	persistedResultCounts map[string]int,
) bool {
	rt, hasRuntime := runtimeStates[sessionID]
	effectiveCount := 0
	if hasRuntime {
		effectiveCount = rt.ResultCount
	}
	if effectiveCount == 0 {
		effectiveCount = persistedResultCounts[sessionID]
	}
	if effectiveCount == 0 {
		return false
	}
	return effectiveCount > readStates[sessionID]
}
