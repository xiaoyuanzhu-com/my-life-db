package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
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
	session, err := h.server.Claude().CreateSessionWithID(body.WorkingDir, body.Title, body.ResumeSessionID, permissionMode)
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

	// Load read states for unread result tracking
	readResultCounts, err := db.GetAllSessionReadStates()
	if err != nil {
		log.Warn().Err(err).Msg("failed to load session read states")
		readResultCounts = make(map[string]int)
	}

	log.Debug().
		Int("returnedCount", len(paginationResult.Sessions)).
		Int("totalCount", paginationResult.TotalCount).
		Bool("hasMore", paginationResult.HasMore).
		Str("cursor", cursor).
		Str("statusFilter", statusFilter).
		Msg("ListAllClaudeSessions: fetching sessions with pagination")

	// Convert Session to response format
	result := make([]map[string]interface{}, 0, len(paginationResult.Sessions))
	for _, session := range paginationResult.Sessions {
		// Compute unified session state (mutually exclusive):
		//   "archived" — user explicitly archived this session
		//   "working"  — Claude is mid-turn (including sub-agents/tool use)
		//   "unread"   — there are unseen *result* messages (completed turns) or
		//                unseen pending permissions the user hasn't viewed yet.
		//                Both result messages and permissions use the same "seen"
		//                pattern: opening the session marks everything as seen;
		//                new items arriving after the user closes make it unread again.
		//   "idle"     — nothing happening, user is up to date
		sessionState := "idle"
		if session.IsArchived {
			sessionState = "archived"
		} else if session.IsProcessing() && !session.HasPendingPermission() {
			sessionState = "working"
		} else if session.IsProcessing() && session.HasUnseenPermission() {
			// Mid-turn, waiting on user permission, and user hasn't seen it yet
			sessionState = "unread"
		} else if session.IsProcessing() && session.HasPendingPermission() {
			// Mid-turn, waiting on user permission, but user has already seen it
			sessionState = "idle"
		} else {
			lastReadResults, seen := readResultCounts[session.ID]
			// A result message (completed turn) that the user hasn't seen yet.
			// If no read-state row exists (session never opened in UI), treat
			// any completed turns as unread so the green dot appears.
			resultCount := session.ResultCount()
			hasUnreadResult := resultCount > 0 && (!seen || resultCount > lastReadResults)
			if hasUnreadResult {
				sessionState = "unread"
			}
		}

		sessionData := map[string]interface{}{
			"id":               session.ID,
			"title":            session.ComputeDisplayTitle(),
			"workingDir":       session.WorkingDir,
			"createdAt":        session.CreatedAt.UnixMilli(),
			"lastActivity":     session.LastActivity.UnixMilli(),
			"lastUserActivity": session.LastUserActivity.UnixMilli(),
			"messageCount":     session.MessageCount,
			"isSidechain":      session.IsSidechain,
			"sessionState":     sessionState,
			"permissionMode":   string(session.PermissionMode), // empty for historical sessions
		}

		if session.Git != nil {
			sessionData["git"] = session.Git
		} else if session.GitBranch != "" {
			sessionData["git"] = map[string]interface{}{
				"isRepo": true,
				"branch": session.GitBranch,
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

// GetClaudeSessionMessages handles GET /api/claude/sessions/:id/messages
// Returns materialized messages for a specific page (§6.4).
// Query params:
//   - page: page number (required, 0-indexed)
//
// Response: { sessionId, page, totalPages, messages, sealed }
func (h *Handlers) GetClaudeSessionMessages(c *gin.Context) {
	sessionID := c.Param("id")

	// Parse page param (required)
	pageStr := c.Query("page")
	if pageStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "page parameter is required"})
		return
	}
	page, err := strconv.Atoi(pageStr)
	if err != nil || page < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid page parameter"})
		return
	}

	// GetSession will auto-resume from history if not active
	session, err := h.server.Claude().GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	// Load raw messages from JSONL (if not already loaded)
	if err := session.LoadRawMessages(); err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to load raw messages")
	}

	totalPages := session.TotalPages()
	if page >= totalPages {
		c.JSON(http.StatusNotFound, gin.H{"error": "page out of range"})
		return
	}

	// GetPage returns materialized messages (closed stream_events excluded from sealed pages)
	pageMessages, sealed := session.GetPage(page)

	// Convert to json.RawMessage for response
	messages := make([]json.RawMessage, len(pageMessages))
	for i, msg := range pageMessages {
		messages[i] = json.RawMessage(msg)
	}

	c.JSON(http.StatusOK, gin.H{
		"sessionId":  sessionID,
		"page":       page,
		"totalPages": totalPages,
		"messages":   messages,
		"sealed":     sealed,
	})
}

// ClaudeSubscribeWebSocket handles WebSocket connection for real-time session updates
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

	// Accept WebSocket connection.
	//
	// NOTE: WebSocket compression (permessage-deflate) is intentionally disabled.
	// Per coder/websocket docs: "only enable if you've benchmarked and determined
	// compression is beneficial." The memory overhead (~1.2 MB/conn with context
	// takeover) and CPU cost are not justified here — we instead reduce payload
	// size at the application level by stripping large tool result content
	// (see claude.StripHeavyToolContent).
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

	// How many result messages the user has "seen" via this WebSocket connection.
	// Initialized to session.ResultCount() on connect (opening = seen all historical),
	// then incremented by 1 for each new live result delivered.
	// Compared against entry.ResultCount in ListAllClaudeSessions to determine
	// "unread" state: entry.ResultCount > seenResultCount → unread.
	var seenResultCount atomic.Int32

	// Persist seenResultCount to DB and fire an SSE event so that
	// any session-list refresh (iOS/web) picks up the correct "idle" state.
	// Called inline after result delivery — not just on disconnect — so the DB
	// is up-to-date while the user is still viewing the session.
	// MarkClaudeSessionRead uses MAX() upsert, so repeated/concurrent calls
	// are safe and can never regress the count.
	persistReadState := func() {
		if n := int(seenResultCount.Load()); n > 0 {
			if err := db.MarkClaudeSessionRead(sessionID, n); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist read state")
			} else {
				h.server.Notifications().NotifyClaudeSessionUpdated(sessionID, "read")
			}
		}
	}

	// Safety net: persist on disconnect in case inline calls were skipped.
	defer persistReadState()

	// DON'T activate on connection - wait for first message
	// This allows viewing historical sessions without activating them
	log.Debug().Str("sessionId", sessionID).Msg("Subscribe WebSocket connected (not activated yet)")

	var updateMutex sync.Mutex // Protect concurrent access
	_ = updateMutex // Used implicitly by goroutines

	// Load raw messages from JSONL (if not already loaded or activated)
	// This allows viewing history before activation
	if err := session.LoadRawMessages(); err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to load raw messages")
	}

	// Mark session as read immediately on connect.
	// Opening the session in the UI is sufficient to consider all existing content "seen" —
	// both completed turns (result messages) and pending permissions (control_requests).
	// This is the unified "I've seen it" signal for the session list's unread indicator.

	// 1. Mark result messages as seen (persisted to DB for cross-session consistency).
	if rc := session.ResultCount(); rc > 0 {
		if err := db.MarkClaudeSessionRead(sessionID, rc); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to mark session read on connect")
		} else {
			h.server.Notifications().NotifyClaudeSessionUpdated(sessionID, "read")
		}
		// Initialize seenResultCount so subsequent persistReadState calls
		// reflect at least the historical count. MAX() upsert prevents regression.
		seenResultCount.Store(int32(rc))
	}

	// 2. Mark pending permissions as seen (in-memory only — permissions are ephemeral).
	// After this, HasUnseenPermission() returns false until a new control_request arrives.
	session.MarkPermissionsSeen()
	h.server.Notifications().NotifyClaudeSessionUpdated(sessionID, "read")

	// Page-based initial burst (§4.1, §6.3).
	// Send last 2 pages: previous sealed page (~100 msgs) + current open page.
	totalPages := session.TotalPages()
	lowestBurstPage := totalPages - 2
	if lowestBurstPage < 0 {
		lowestBurstPage = 0
	}

	// Send session_info metadata frame.
	sessionInfo := map[string]interface{}{
		"type":            "session_info",
		"totalPages":      totalPages,
		"lowestBurstPage": lowestBurstPage,
	}
	if infoBytes, err := json.Marshal(sessionInfo); err == nil {
		if err := conn.Write(ctx, websocket.MessageText, infoBytes); err != nil {
			return
		}
	}

	// Send materialized messages from last 2 pages.
	// Sealed pages have closed stream_events excluded; the open page includes
	// active stream_events for mid-stream reconnection recovery.
	burstMessages := session.GetPageRange(lowestBurstPage, totalPages)
	if len(burstMessages) > 0 {
		log.Debug().
			Str("sessionId", sessionID).
			Int("totalPages", totalPages).
			Int("lowestBurstPage", lowestBurstPage).
			Int("burstMessages", len(burstMessages)).
			Msg("sending initial burst to new client")

		for _, msgBytes := range burstMessages {
			if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send burst message")
				return
			}
			// NOTE: Do NOT count results here — seenResultCount was already initialized
			// from session.ResultCount() above, which includes all historical results.
			// Counting burst results again would inflate the DB read count, preventing
			// future results from ever showing as "unread".
		}
	}

	// Register as a broadcast client to receive real-time JSON messages
	uiClient := &claude.Client{
		Conn: conn,
		Send: make(chan []byte, 256),
	}
	session.AddClient(uiClient)
	defer session.RemoveClient(uiClient)

	// Auto-activate: start Claude process so the init message (with slash
	// commands, skills, tools) arrives via broadcast. Non-blocking — the read
	// loop can already accept user messages while activation is in progress.
	go func() {
		if err := session.EnsureActivated(); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("auto-activation failed (non-fatal)")
		}
	}()

	// Start goroutine to forward broadcasts to WebSocket
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
						log.Debug().Err(err).Str("sessionId", sessionID).Msg("WebSocket write failed")
					}
					return
				}
				var mt struct{ Type string `json:"type"` }
				if json.Unmarshal(data, &mt) == nil && mt.Type == "result" {
					seenResultCount.Add(1)
					persistReadState()
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
			// SendInputUI handles activation internally
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
			// This unifies behavior — Claude stdin doesn't echo user messages to stdout,
			// so we synthesize one.
			syntheticMsg := map[string]interface{}{
				"type":      "user",
				"uuid":      uuid.New().String(),
				"timestamp": time.Now().UnixMilli(),
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
				Msg("message sent to claude session via WebSocket")

		case "control_request":
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

				// Send control_response confirmation to all clients.
				// Use BroadcastToClients (not BroadcastUIMessage) to avoid caching.
				responseMsg := map[string]any{
					"type":       "control_response",
					"request_id": controlReq.RequestID,
					"response": map[string]any{
						"subtype": "set_permission_mode",
						"mode":    modeReq.Request.Mode,
					},
				}
				if msgBytes, err := json.Marshal(responseMsg); err == nil {
					session.BroadcastToClients(msgBytes)
				}

			default:
				log.Debug().Str("subtype", controlReq.Request.Subtype).Msg("Unknown control_request subtype")
			}

		case "control_response":
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
