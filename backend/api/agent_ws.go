package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// agentSessionStates is a registry of session ID → *SessionState.
// Protected by agentSessionStatesMu.
var (
	agentSessionStatesMu sync.Mutex
	agentSessionStates   = make(map[string]*agentsdk.SessionState)
)

// getOrCreateSessionState returns the SessionState for the given session ID,
// creating one if it doesn't exist.
func getOrCreateSessionState(sessionID string) *agentsdk.SessionState {
	agentSessionStatesMu.Lock()
	defer agentSessionStatesMu.Unlock()

	if state, ok := agentSessionStates[sessionID]; ok {
		return state
	}
	state := agentsdk.NewSessionState()
	agentSessionStates[sessionID] = state
	return state
}

// acpSessions tracks active ACP sessions by session ID.
// Protected by acpSessionsMu.
var (
	acpSessionsMu sync.Mutex
	acpSessions   = make(map[string]agentsdk.Session)
)

// StoreAcpSession stores an ACP session in the in-memory map.
// Called from CreateAgentSession in agent_api.go after eagerly spawning the ACP process.
func StoreAcpSession(sessionID string, sess agentsdk.Session) {
	acpSessionsMu.Lock()
	acpSessions[sessionID] = sess
	acpSessionsMu.Unlock()
}

// GetOrCreateSessionState returns the SessionState for the given session ID,
// creating one if it doesn't exist. Exported for use from agent_api.go.
func GetOrCreateSessionState(sessionID string) *agentsdk.SessionState {
	return getOrCreateSessionState(sessionID)
}

// CleanupAgentSession closes and removes the in-memory ACP session and session
// state for the given session ID. Called from DeleteAgentSession in agent_api.go.
func CleanupAgentSession(sessionID string) {
	acpSessionsMu.Lock()
	if sess, ok := acpSessions[sessionID]; ok {
		sess.Close()
		delete(acpSessions, sessionID)
	}
	acpSessionsMu.Unlock()

	agentSessionStatesMu.Lock()
	delete(agentSessionStates, sessionID)
	agentSessionStatesMu.Unlock()
}

// AgentSessionWebSocket handles WebSocket connections for ACP-based agent sessions.
// It uses ACP-native envelope framing for all messages.
func (h *Handlers) AgentSessionWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	log.Info().Str("sessionId", sessionID).Msg("AgentSessionWebSocket: connection request")

	// Get or create session state
	sessionState := getOrCreateSessionState(sessionID)

	// Get the underlying http.ResponseWriter from Gin's wrapper
	var w http.ResponseWriter = c.Writer
	if unwrapper, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		w = unwrapper.Unwrap()
	}

	// Accept WebSocket connection (compression disabled, skip origin check)
	conn, err := websocket.Accept(w, c.Request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("AgentSessionWebSocket: upgrade failed")
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Abort Gin context to prevent middleware from writing headers on hijacked connection
	c.Abort()

	// Create a cancellable context for this connection
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Monitor server shutdown
	go func() {
		select {
		case <-h.server.ShutdownContext().Done():
			log.Debug().Str("sessionId", sessionID).Msg("server shutdown, closing agent WebSocket")
			cancel()
		case <-ctx.Done():
		}
	}()

	// Track seen result count for read state persistence
	var seenResultCount atomic.Int32

	persistReadState := func() {
		if n := int(seenResultCount.Load()); n > 0 {
			if err := db.MarkClaudeSessionRead(sessionID, n); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist read state")
			} else {
				h.server.Notifications().NotifyClaudeSessionUpdated(sessionID, "read")
			}
		}
	}
	defer persistReadState()

	// Mark session as read on connect
	sessionState.Mu.RLock()
	rc := sessionState.ResultCount
	sessionState.Mu.RUnlock()
	if rc > 0 {
		if err := db.MarkClaudeSessionRead(sessionID, rc); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to mark session read on connect")
		} else {
			h.server.Notifications().NotifyClaudeSessionUpdated(sessionID, "read")
		}
		seenResultCount.Store(int32(rc))
	}

	// Send session.info metadata frame
	totalMessages := len(sessionState.GetRecentMessages(0))
	sessionState.Mu.RLock()
	isProcessing := sessionState.IsProcessing
	sessionState.Mu.RUnlock()
	infoBytes, err := agentsdk.SessionInfoEnvelope(sessionID, totalMessages, isProcessing)
	if err == nil {
		if err := conn.Write(ctx, websocket.MessageText, infoBytes); err != nil {
			return
		}
	}

	// Send initial burst (last ~100 messages)
	burstMessages := sessionState.GetRecentMessages(100)
	if len(burstMessages) > 0 {
		log.Debug().
			Str("sessionId", sessionID).
			Int("burstMessages", len(burstMessages)).
			Msg("sending initial burst to new agent client")

		for _, msgBytes := range burstMessages {
			if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send burst message")
				return
			}
		}
	}

	// If no messages in memory (e.g., server restart), try loading history via ACP
	if totalMessages == 0 {
		log.Info().Str("sessionId", sessionID).Msg("no in-memory messages, attempting history load via ACP session/load")
		if sessionRecord, _ := db.GetAgentSession(sessionID); sessionRecord != nil && sessionRecord.WorkingDir != "" {
			log.Info().Str("sessionId", sessionID).Str("workingDir", sessionRecord.WorkingDir).Msg("found session in DB, spawning ACP process for session/load")
			agentType := agentsdk.AgentClaudeCode
			if sessionRecord.AgentType == "codex" {
				agentType = agentsdk.AgentCodex
			}
			permMode := agentsdk.PermissionAsk
			if pmStr, _ := db.GetAgentSessionPermissionMode(sessionID); pmStr != "" {
				switch pmStr {
				case "bypassPermissions":
					permMode = agentsdk.PermissionAuto
				case "plan":
					permMode = agentsdk.PermissionDeny
				}
			}

			sess, histEvents, err := h.server.AgentClient().CreateSessionWithLoad(ctx, agentsdk.SessionConfig{
				Agent:       agentType,
				Permissions: permMode,
				WorkingDir:  sessionRecord.WorkingDir,
			}, sessionID)

			if err == nil && sess != nil {
				// Store the ACP session for future prompts
				acpSessionsMu.Lock()
				acpSessions[sessionID] = sess
				acpSessionsMu.Unlock()

				// Forward replayed history events to the WS client
				if histEvents != nil {
					go func() {
						for event := range histEvents {
							frames := translateEventToEnvelopes(sessionID, event)
							for _, frame := range frames {
								sessionState.AppendAndBroadcast(frame)
							}
						}
						log.Info().Str("sessionId", sessionID).Msg("historical session replay complete")
					}()
				}
			} else if err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to create ACP session for history loading")
			}
		} else {
			log.Info().Str("sessionId", sessionID).Msg("session not found in DB or no working dir — skipping history load")
		}
	}

	// Register as client
	uiClient := &agentsdk.WSClient{
		ID:   uuid.New().String(),
		Send: make(chan []byte, 256),
	}
	sessionState.AddClient(uiClient)
	defer sessionState.RemoveClient(uiClient)

	// Goroutine: forward broadcasts to WebSocket
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
						log.Debug().Err(err).Str("sessionId", sessionID).Msg("agent WebSocket write failed")
					}
					return
				}
				var mt struct{ Type string `json:"type"` }
				if json.Unmarshal(data, &mt) == nil && mt.Type == "turn.complete" {
					seenResultCount.Add(1)
					persistReadState()
				}
			}
		}
	}()

	// Goroutine: ping every 30s
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

	// Read loop: handle inbound messages
	for {
		msgType, msg, err := conn.Read(ctx)
		if err != nil {
			closeStatus := websocket.CloseStatus(err)
			if closeStatus == websocket.StatusGoingAway ||
				closeStatus == websocket.StatusNormalClosure ||
				closeStatus == websocket.StatusNoStatusRcvd {
				log.Debug().Str("sessionId", sessionID).Int("closeStatus", int(closeStatus)).Msg("agent WebSocket closed normally")
			} else {
				log.Debug().Err(err).Str("sessionId", sessionID).Msg("agent WebSocket read error")
			}
			cancel()
			break
		}

		if msgType != websocket.MessageText {
			continue
		}

		// Parse incoming ACP message
		var inMsg struct {
			Type       string          `json:"type"`
			SessionID  string          `json:"sessionId"`
			Content    json.RawMessage `json:"content,omitempty"`
			ModeID     string          `json:"modeId,omitempty"`
			ModelID    string          `json:"modelId,omitempty"`
			ToolCallID string          `json:"toolCallId,omitempty"`
			OptionID   string          `json:"optionId,omitempty"`
		}
		if err := json.Unmarshal(msg, &inMsg); err != nil {
			log.Debug().Err(err).Msg("failed to parse agent WS message")
			continue
		}

		log.Debug().Str("sessionId", sessionID).Str("type", inMsg.Type).Msg("received agent WS message")

		switch inMsg.Type {
		case "session.prompt":
			// Extract text from content blocks
			var contentBlocks []map[string]any
			if err := json.Unmarshal(inMsg.Content, &contentBlocks); err != nil {
				log.Debug().Err(err).Msg("failed to parse content blocks")
				continue
			}

			// Build prompt text from content blocks
			var promptText string
			for _, block := range contentBlocks {
				if t, ok := block["type"].(string); ok && t == "text" {
					if text, ok := block["text"].(string); ok {
						if promptText != "" {
							promptText += "\n"
						}
						promptText += text
					}
				}
			}

			// Broadcast user echo
			userEcho, _ := agentsdk.UserEchoEnvelope(sessionID, contentBlocks)
			sessionState.AppendAndBroadcast(userEcho)

			// Broadcast turn.start
			turnStart, _ := agentsdk.TurnStartEnvelope(sessionID)
			sessionState.AppendAndBroadcast(turnStart)

			// Create ACP session lazily if needed
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if !exists {
				log.Info().Str("sessionId", sessionID).Msg("no ACP session in memory, creating lazily for prompt")
				// Look up session metadata from DB for agent type, working dir, permission mode
				agentType := agentsdk.AgentClaudeCode
				permMode := agentsdk.PermissionAsk
				workDir := ""
				if sessionRecord, _ := db.GetAgentSession(sessionID); sessionRecord != nil {
					if sessionRecord.AgentType == "codex" {
						agentType = agentsdk.AgentCodex
					}
					workDir = sessionRecord.WorkingDir
				}
				if pmStr, _ := db.GetAgentSessionPermissionMode(sessionID); pmStr != "" {
					switch pmStr {
					case "bypassPermissions":
						permMode = agentsdk.PermissionAuto
					case "plan":
						permMode = agentsdk.PermissionDeny
					default:
						permMode = agentsdk.PermissionAsk
					}
				}

				// Create a new ACP session
				sess, err := h.server.AgentClient().CreateSession(ctx, agentsdk.SessionConfig{
					Agent:       agentType,
					Permissions: permMode,
					WorkingDir:  workDir,
				})
				if err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to create ACP session")
					errBytes, _ := agentsdk.ErrorEnvelope(sessionID, "Failed to create agent session: "+err.Error(), "SESSION_ERROR")
					if errBytes != nil {
						conn.Write(ctx, websocket.MessageText, errBytes)
					}
					continue
				}
				acpSessionsMu.Lock()
				acpSessions[sessionID] = sess
				acpSessionsMu.Unlock()
				acpSession = sess
			}

			// Send prompt and start event forwarding
			go func(acpSess agentsdk.Session, prompt string) {
				events, err := acpSess.Send(ctx, prompt)
				if err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send prompt to ACP session")
					errBytes, _ := agentsdk.ErrorEnvelope(sessionID, "Failed to send message: "+err.Error(), "SEND_ERROR")
					if errBytes != nil {
						sessionState.AppendAndBroadcast(errBytes)
					}
					return
				}

				sessionState.Mu.Lock()
				sessionState.IsProcessing = true
				sessionState.Mu.Unlock()

				for event := range events {
					frames := translateEventToEnvelopes(sessionID, event)
					for _, frame := range frames {
						sessionState.AppendAndBroadcast(frame)
					}
					if event.Type == agentsdk.EventComplete {
						sessionState.Mu.Lock()
						sessionState.ResultCount++
						sessionState.IsProcessing = false
						sessionState.Mu.Unlock()
						h.server.Notifications().NotifyClaudeSessionUpdated(sessionID, "result")
					}
				}
			}(acpSession, promptText)

			// Auto-unarchive
			if archived, err := db.IsClaudeSessionArchived(sessionID); err == nil && archived {
				if err := db.UnarchiveClaudeSession(sessionID); err != nil {
					log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to auto-unarchive session")
				} else {
					log.Info().Str("sessionId", sessionID).Msg("auto-unarchived session on new message")
				}
			}

			log.Info().
				Str("sessionId", sessionID).
				Str("prompt", promptText).
				Msg("prompt sent to agent session via WebSocket")

		case "session.cancel":
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if exists {
				acpSession.CancelAllPermissions()
				if err := acpSession.Stop(); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to cancel agent session")
				} else {
					log.Info().Str("sessionId", sessionID).Msg("agent session cancelled via WebSocket")
				}
			}

		case "session.setMode":
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if exists {
				if err := acpSession.SetMode(ctx, inMsg.ModeID); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Str("modeId", inMsg.ModeID).Msg("failed to set mode")
				} else {
					log.Info().Str("sessionId", sessionID).Str("modeId", inMsg.ModeID).Msg("mode set via WebSocket")
				}
			}

		case "session.setModel":
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if exists {
				if err := acpSession.SetModel(ctx, inMsg.ModelID); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Str("modelId", inMsg.ModelID).Msg("failed to set model")
				} else {
					log.Info().Str("sessionId", sessionID).Str("modelId", inMsg.ModelID).Msg("model set via WebSocket")
				}
			}

		case "permission.respond":
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if !exists {
				log.Warn().Str("sessionId", sessionID).Msg("no ACP session for permission response")
				break
			}

			if err := acpSession.RespondToPermission(ctx, inMsg.ToolCallID, inMsg.OptionID); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to respond to permission")
			}

			log.Info().
				Str("sessionId", sessionID).
				Str("toolCallId", inMsg.ToolCallID).
				Str("optionId", inMsg.OptionID).
				Msg("sent permission response to agent")

		default:
			log.Debug().Str("type", inMsg.Type).Msg("unknown agent WS message type")
		}
	}

	<-pollDone
	<-pingDone
}

// translateEventToEnvelopes converts an agentsdk.Event into zero or more
// ACP envelope frames for sending over WebSocket.
func translateEventToEnvelopes(sessionID string, event agentsdk.Event) [][]byte {
	var frames [][]byte
	var data []byte
	var err error

	switch event.Type {
	case agentsdk.EventDelta:
		data, err = agentsdk.AgentMessageChunkEnvelope(sessionID,
			map[string]any{"type": "text", "text": event.Delta})

	case agentsdk.EventMessage:
		if event.Message == nil {
			return nil
		}
		for _, block := range event.Message.Content {
			switch block.Type {
			case agentsdk.BlockThinking:
				data, err = agentsdk.AgentThoughtChunkEnvelope(sessionID,
					map[string]any{"type": "text", "text": block.Text})
			case agentsdk.BlockToolUse:
				fields := map[string]any{
					"toolCallId": block.ToolUseID,
					"title":      block.ToolName,
					"kind":       block.ToolKind,
					"status":     "in_progress",
					"rawInput":   json.RawMessage(block.ToolInput),
				}
				data, err = agentsdk.AgentToolCallEnvelope(sessionID, fields)
			case agentsdk.BlockToolResult:
				fields := map[string]any{
					"toolCallId": block.ToolUseID,
					"status":     "completed",
					"rawOutput":  map[string]any{"content": block.Text},
				}
				data, err = agentsdk.AgentToolCallUpdateEnvelope(sessionID, fields)
			case agentsdk.BlockPlan:
				data, err = agentsdk.AgentPlanEnvelope(sessionID, block.Text)
			case agentsdk.BlockText:
				data, err = agentsdk.AgentMessageChunkEnvelope(sessionID,
					map[string]any{"type": "text", "text": block.Text})
			}
			if err == nil && data != nil {
				frames = append(frames, data)
				data = nil
			}
		}
		return frames

	case agentsdk.EventPermissionRequest:
		pr := event.PermissionRequest
		toolCall := map[string]any{
			"toolCallId": pr.ID,
			"title":      pr.Tool,
			"kind":       pr.ToolKind,
			"rawInput":   json.RawMessage(pr.Input),
		}
		options := make([]map[string]any, len(pr.Options))
		for i, opt := range pr.Options {
			options[i] = map[string]any{
				"optionId": opt.ID, "name": opt.Name, "kind": opt.Kind,
			}
		}
		data, err = agentsdk.PermissionRequestEnvelope(sessionID, toolCall, options)

	case agentsdk.EventComplete:
		stopReason := event.StopReason
		if stopReason == "" {
			stopReason = "end_turn"
		}
		data, err = agentsdk.TurnCompleteEnvelope(sessionID, stopReason)

	case agentsdk.EventError:
		msg := "unknown error"
		if event.Error != nil {
			msg = event.Error.Error()
		}
		data, err = agentsdk.ErrorEnvelope(sessionID, msg, "AGENT_ERROR")

	case agentsdk.EventModeUpdate:
		if event.SessionMeta != nil {
			data, err = agentsdk.SessionModeUpdateEnvelope(sessionID,
				event.SessionMeta.ModeID, json.RawMessage(event.SessionMeta.AvailableModes))
		}

	case agentsdk.EventCommandsUpdate:
		if event.SessionMeta != nil {
			data, err = agentsdk.SessionCommandsUpdateEnvelope(sessionID,
				json.RawMessage(event.SessionMeta.Commands))
		}

	case agentsdk.EventModelsUpdate:
		if event.SessionMeta != nil {
			data, err = agentsdk.SessionModelsUpdateEnvelope(sessionID,
				event.SessionMeta.ModelID, json.RawMessage(event.SessionMeta.AvailableModels))
		}
	}

	if err == nil && data != nil {
		frames = append(frames, data)
	}
	return frames
}
