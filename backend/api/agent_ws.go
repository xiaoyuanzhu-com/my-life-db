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
	if infoBytes, err := json.Marshal(map[string]any{
		"type":          "session.info",
		"totalMessages": totalMessages,
		"isProcessing":  isProcessing,
	}); err == nil {
		if err := conn.Write(ctx, websocket.MessageText, infoBytes); err != nil {
			return
		}
	}

	// Register client BEFORE burst/history replay so concurrent broadcasts
	// (from POST handler or history replay goroutine) are queued immediately.
	uiClient := &agentsdk.WSClient{
		ID:   uuid.New().String(),
		Send: make(chan []byte, 256),
	}
	sessionState.AddClient(uiClient)
	defer sessionState.RemoveClient(uiClient)

	// Start poll goroutine BEFORE burst so it can drain the client channel
	// while burst messages are sent via direct conn.Write.
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

	// Send initial burst (last ~100 messages) via direct write (bypasses client channel)
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

			sess, histEvents, err := h.server.AgentClient().CreateSessionWithLoad(h.server.ShutdownContext(), agentsdk.SessionConfig{
				Agent:       agentType,
				Permissions: permMode,
				WorkingDir:  sessionRecord.WorkingDir,
			}, sessionID)

			if err == nil && sess != nil {
				// Store the ACP session for future prompts
				acpSessionsMu.Lock()
				acpSessions[sessionID] = sess
				acpSessionsMu.Unlock()

				// Forward replayed history events to the WS client.
				// Inject turn.start / turn.complete boundaries based on role transitions
				// so the frontend can create proper message objects.
				if len(histEvents) > 0 {
					inAssistantTurn := false
					for _, event := range histEvents {
						isUserMsg := event.Type == agentsdk.EventMessage && event.Message != nil && event.Message.Role == agentsdk.RoleUser
						isAgentContent := !isUserMsg && (event.Type == agentsdk.EventDelta ||
							(event.Type == agentsdk.EventMessage && event.Message != nil && event.Message.Role == agentsdk.RoleAssistant))

						// Before user message: close any open assistant turn
						if isUserMsg && inAssistantTurn {
							if data, err := json.Marshal(map[string]any{
								"type": "turn.complete", "ts": time.Now().UnixMilli(), "stopReason": "end_turn",
							}); err == nil {
								sessionState.AppendAndBroadcast(data)
							}
							inAssistantTurn = false
						}

						// Before agent content: open a turn if not already open
						if isAgentContent && !inAssistantTurn {
							if data, err := json.Marshal(map[string]any{
								"type": "turn.start", "ts": time.Now().UnixMilli(),
							}); err == nil {
								sessionState.AppendAndBroadcast(data)
							}
							inAssistantTurn = true
						}

						frames := marshalEventFrames(event)
						for _, frame := range frames {
							sessionState.AppendAndBroadcast(frame)
						}
					}
					// Close final turn if open
					if inAssistantTurn {
						if data, err := json.Marshal(map[string]any{
							"type": "turn.complete", "ts": time.Now().UnixMilli(), "stopReason": "end_turn",
						}); err == nil {
							sessionState.AppendAndBroadcast(data)
						}
					}
					log.Info().Str("sessionId", sessionID).Int("events", len(histEvents)).Msg("historical session replay complete")
				}
			} else if err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to create ACP session for history loading")
			}
		} else {
			log.Info().Str("sessionId", sessionID).Msg("session not found in DB or no working dir — skipping history load")
		}
	}

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
			if data, err := json.Marshal(map[string]any{
				"type": "user.echo", "ts": time.Now().UnixMilli(),
				"content": contentBlocks,
			}); err == nil {
				sessionState.AppendAndBroadcast(data)
			}

			// Broadcast turn.start
			if data, err := json.Marshal(map[string]any{
				"type": "turn.start", "ts": time.Now().UnixMilli(),
			}); err == nil {
				sessionState.AppendAndBroadcast(data)
			}

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
				sess, err := h.server.AgentClient().CreateSession(h.server.ShutdownContext(), agentsdk.SessionConfig{
					Agent:       agentType,
					Permissions: permMode,
					WorkingDir:  workDir,
				})
				if err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to create ACP session")
					if errBytes, err := json.Marshal(map[string]any{
						"type": "error", "message": "Failed to create agent session: " + err.Error(), "code": "SESSION_ERROR",
					}); err == nil {
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
				// Mark processing BEFORE Send() so any WS client connecting
				// between turn.start and the first event sees the correct state.
				sessionState.Mu.Lock()
				sessionState.IsProcessing = true
				sessionState.Mu.Unlock()

				events, err := acpSess.Send(h.server.ShutdownContext(), prompt)
				if err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send prompt to ACP session")
					sessionState.Mu.Lock()
					sessionState.IsProcessing = false
					sessionState.Mu.Unlock()
					if errBytes, err := json.Marshal(map[string]any{
						"type": "error", "message": "Failed to send message: " + err.Error(), "code": "SEND_ERROR",
					}); err == nil {
						sessionState.AppendAndBroadcast(errBytes)
					}
					return
				}

				for event := range events {
					frames := marshalEventFrames(event)
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
				modeCtx, modeCancel := context.WithTimeout(context.Background(), 10*time.Second)
				if err := acpSession.SetMode(modeCtx, inMsg.ModeID); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Str("modeId", inMsg.ModeID).Msg("failed to set mode")
				} else {
					log.Info().Str("sessionId", sessionID).Str("modeId", inMsg.ModeID).Msg("mode set via WebSocket")
				}
				modeCancel()
			}

		case "session.setModel":
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if exists {
				modelCtx, modelCancel := context.WithTimeout(context.Background(), 10*time.Second)
				if err := acpSession.SetModel(modelCtx, inMsg.ModelID); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Str("modelId", inMsg.ModelID).Msg("failed to set model")
				} else {
					log.Info().Str("sessionId", sessionID).Str("modelId", inMsg.ModelID).Msg("model set via WebSocket")
				}
				modelCancel()
			}

		case "permission.respond":
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if !exists {
				log.Warn().Str("sessionId", sessionID).Msg("no ACP session for permission response")
				break
			}

			if err := acpSession.RespondToPermission(context.Background(), inMsg.ToolCallID, inMsg.OptionID); err != nil {
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

// marshalEventFrames converts an agentsdk.Event into zero or more
// JSON frames for sending over WebSocket.
func marshalEventFrames(event agentsdk.Event) [][]byte {
	var frames [][]byte
	ts := time.Now().UnixMilli()

	marshal := func(m map[string]any) {
		if data, err := json.Marshal(m); err == nil {
			frames = append(frames, data)
		}
	}

	switch event.Type {
	case agentsdk.EventDelta:
		marshal(map[string]any{
			"type": "agent.messageChunk", "ts": ts,
			"content": map[string]any{"type": "text", "text": event.Delta},
		})

	case agentsdk.EventMessage:
		if event.Message == nil {
			return nil
		}

		if event.Message.Role == agentsdk.RoleUser {
			contentBlocks := make([]map[string]any, 0, len(event.Message.Content))
			for _, block := range event.Message.Content {
				if block.Type == agentsdk.BlockText {
					contentBlocks = append(contentBlocks, map[string]any{"type": "text", "text": block.Text})
				}
			}
			if len(contentBlocks) > 0 {
				marshal(map[string]any{
					"type": "user.echo", "ts": ts, "content": contentBlocks,
				})
			}
			return frames
		}

		for _, block := range event.Message.Content {
			switch block.Type {
			case agentsdk.BlockThinking:
				marshal(map[string]any{
					"type": "agent.thoughtChunk", "ts": ts,
					"content": map[string]any{"type": "text", "text": block.Text},
				})
			case agentsdk.BlockToolUse:
				marshal(map[string]any{
					"type": "agent.toolCall", "ts": ts,
					"toolCallId": block.ToolUseID, "title": block.ToolName,
					"kind": block.ToolKind,
					"rawInput": json.RawMessage(block.ToolInput),
				})
			case agentsdk.BlockToolResult:
				marshal(map[string]any{
					"type": "agent.toolCallUpdate", "ts": ts,
					"toolCallId": block.ToolUseID,
					"rawOutput": map[string]any{"content": block.Text},
				})
			case agentsdk.BlockPlan:
				marshal(map[string]any{
					"type": "agent.plan", "ts": ts, "entries": block.PlanEntries,
				})
			case agentsdk.BlockText:
				marshal(map[string]any{
					"type": "agent.messageChunk", "ts": ts,
					"content": map[string]any{"type": "text", "text": block.Text},
				})
			}
		}

	case agentsdk.EventPermissionRequest:
		pr := event.PermissionRequest
		options := make([]map[string]any, len(pr.Options))
		for i, opt := range pr.Options {
			options[i] = map[string]any{
				"optionId": opt.ID, "name": opt.Name, "kind": opt.Kind,
			}
		}
		marshal(map[string]any{
			"type": "permission.request",
			"toolCall": map[string]any{
				"toolCallId": pr.ID, "title": pr.Tool,
				"kind": pr.ToolKind, "rawInput": json.RawMessage(pr.Input),
			},
			"options": options,
		})

	case agentsdk.EventComplete:
		stopReason := event.StopReason
		if stopReason == "" {
			stopReason = "end_turn"
		}
		marshal(map[string]any{
			"type": "turn.complete", "ts": ts, "stopReason": stopReason,
		})

	case agentsdk.EventError:
		msg := "unknown error"
		if event.Error != nil {
			msg = event.Error.Error()
		}
		marshal(map[string]any{
			"type": "error", "message": msg, "code": "AGENT_ERROR",
		})

	case agentsdk.EventModeUpdate:
		if event.SessionMeta != nil {
			m := map[string]any{"type": "session.modeUpdate", "modeId": event.SessionMeta.ModeID}
			if event.SessionMeta.AvailableModes != nil {
				m["availableModes"] = json.RawMessage(event.SessionMeta.AvailableModes)
			}
			marshal(m)
		}

	case agentsdk.EventCommandsUpdate:
		if event.SessionMeta != nil {
			marshal(map[string]any{
				"type": "session.commandsUpdate", "commands": json.RawMessage(event.SessionMeta.Commands),
			})
		}

	case agentsdk.EventModelsUpdate:
		if event.SessionMeta != nil {
			m := map[string]any{"type": "session.modelsUpdate", "modelId": event.SessionMeta.ModelID}
			if event.SessionMeta.AvailableModels != nil {
				m["availableModels"] = json.RawMessage(event.SessionMeta.AvailableModels)
			}
			marshal(m)
		}
	}

	return frames
}
