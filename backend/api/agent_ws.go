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
	state := agentsdk.NewSessionState(sessionID)
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

// PeekSessionState returns the in-memory SessionState for the given session ID
// without creating one. Returns nil if the session has no in-memory state
// (i.e., no active WebSocket connection or ACP process).
func PeekSessionState(sessionID string) *agentsdk.SessionState {
	agentSessionStatesMu.Lock()
	defer agentSessionStatesMu.Unlock()
	return agentSessionStates[sessionID]
}

// GetAllSessionRuntimeStates returns a snapshot of IsProcessing and ResultCount
// for all sessions that have in-memory state. Used by REST endpoints to compute
// the "working"/"unread" session states without creating empty SessionState objects.
func GetAllSessionRuntimeStates() map[string]struct{ IsProcessing bool; ResultCount int } {
	agentSessionStatesMu.Lock()
	defer agentSessionStatesMu.Unlock()

	result := make(map[string]struct{ IsProcessing bool; ResultCount int }, len(agentSessionStates))
	for id, ss := range agentSessionStates {
		ss.Mu.RLock()
		result[id] = struct{ IsProcessing bool; ResultCount int }{
			IsProcessing: ss.IsProcessing(),
			ResultCount:  ss.ResultCount,
		}
		ss.Mu.RUnlock()
	}
	return result
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
			log.Info().Str("sessionId", sessionID).Int("seenResultCount", n).Msg("WS disconnect: persisting read state")
			if err := db.MarkAgentSessionRead(sessionID, n); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist read state")
			} else {
				h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "read")
			}
		}
	}
	defer persistReadState()

	// Mark session as read on connect
	sessionState.Mu.RLock()
	rc := sessionState.ResultCount
	sessionState.Mu.RUnlock()
	log.Info().Str("sessionId", sessionID).Int("resultCount", rc).Msg("WS connect: marking session read")
	if rc > 0 {
		if err := db.MarkAgentSessionRead(sessionID, rc); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to mark session read on connect")
		} else {
			h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "read")
		}
		seenResultCount.Store(int32(rc))
	}

	// Send session.info before registering so the frontend knows active/processing
	// state before any content frames arrive.
	sessionState.Mu.RLock()
	isActive := sessionState.IsActive
	isProcessing := sessionState.IsProcessing()
	sessionState.Mu.RUnlock()

	if infoFrame, err := json.Marshal(map[string]any{
		"type":         "session.info",
		"isActive":     isActive,
		"isProcessing": isProcessing,
	}); err == nil {
		if err := conn.Write(ctx, websocket.MessageText, infoFrame); err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send session.info")
			return
		}
	}

	// Register client with cursor at 0 so it replays all stored messages,
	// then picks up live frames via notification.
	uiClient := agentsdk.NewWSClient(uuid.New().String(), 0)
	sessionState.AddClient(uiClient)
	defer sessionState.RemoveClient(uiClient)

	// Write loop: drains rawMessages from cursor position at its own pace.
	// No data is ever dropped — the client simply catches up.
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		for {
			msgs := sessionState.Drain(uiClient)
			for _, data := range msgs {
				if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
					if ctx.Err() == nil {
						log.Debug().Err(err).Str("sessionId", sessionID).Msg("agent WebSocket write failed")
					}
					return
				}
				// Track turn.complete for read state — but only increment the counter.
				// Don't persist immediately; defer will handle it on disconnect.
				// This prevents a race where the write loop marks a result as "read"
				// right as the user navigates away, causing working→idle instead of
				// working→unread.
				var mt struct{ Type string `json:"type"` }
				if json.Unmarshal(data, &mt) == nil && mt.Type == "turn.complete" {
					seenResultCount.Add(1)
				}
			}
			// Wait for new data or context cancellation
			select {
			case <-ctx.Done():
				return
			case <-uiClient.Notify:
			}
		}
	}()

	// If no messages in memory (e.g., server restart), try loading history via ACP.
	// sync.Once ensures only one concurrent connection triggers LoadSession;
	// others block until it completes, then receive frames via the cursor-based write loop.
	if sessionState.MessageCount() == 0 {
		sessionState.HistoryOnce.Do(func() {
			log.Info().Str("sessionId", sessionID).Msg("no in-memory messages, attempting history load via ACP session/load")
			sessionRecord, _ := db.GetAgentSession(sessionID)
			if sessionRecord == nil || sessionRecord.WorkingDir == "" {
				log.Info().Str("sessionId", sessionID).Msg("session not found in DB or no working dir — skipping history load")
				sessionState.Mu.Lock()
				sessionState.HistoryError = "session not found or no working directory"
				sessionState.Mu.Unlock()
				return
			}

			log.Info().Str("sessionId", sessionID).Str("workingDir", sessionRecord.WorkingDir).Msg("found session in DB, spawning ACP process for session/load")
			agentType := agentsdk.AgentClaudeCode
			if sessionRecord.AgentType == "codex" {
				agentType = agentsdk.AgentCodex
			}
			mode, _ := db.GetAgentSessionPermissionMode(sessionID)

			sess, err := h.server.AgentClient().CreateSession(h.server.ShutdownContext(), agentsdk.SessionConfig{
				Agent:      agentType,
				Mode:       mode,
				WorkingDir: sessionRecord.WorkingDir,
			})

			if err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to create ACP session for history loading")
				sessionState.Mu.Lock()
				sessionState.HistoryError = err.Error()
				sessionState.Mu.Unlock()
				return
			}
			if sess == nil {
				return
			}

			sess.SetOnFrame(func(data []byte) {
				sessionState.Mu.Lock()
				sessionState.TouchFrame()
				sessionState.Mu.Unlock()
				sessionState.AppendAndBroadcast(data)
			})
			// Set mode AFTER onFrame so the mode-change event is captured
			if mode != "" {
				if err := sess.SetMode(h.server.ShutdownContext(), mode); err != nil {
					log.Warn().Err(err).Str("sessionId", sessionID).Str("mode", mode).Msg("failed to set mode on history-load session")
				}
			}

			acpSessionsMu.Lock()
			acpSessions[sessionID] = sess
			acpSessionsMu.Unlock()

			if err := sess.LoadSession(h.server.ShutdownContext(), sessionID, sessionRecord.WorkingDir); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("LoadSession failed")
				sessionState.Mu.Lock()
				sessionState.HistoryError = err.Error()
				sessionState.Mu.Unlock()
			} else {
				log.Info().Str("sessionId", sessionID).Msg("historical session replay complete")
			}
		})
	}

	// Always notify the client if history loading failed, even on reconnections
	// where burst messages (ACP control frames) may bypass the history loading
	// block above. This ensures the frontend can exit the loading state.
	sessionState.Mu.RLock()
	histErr := sessionState.HistoryError
	sessionState.Mu.RUnlock()
	if histErr != "" {
		if frame, err := json.Marshal(map[string]any{
			"type":  "session.historyDone",
			"empty": true,
			"error": histErr,
		}); err == nil {
			_ = conn.Write(ctx, websocket.MessageText, frame)
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

	// Prompt serialization is handled via sessionState.PromptDone/PromptCancel
	// (shared across WS and REST goroutines). See SessionState.WaitForPrompt().

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

			// Create ACP session lazily if needed
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if !exists {
				log.Info().Str("sessionId", sessionID).Msg("no ACP session in memory, creating lazily for prompt")
				// Look up session metadata from DB for agent type, working dir, permission mode
				agentType := agentsdk.AgentClaudeCode
				workDir := ""
				if sessionRecord, _ := db.GetAgentSession(sessionID); sessionRecord != nil {
					if sessionRecord.AgentType == "codex" {
						agentType = agentsdk.AgentCodex
					}
					workDir = sessionRecord.WorkingDir
				}
				mode, _ := db.GetAgentSessionPermissionMode(sessionID)

				// Create a new ACP session
				sess, err := h.server.AgentClient().CreateSession(h.server.ShutdownContext(), agentsdk.SessionConfig{
					Agent:      agentType,
					Mode:       mode,
					WorkingDir: workDir,
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
				sess.SetOnFrame(func(data []byte) {
					sessionState.Mu.Lock()
					sessionState.TouchFrame()
					sessionState.Mu.Unlock()
					sessionState.AppendAndBroadcast(data)
				})
				// Set mode AFTER onFrame so the mode-change event is captured
				if mode != "" {
					if err := sess.SetMode(h.server.ShutdownContext(), mode); err != nil {
						log.Warn().Err(err).Str("sessionId", sessionID).Str("mode", mode).Msg("failed to set mode on lazy session")
					}
				}
				acpSessionsMu.Lock()
				acpSessions[sessionID] = sess
				acpSessionsMu.Unlock()
				acpSession = sess
			}

			// Update the session's updated_at so the session list re-sorts
			// by last user activity (agent responses don't touch this).
			if err := db.TouchAgentSession(sessionID); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to touch agent session")
			}

			// Synthesize user_message_chunk BEFORE Send() so the user's message
			// is in rawMessages for burst replay on page refresh.
			sessionState.AppendAndBroadcast(agentsdk.SynthUserMessageChunk(promptText))

			// Serialize prompts: wait for any in-flight prompt goroutine to finish
			// before starting a new one. This prevents concurrent conn.Prompt()
			// calls on the same ACP connection (which causes the SDK to return
			// empty responses for the second call).
			// Uses shared SessionState tracking so WS handler can also wait for
			// REST-initiated or auto-run goroutines.
			sessionState.WaitForPrompt()

			// Create a per-prompt context so session.cancel can abort it.
			promptCtx, pCancel := context.WithCancel(h.server.ShutdownContext())
			done := make(chan struct{})

			sessionState.Mu.Lock()
			sessionState.RegisterPrompt(done, pCancel)
			sessionState.Mu.Unlock()

			// Send prompt and start frame forwarding
			go func(acpSess agentsdk.Session, prompt string, pCtx context.Context, pCancel context.CancelFunc) {
				defer close(done)

				// Mark processing BEFORE Send() so any WS client connecting
				// between turn.start and the first event sees the correct state.
				sessionState.Mu.Lock()
				sessionState.SetProcessing(true, "ws-prompt")
				sessionState.IsActive = true
				sessionState.Killed = false // reset from previous force-kill
				sessionState.TouchFrame()   // record prompt start time for diagnostics
				sessionState.Mu.Unlock()
				h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "working")

				// Monitor process exit — cancel prompt context if process dies,
				// which unblocks Prompt() and causes the events channel to close.
				go func() {
					select {
					case <-acpSess.Done():
						log.Info().Str("sessionId", sessionID).Msg("agent process exited during WS prompt")
						pCancel()
					case <-pCtx.Done():
					}
				}()

				// Emit turn.start so the frontend knows processing has begun.
				// Stored in rawMessages for burst replay on reconnect, ensuring
				// isRunning=true even if no content frames have arrived yet.
				if startBytes, err := json.Marshal(map[string]any{
					"type": "turn.start",
				}); err == nil {
					sessionState.AppendAndBroadcast(startBytes)
				}

				events, err := acpSess.Send(pCtx, prompt)
				if err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send prompt to ACP session")
					sessionState.Mu.Lock()
					killed := sessionState.Killed
					if !killed {
						sessionState.SetProcessing(false, "ws-prompt-send-error")
					}
					sessionState.Mu.Unlock()
					if !killed {
						if errBytes, err := json.Marshal(map[string]any{
							"type": "error", "message": "Failed to send message: " + err.Error(), "code": "SEND_ERROR",
						}); err == nil {
							sessionState.AppendAndBroadcast(errBytes)
						}
						h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "result")
					}
					return
				}

				frameCount := 0
				for frame := range events {
					// Skip frames if session was force-killed (kill handler
					// already emitted turn.complete).
					sessionState.Mu.RLock()
					killed := sessionState.Killed
					sessionState.Mu.RUnlock()
					if killed {
						continue
					}
					frameCount++
					sessionState.AppendAndBroadcast(frame)
				}
				// Channel closed = turn complete
				sessionState.Mu.Lock()
				killed := sessionState.Killed
				if !killed {
					sessionState.ResultCount++
					sessionState.SetProcessing(false, "ws-prompt-complete")
				}
				sessionState.ClearPrompt()
				sessionState.Mu.Unlock()

				if !killed {
					// Detect zero-output turns: the ACP process accepted the
					// prompt but produced no content. This typically means the
					// session's internal state is corrupted (e.g. after a
					// cancellation). Emit an error frame so the user sees
					// feedback instead of an invisible empty response.
					if frameCount <= 1 {
						// frameCount <= 1 means only turn.complete (or nothing).
						// No actual content, tool calls, or text was produced.
						log.Info().
							Str("sessionId", sessionID).
							Int("frameCount", frameCount).
							Msg("zero-output turn detected: agent produced no content")
						if errBytes, err := json.Marshal(map[string]any{
							"type":    "error",
							"message": "The agent returned an empty response. This can happen when the session state is corrupted — try sending your message again or start a new session.",
							"code":    "EMPTY_RESPONSE",
						}); err == nil {
							sessionState.AppendAndBroadcast(errBytes)
						}
					}
					h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "result")
				}
			}(acpSession, promptText, promptCtx, pCancel)

			// Auto-unarchive
			if archived, err := db.IsAgentSessionArchived(sessionID); err == nil && archived {
				if err := db.UnarchiveAgentSession(sessionID); err != nil {
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

			// Cancel the per-prompt context so conn.Prompt() returns promptly.
			sessionState.Mu.RLock()
			pc := sessionState.PromptCancel
			sessionState.Mu.RUnlock()
			if pc != nil {
				pc()
			}

			// Send ack so the client can immediately update UI (stop spinner, clear permissions).
			// turn.complete from ACP will arrive later and is idempotent.
			if ackBytes, err := json.Marshal(map[string]any{
				"type": "session.cancelled",
			}); err == nil {
				sessionState.BroadcastToClients(ackBytes)
			}

		case "session.kill":
			// Force-kill: terminates the ACP process when normal cancellation is stuck.
			// Used as a safety net when the session is unresponsive.
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			if exists {
				delete(acpSessions, sessionID)
			}
			acpSessionsMu.Unlock()

			if exists {
				acpSession.CancelAllPermissions()
				if err := acpSession.Close(); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to force-kill agent session")
				} else {
					log.Info().Str("sessionId", sessionID).Msg("agent session force-killed via WebSocket")
				}
			}

			// Mark killed so the Send() goroutine skips its cleanup (avoids
			// duplicate turn.complete / spurious error frames).
			sessionState.Mu.Lock()
			sessionState.Killed = true
			sessionState.SetProcessing(false, "ws-kill")
			sessionState.Mu.Unlock()

			if completeBytes, err := json.Marshal(map[string]any{
				"type":       "turn.complete",
				"stopReason": "killed",
			}); err == nil {
				sessionState.AppendAndBroadcast(completeBytes)
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

