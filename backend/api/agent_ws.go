package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

// AgentSessionWebSocket handles WebSocket connections for ACP-based agent sessions.
// It uses ACP-native envelope framing for all messages.
func (h *Handlers) AgentSessionWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	log.Info().Str("sessionId", sessionID).Msg("AgentSessionWebSocket: connection request")

	// Get or create session state
	sessionState := h.agentMgr.GetOrCreateState(sessionID)

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
	// Diag: how many turn.complete frames this WS actually delivered (for working→idle race analysis)
	var turnCompletesDelivered atomic.Int32

	persistReadState := func() {
		n := int(seenResultCount.Load())
		sessionState.Mu.RLock()
		currentRC := sessionState.ResultCount
		sessionState.Mu.RUnlock()
		delivered := int(turnCompletesDelivered.Load())
		log.Info().
			Str("sessionId", sessionID).
			Int("seenResultCount", n).
			Int("currentResultCount", currentRC).
			Int("turnCompletesDelivered", delivered).
			Msg("[diag] WS disconnect: persisting read state")
		if n > 0 {
			if err := h.server.AppDB().MarkAgentSessionRead(context.Background(), sessionID, n); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist read state")
			} else {
				h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "read")
			}
		}
	}
	defer persistReadState()

	// Mark session as read on connect.
	//
	// Do NOT pre-seed seenResultCount here. The write loop replays the full
	// rawMessages history (cursor=0) and increments seenResultCount once per
	// turn.complete frame it delivers — including the historical ones. Storing
	// rc here would double-count: seenResultCount would end up at ~2*rc, and
	// the deferred persistReadState would push lastRead beyond ResultCount,
	// permanently masking the "unread" state for every future turn.
	sessionState.Mu.RLock()
	rc := sessionState.ResultCount
	sessionState.Mu.RUnlock()
	log.Info().Str("sessionId", sessionID).Int("resultCount", rc).Msg("WS connect: marking session read")
	if rc > 0 {
		if err := h.server.AppDB().MarkAgentSessionRead(ctx, sessionID, rc); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to mark session read on connect")
		} else {
			h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "read")
		}
	}

	// Send session.info before registering so the frontend knows active/processing
	// state before any content frames arrive. Also carry the session's agent
	// type and a baseline configOptions list (same source as /api/agent/config),
	// so the UI can render the per-session dropdown for agents that don't emit
	// an ACP config_option_update frame (gemini/qwen/opencode). Real ACP frames
	// from claude_code/codex arrive after and overwrite this baseline.
	sessionState.Mu.RLock()
	isActive := sessionState.IsActive
	isProcessing := sessionState.IsProcessing()
	sessionState.Mu.RUnlock()

	infoFields := map[string]any{
		"type":         "session.info",
		"isActive":     isActive,
		"isProcessing": isProcessing,
	}
	if rec, err := h.server.AppDB().GetAgentSession(sessionID); err == nil && rec != nil {
		infoFields["agentType"] = rec.AgentType
		if opts := buildAgentConfigOptions(rec.AgentType, h.server.Cfg().AgentLLM.Models); len(opts) > 0 {
			infoFields["defaultConfigOptions"] = opts
		}
	}
	if infoFrame, err := json.Marshal(infoFields); err == nil {
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
					newSeen := seenResultCount.Add(1)
					newDelivered := turnCompletesDelivered.Add(1)
					sessionState.Mu.RLock()
					currentRC := sessionState.ResultCount
					ctxErr := ctx.Err() != nil
					sessionState.Mu.RUnlock()
					log.Info().
						Str("sessionId", sessionID).
						Int("seenResultCount", int(newSeen)).
						Int("turnCompletesDelivered", int(newDelivered)).
						Int("currentResultCount", currentRC).
						Bool("ctxCancelled", ctxErr).
						Msg("[diag] WS write: delivered turn.complete")
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
			sessionRecord, _ := h.server.AppDB().GetAgentSession(sessionID)
			if sessionRecord == nil || sessionRecord.WorkingDir == "" {
				log.Info().Str("sessionId", sessionID).Msg("session not found in DB or no working dir — skipping history load")
				sessionState.Mu.Lock()
				sessionState.HistoryError = "session not found or no working directory"
				sessionState.Mu.Unlock()
				return
			}

			log.Info().Str("sessionId", sessionID).Str("workingDir", sessionRecord.WorkingDir).Msg("found session in DB, spawning ACP process for session/load")
			agentType := parseAgentType(sessionRecord.AgentType)
			mode, _ := h.server.AppDB().GetAgentSessionPermissionMode(sessionID)

			sess, err := h.server.AgentClient().CreateSession(h.server.ShutdownContext(), agentsdk.SessionConfig{
				Agent:        agentType,
				Mode:         mode,
				WorkingDir:   sessionRecord.WorkingDir,
				McpServers:   h.agentMgr.buildSessionMcpServers(sessionRecord.StorageID),
				SystemPrompt: server.BuildAgentSystemPrompt(h.server.Cfg().UserDataDir, sessionRecord.StorageID),
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

			gatewayModels := h.agentMgr.GatewayModels(sessionRecord.AgentType)
			var defaultModel string
			if len(gatewayModels) > 0 {
				defaultModel = gatewayModels[0].Value
			}
			// Pass empty defaultModel here — LoadSession would overwrite it anyway.
			// We re-apply the model explicitly AFTER LoadSession so legacy sessions
			// that stored an old (now-unavailable) model get reset to a valid one.
			h.agentMgr.SetupACP(sess, sessionID, mode, "")

			if err := sess.LoadSession(h.server.ShutdownContext(), sessionID, sessionRecord.WorkingDir); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("LoadSession failed")
				sessionState.Mu.Lock()
				sessionState.HistoryError = err.Error()
				sessionState.Mu.Unlock()
			} else {
				log.Info().Str("sessionId", sessionID).Msg("historical session replay complete")
				// Override the loaded session's stored model with a gateway-compatible one.
				// Use UnstableSetSessionModel (SetModel) to bypass claude-agent-acp's
				// allowlist check, which would reject custom gateway model names.
				// qwen skipped here for the same reason as AgentManager.SetupACP:
				// its ACP session/set_model validates against a static authType
				// registry that doesn't know our gateway-proxied model names.
				// Model is env-driven (OPENAI_MODEL) and auto-captured as a
				// RuntimeModelSnapshot on process boot — so calling SetModel only
				// produces a misleading "not found for authType" warning.
				if defaultModel != "" && sess.AgentType() != agentsdk.AgentQwen {
					modelCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					modelForACP := resolveACPModel(sess.AgentType(), defaultModel)
					if err := sess.SetModel(modelCtx, modelForACP); err != nil {
						log.Warn().Err(err).Str("sessionId", sessionID).Str("model", modelForACP).Msg("failed to override model after LoadSession")
					}
					cancel()
				}
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
			Type        string          `json:"type"`
			SessionID   string          `json:"sessionId"`
			Content     json.RawMessage `json:"content,omitempty"`
			ModeID      string          `json:"modeId,omitempty"`
			ModelID     string          `json:"modelId,omitempty"`
			ToolCallID  string          `json:"toolCallId,omitempty"`
			OptionID    string          `json:"optionId,omitempty"`
			ConfigID    string          `json:"configId,omitempty"`
			ConfigValue string          `json:"configValue,omitempty"`
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
			acpSession, exists := h.agentMgr.GetSession(sessionID)

			// Diagnostic: check if existing session's process is still alive
			if exists {
				select {
				case <-acpSession.Done():
					log.Info().Str("sessionId", sessionID).Msg("[diag] existing ACP session process is dead, removing for lazy recreation")
					h.agentMgr.RemoveSession(sessionID)
					exists = false
				default:
					log.Info().Str("sessionId", sessionID).Msg("[diag] existing ACP session process is alive")
				}
			}

			if !exists {
				log.Info().Str("sessionId", sessionID).Msg("no ACP session in memory, creating lazily for prompt")
				// Look up session metadata from DB for agent type, working dir, permission mode
				agentType := agentsdk.AgentClaudeCode
				workDir := ""
				lazyStorageID := ""
				if sessionRecord, _ := h.server.AppDB().GetAgentSession(sessionID); sessionRecord != nil {
					if sessionRecord.AgentType == "codex" {
						agentType = agentsdk.AgentCodex
					}
					workDir = sessionRecord.WorkingDir
					lazyStorageID = sessionRecord.StorageID
				}
				mode, _ := h.server.AppDB().GetAgentSessionPermissionMode(sessionID)

				// Create a new ACP session
				sess, err := h.server.AgentClient().CreateSession(h.server.ShutdownContext(), agentsdk.SessionConfig{
					Agent:        agentType,
					Mode:         mode,
					WorkingDir:   workDir,
					McpServers:   h.agentMgr.buildSessionMcpServers(lazyStorageID),
					SystemPrompt: server.BuildAgentSystemPrompt(h.server.Cfg().UserDataDir, lazyStorageID),
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
				agentTypeStr := "claude_code"
				if agentType == agentsdk.AgentCodex {
					agentTypeStr = "codex"
				}
				gatewayModels := h.agentMgr.GatewayModels(agentTypeStr)
				var defaultModel string
				if len(gatewayModels) > 0 {
					defaultModel = gatewayModels[0].Value
				}
				h.agentMgr.SetupACP(sess, sessionID, mode, defaultModel)
				acpSession = sess
			}

			// Update the session's updated_at so the session list re-sorts
			// by last user activity (agent responses don't touch this).
			if err := h.server.AppDB().TouchAgentSession(ctx, sessionID); err != nil {
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

					// Diagnostic: log error/turn.complete events from events channel
					var ft struct{ Type string `json:"type"` }
					if json.Unmarshal(frame, &ft) == nil && (ft.Type == "error" || ft.Type == "turn.complete") {
						log.Info().Str("sessionId", sessionID).Str("eventType", ft.Type).Int("frameCount", frameCount).Msg("[diag] events-channel frame")
					}

					sessionState.AppendAndBroadcast(frame)
				}
				// Channel closed = turn complete
				log.Info().Str("sessionId", sessionID).Int("frameCount", frameCount).Msg("[diag] events channel closed")
				sessionState.Mu.Lock()
				killed := sessionState.Killed
				newResultCount := sessionState.ResultCount
				if !killed {
					sessionState.ResultCount++
					newResultCount = sessionState.ResultCount
					sessionState.SetProcessing(false, "ws-prompt-complete")
				}
				sessionState.ClearPrompt()
				sessionState.Mu.Unlock()

				if !killed {
					log.Info().
						Str("sessionId", sessionID).
						Int("resultCount", newResultCount).
						Str("source", "ws-prompt-complete").
						Msg("[diag] turn complete: ResultCount++")
					h.server.Notifications().NotifyAgentSessionUpdated(sessionID, "result")
				}
			}(acpSession, promptText, promptCtx, pCancel)

			// Auto-unarchive
			if archived, err := h.server.AppDB().IsAgentSessionArchived(sessionID); err == nil && archived {
				if err := h.server.AppDB().UnarchiveAgentSession(ctx, sessionID); err != nil {
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
			acpSession, exists := h.agentMgr.GetSession(sessionID)

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
			acpSession, exists := h.agentMgr.GetSession(sessionID)
			if exists {
				h.agentMgr.RemoveSession(sessionID)
			}

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
			// Mode uses legacy SetSessionMode RPC (only Claude Code has modes)
			acpSession, exists := h.agentMgr.GetSession(sessionID)

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
			// Legacy message type — route through SetConfigOption
			inMsg.ConfigID = "model"
			inMsg.ConfigValue = inMsg.ModelID
			fallthrough

		case "session.setConfigOption":
			acpSession, exists := h.agentMgr.GetSession(sessionID)

			if exists {
				cfgCtx, cfgCancel := context.WithTimeout(context.Background(), 10*time.Second)
				// Mode uses the legacy SetSessionMode RPC — SetSessionConfigOption
				// in Claude Code only supports configId="model", not "mode".
				// Model uses UnstableSetSessionModel to bypass claude-agent-acp's
				// allowlist (which rejects custom gateway model names).
				//
				// Known limitation for qwen: this RPC call errors for qwen because
				// qwen validates modelId against a static authType registry (see
				// the long comment in AgentManager.SetupACP). The error surfaces
				// to the frontend as a failed model change — mid-session model
				// switching for qwen requires a process restart, which isn't wired
				// up yet. For now, qwen users should pick the model at session
				// creation; the dropdown in an existing session won't propagate.
				if inMsg.ConfigID == "mode" {
					if err := acpSession.SetMode(cfgCtx, inMsg.ConfigValue); err != nil {
						log.Error().Err(err).Str("sessionId", sessionID).Str("mode", inMsg.ConfigValue).Msg("failed to set mode")
					} else {
						log.Info().Str("sessionId", sessionID).Str("mode", inMsg.ConfigValue).Msg("mode set via WebSocket")
					}
				} else if inMsg.ConfigID == "model" {
					modelForACP := resolveACPModel(acpSession.AgentType(), inMsg.ConfigValue)
					if err := acpSession.SetModel(cfgCtx, modelForACP); err != nil {
						log.Error().Err(err).Str("sessionId", sessionID).Str("model", modelForACP).Msg("failed to set model")
					} else {
						log.Info().Str("sessionId", sessionID).Str("model", modelForACP).Msg("model set via WebSocket")
					}
				} else {
					if err := acpSession.SetConfigOption(cfgCtx, inMsg.ConfigID, inMsg.ConfigValue); err != nil {
						log.Error().Err(err).Str("sessionId", sessionID).Str("configId", inMsg.ConfigID).Str("value", inMsg.ConfigValue).Msg("failed to set config option")
					} else {
						log.Info().Str("sessionId", sessionID).Str("configId", inMsg.ConfigID).Str("value", inMsg.ConfigValue).Msg("config option set via WebSocket")
					}
				}
				cfgCancel()
			}

		case "permission.respond":
			acpSession, exists := h.agentMgr.GetSession(sessionID)

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

