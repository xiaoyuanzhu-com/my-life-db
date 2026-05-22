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
	"github.com/xiaoyuanzhu-com/my-life-db/db"
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

	persistReadState := func() {
		n := int(seenResultCount.Load())
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
	// ResultCount is seeded from DB on state creation (see GetOrCreateState),
	// so on first connect after restart rc reflects the true total — historical
	// turn.complete frames replayed by the write loop will then bring
	// seenResultCount up to (and not past) rc. Don't pre-seed seenResultCount
	// here; let the write loop do the counting so we observe what was actually
	// delivered to the client.
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
			// Overlay persisted per-session preferences so the dropdown opens on
			// the user's saved value instead of the agent-type default. Mode
			// lives in its own column for legacy reasons; everything else is in
			// config_options.
			persisted, _ := h.server.AppDB().GetAgentSessionConfigOptions(sessionID)
			persistedMode, _ := h.server.AppDB().GetAgentSessionPermissionMode(sessionID)
			for i := range opts {
				if opts[i].ID == "mode" {
					if persistedMode != "" {
						opts[i].CurrentValue = persistedMode
					}
					continue
				}
				if v, ok := persisted[opts[i].ID]; ok && v != "" {
					opts[i].CurrentValue = v
				}
			}
			infoFields["defaultConfigOptions"] = opts
		}
		// Outcome of the most recent turn — surfaced to the frontend so it can
		// render the Resume banner for interrupted/cancelled/errored states.
		// lastPromptText accompanies any non-empty outcome so the Resume button
		// has something to re-send.
		if rec.LastTurnOutcome != "" {
			infoFields["lastTurnOutcome"] = rec.LastTurnOutcome
			infoFields["lastPromptText"] = rec.LastPromptText
			if rec.LastTurnOutcomeAt != nil {
				infoFields["lastTurnOutcomeAt"] = *rec.LastTurnOutcomeAt
			}
			if rec.LastErrorMessage != "" {
				infoFields["lastErrorMessage"] = rec.LastErrorMessage
			}
		}
		infoFields["source"] = rec.Source
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

	// If no messages in memory (e.g., server restart), try loading history.
	// Phase 1: try the local JSONL frame store (instant, no agent process needed).
	// Phase 2: fall back to ACP session/load if disk has no data.
	// sync.Once ensures only one concurrent connection triggers history loading;
	// others block until it completes, then receive frames via the cursor-based write loop.
	if sessionState.MessageCount() == 0 {
		sessionState.HistoryOnce.Do(func() {
			// --- Phase 1: Disk-based frame replay ---
			if fs := h.server.FrameStore(); fs != nil {
				frames, err := fs.Load(sessionID)
				if err != nil {
					log.Info().Err(err).Str("sessionId", sessionID).Msg("frame_store: load error, falling back to ACP session/load")
				} else if len(frames) > 0 {
					log.Info().Str("sessionId", sessionID).Int("frameCount", len(frames)).Msg("frame_store: loaded history from disk, skipping ACP session/load")
					sessionState.LoadHistoricalFrames(frames)
					// Mark history as done — no ACP load needed.
					return
				}
			}

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

			// Resolve the model to spawn with: per-session preference if set,
			// else the agent type's gateway default. Env vars from BuildModelEnv
			// make the process boot directly with the right model.
			gatewayModels := h.agentMgr.GatewayModels(sessionRecord.AgentType)
			var defaultModel string
			if len(gatewayModels) > 0 {
				defaultModel = gatewayModels[0].Value
			}
			persistedOpts, _ := h.server.AppDB().GetAgentSessionConfigOptions(sessionID)
			if v := persistedOpts["model"]; v != "" {
				defaultModel = v
			}

			sess, err := h.server.AgentClient().CreateSession(h.server.ShutdownContext(), agentsdk.SessionConfig{
				Agent:        agentType,
				Mode:         mode,
				WorkingDir:   sessionRecord.WorkingDir,
				Env:          h.agentMgr.BuildModelEnv(agentType, defaultModel, gatewayModels),
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
			MessageID   string          `json:"messageId,omitempty"`
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
			// Per-session dedup of client-minted message IDs. Drops
			// duplicate retransmits from the frontend outbox after a
			// connection flap or page refresh — without this, an
			// outbox item that was inflight when the WS died would
			// land twice (once on the original send, once on the
			// flush after reconnect). No-op when the field is absent.
			if inMsg.MessageID != "" && sessionState.CheckAndRememberMessageID(inMsg.MessageID) {
				log.Info().
					Str("sessionId", sessionID).
					Str("messageId", inMsg.MessageID).
					Msg("dropping duplicate session.prompt (already seen)")
				continue
			}

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

			acpSession, err := h.ensureLiveACPSession(sessionID, sessionState)
			if err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to ensure live ACP session for prompt")
				if errBytes, mErr := json.Marshal(map[string]any{
					"type": "error", "message": "Failed to create agent session: " + err.Error(), "code": "SESSION_ERROR",
				}); mErr == nil {
					conn.Write(ctx, websocket.MessageText, errBytes)
				}
				continue
			}
			if acpSession == nil {
				log.Error().Str("sessionId", sessionID).Msg("no session record in DB for prompt")
				if errBytes, mErr := json.Marshal(map[string]any{
					"type": "error", "message": "Session not found", "code": "SESSION_NOT_FOUND",
				}); mErr == nil {
					conn.Write(ctx, websocket.MessageText, errBytes)
				}
				continue
			}

			// Update the session's updated_at so the session list re-sorts
			// by last user activity (agent responses don't touch this).
			if err := h.server.AppDB().TouchAgentSession(ctx, sessionID); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to touch agent session")
			}

			// Synthesize user_message_chunk BEFORE Send() so the user's message
			// is in rawMessages for burst replay on page refresh. Echo the
			// client-minted messageId (when present) so the frontend can
			// ack-match the originating outbox item by id.
			sessionState.AppendAndBroadcast(agentsdk.SynthUserMessageChunk(promptText, inMsg.MessageID))

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

			// Persist prompt in DB so a crash/restart can surface the
			// interrupted banner. Fire-and-forget; failure is non-fatal.
			if err := h.server.AppDB().SetPromptInFlight(ctx, sessionID, promptText); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to set prompt in-flight in DB")
			}

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
						if dbErr := h.server.AppDB().MarkTurnOutcome(context.Background(), sessionID, db.OutcomeErrored, err.Error(), db.NowMs()); dbErr != nil {
							log.Warn().Err(dbErr).Str("sessionId", sessionID).Msg("failed to persist errored outcome")
						}
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
					// Persist the completed outcome (clears is_processing, bumps last_message_at).
					if err := h.server.AppDB().MarkTurnOutcome(context.Background(), sessionID, db.OutcomeCompleted, "", db.NowMs()); err != nil {
						log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist completed outcome")
					}
					// Persist the new count so the unread dot survives a server restart.
					if err := h.server.AppDB().UpdateAgentSessionResultCount(context.Background(), sessionID, newResultCount); err != nil {
						log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist result count")
					}
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
				Int("promptLen", len(promptText)).
				Msg("prompt sent to agent session via WebSocket")

		case "session.cancel":
			// HEAVY-HANDED CANCEL — kills the ACP subprocess and forces a
			// fresh one on the next prompt.
			//
			// Why: sending only the ACP Cancel notification + cancelling our
			// per-prompt ctx (the "proper" way) leaves Claude Code's server
			// in a state where the *next* conn.Prompt() call returns
			// immediately with stopReason=end_turn and zero content frames.
			// The user's next turn then renders as just a user message with
			// no reply. Verified symptom: backend logs show
			//     ACP prompt completed stop_reason=end_turn
			// for the new prompt with no agent_message_chunk frames between
			// IsProcessing=true and the completion. Restarting the backend
			// recovers (same code path runs below — lazy create on next
			// prompt), which is what we replicate here per-cancel.
			//
			// Likely cause: we cancel our ctx (pc() below) before Claude
			// Code's server has finished its own cancel handling, abandoning
			// the in-flight Prompt request mid-flight. Late frames arriving
			// after our synthetic turn.complete confirm the server was still
			// processing. The state machines desync, and Claude Code rejects
			// the next prompt as if the previous turn never closed.
			//
			// Cost of this workaround:
			//   - Spawns a fresh claude-agent-acp subprocess (~few-hundred-ms
			//     startup) on the next prompt after every stop.
			//   - The lazy-create path on the next prompt now calls
			//     LoadSession (see "if workDir != "" && sessionState.MessageCount() > 0"
			//     branch above), so Claude Code's in-session conversation
			//     memory IS restored on the recreated subprocess. UI history
			//     is preserved in rawMessages.
			//
			// Migration path to a proper implementation:
			//   1. Try removing pc() and letting conn.Prompt() return
			//      naturally when Claude Code responds to the Cancel
			//      notification (stopReason=cancelled). Add a fallback
			//      timeout (~3s) that *then* falls back to Close() if the
			//      server is genuinely wedged. If this works, conversation
			//      memory is preserved across cancels.
			//   2. Watch coder/acp-go-sdk and zed-industries/claude-code-acp
			//      (a.k.a. claude-agent-acp) for fixes. Specifically a
			//      protocol-level "cancel ack" that lets the client know
			//      when the server has actually finished cancelling, or a
			//      bug fix on the server side that handles a fresh Prompt
			//      cleanly even if the previous one was abandoned.
			//   3. If/when migrated, this whole branch goes back to the
			//      old shape: Stop() + pc() + ack broadcast, no Close().
			//
			// See also: 3s sendKill safety net was removed from the frontend
			// (use-agent-runtime.ts onCancel) at the same time as introducing
			// this — it's redundant when cancel always reliably terminates,
			// and was racy because a new prompt within 3s would arm the
			// timer to kill the *new* turn's freshly-created ACP session.
			acpSession, exists := h.agentMgr.GetSession(sessionID)

			// Mark the turn as cancelled BEFORE we tear down the ACP session so
			// the events-channel cleanup goroutine (line ~629) sees Killed=true
			// when it acquires the lock and skips the ResultCount++ / completed
			// outcome write that would otherwise misclassify a cancel as a clean
			// completion.
			sessionState.Mu.Lock()
			sessionState.Killed = true
			sessionState.Mu.Unlock()

			if exists {
				h.agentMgr.RemoveSession(sessionID)
				acpSession.CancelAllPermissions()
				if err := acpSession.Close(); err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to close agent session on cancel")
				} else {
					log.Info().Str("sessionId", sessionID).Msg("agent session cancelled via WebSocket (process closed)")
				}
			}

			// Cancel the per-prompt context so conn.Prompt() returns
			// promptly. The acpSess.Done() watcher also fires pCancel when
			// the process exits; calling it here is idempotent and avoids
			// waiting on the OS-level process death.
			sessionState.Mu.RLock()
			pc := sessionState.PromptCancel
			sessionState.Mu.RUnlock()
			if pc != nil {
				pc()
			}

			// Persist the cancelled outcome (also clears is_processing).
			if err := h.server.AppDB().MarkTurnOutcome(context.Background(), sessionID, db.OutcomeCancelled, "", db.NowMs()); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist cancelled outcome")
			}

			// Send ack so the client can immediately update UI (stop
			// spinner, clear permissions). turn.complete from the SDK will
			// arrive later (synth turn.complete on ctx-cancel path) but the
			// Killed flag suppresses its broadcast; session.cancelled is
			// idempotent on the frontend.
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

			// Persist the cancelled outcome — kill is just the force version of
			// cancel, both are user-initiated stops.
			if err := h.server.AppDB().MarkTurnOutcome(context.Background(), sessionID, db.OutcomeCancelled, "", db.NowMs()); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist cancelled outcome (kill)")
			}

			if completeBytes, err := json.Marshal(map[string]any{
				"type":       "turn.complete",
				"stopReason": "killed",
			}); err == nil {
				sessionState.AppendAndBroadcast(completeBytes)
			}

		case "session.setMode":
			// Mode uses legacy SetSessionMode RPC (only Claude Code has modes).
			// Persist first so the choice survives a respawn — the lazy-spawn
			// path inside ensureLiveACPSession reads permission_mode back via
			// GetAgentSessionPermissionMode when it has to start a new agent.
			if err := h.server.AppDB().SaveAgentSessionPermissionMode(ctx, sessionID, inMsg.ModeID); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist mode preference")
			}

			acpSession, err := h.ensureLiveACPSession(sessionID, sessionState)
			if err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to ensure live ACP session for setMode")
				continue
			}
			if acpSession == nil {
				log.Warn().Str("sessionId", sessionID).Msg("no session record for setMode")
				continue
			}

			modeCtx, modeCancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := acpSession.SetMode(modeCtx, inMsg.ModeID); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Str("modeId", inMsg.ModeID).Msg("failed to set mode")
			} else {
				log.Info().Str("sessionId", sessionID).Str("modeId", inMsg.ModeID).Msg("mode set via WebSocket")
			}
			modeCancel()

		case "session.setModel":
			// Legacy message type — route through SetConfigOption
			inMsg.ConfigID = "model"
			inMsg.ConfigValue = inMsg.ModelID
			fallthrough

		case "session.setConfigOption":
			// Persist first so the choice survives a respawn. The lazy-spawn
			// path inside ensureLiveACPSession reads these values back via
			// GetAgentSessionConfigOptions / GetAgentSessionPermissionMode.
			if inMsg.ConfigID == "mode" {
				if err := h.server.AppDB().SaveAgentSessionPermissionMode(ctx, sessionID, inMsg.ConfigValue); err != nil {
					log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist mode preference")
				}
			} else {
				if err := h.server.AppDB().SaveAgentSessionConfigOption(ctx, sessionID, inMsg.ConfigID, inMsg.ConfigValue); err != nil {
					log.Warn().Err(err).Str("sessionId", sessionID).Str("configId", inMsg.ConfigID).Msg("failed to persist config option")
				}
			}

			acpSession, err := h.ensureLiveACPSession(sessionID, sessionState)
			if err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to ensure live ACP session for setConfigOption")
				continue
			}
			if acpSession == nil {
				log.Warn().Str("sessionId", sessionID).Msg("no session record for setConfigOption")
				continue
			}

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
				updatedOpts, err := acpSession.SetConfigOption(cfgCtx, inMsg.ConfigID, inMsg.ConfigValue)
				if err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Str("configId", inMsg.ConfigID).Str("value", inMsg.ConfigValue).Msg("failed to set config option")
				} else {
					log.Info().Str("sessionId", sessionID).Str("configId", inMsg.ConfigID).Str("value", inMsg.ConfigValue).Msg("config option set via WebSocket")
					// claude-agent-acp returns the updated options inline
					// instead of emitting a session/update notification, so
					// fan it out ourselves to keep the UI in sync.
					if frame, mErr := json.Marshal(map[string]any{
						"sessionUpdate": "config_option_update",
						"configOptions": updatedOpts,
					}); mErr == nil {
						sessionState.AppendAndBroadcast(frame)
					} else {
						log.Warn().Err(mErr).Str("sessionId", sessionID).Msg("failed to marshal config_option_update after SetConfigOption")
					}
				}
			}
			cfgCancel()

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

// ensureLiveACPSession returns a live ACP session for sessionID, spawning one
// lazily if the existing entry is missing or its process has exited.
//
// Used by every user-initiated WS handler (prompt, setMode, setConfigOption)
// so that any user input always lands on a live agent. The previous design
// branched on existence and synthesized a fake config_option_update frame
// when ACP was dead — which silently let session state desync from the
// dropdown (model snapping back to gateway default, effort vanishing).
//
// Returns (nil, nil) when there is no session record in the DB; callers
// should surface that distinctly from a spawn failure.
//
// Spawn parameters come from persisted state: agent type, working dir,
// storage id, permission mode, and last-selected model. When the session
// already has frames in memory, LoadSession is called so the new agent
// process inherits conversation memory.
func (h *Handlers) ensureLiveACPSession(sessionID string, sessionState *agentsdk.SessionState) (agentsdk.Session, error) {
	if existing, ok := h.agentMgr.GetSession(sessionID); ok {
		select {
		case <-existing.Done():
			log.Info().Str("sessionId", sessionID).Msg("existing ACP session process is dead, removing for lazy recreation")
			h.agentMgr.RemoveSession(sessionID)
		default:
			return existing, nil
		}
	}

	sessionRecord, _ := h.server.AppDB().GetAgentSession(sessionID)
	if sessionRecord == nil {
		return nil, nil
	}

	agentType := parseAgentType(sessionRecord.AgentType)
	agentTypeStr := agentTypeString(agentType)
	workDir := sessionRecord.WorkingDir
	storageID := sessionRecord.StorageID
	mode, _ := h.server.AppDB().GetAgentSessionPermissionMode(sessionID)

	gatewayModels := h.agentMgr.GatewayModels(agentTypeStr)
	var defaultModel string
	if len(gatewayModels) > 0 {
		defaultModel = gatewayModels[0].Value
	}
	persistedOpts, _ := h.server.AppDB().GetAgentSessionConfigOptions(sessionID)
	if v := persistedOpts["model"]; v != "" {
		defaultModel = v
	}

	log.Info().Str("sessionId", sessionID).Msg("no live ACP session, creating lazily")
	sess, err := h.server.AgentClient().CreateSession(h.server.ShutdownContext(), agentsdk.SessionConfig{
		Agent:        agentType,
		Mode:         mode,
		WorkingDir:   workDir,
		Env:          h.agentMgr.BuildModelEnv(agentType, defaultModel, gatewayModels),
		McpServers:   h.agentMgr.buildSessionMcpServers(storageID),
		SystemPrompt: server.BuildAgentSystemPrompt(h.server.Cfg().UserDataDir, storageID),
	})
	if err != nil {
		return nil, err
	}

	// Restore conversation memory if frames already exist. Noop OnFrame for
	// the duration of LoadSession so replayed frames don't dupe rawMessages
	// or the on-disk JSONL — both already contain them. SetupACP below
	// installs the real broadcasting handler.
	if workDir != "" && sessionState.MessageCount() > 0 {
		sess.SetOnFrame(func(_ []byte) {})
		if err := sess.LoadSession(h.server.ShutdownContext(), sessionID, workDir); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("LoadSession failed on lazy create — agent will start with empty memory")
		} else {
			log.Info().Str("sessionId", sessionID).Msg("LoadSession succeeded on lazy create — agent memory restored")
		}
	}

	h.agentMgr.SetupACP(sess, sessionID, mode, defaultModel)
	return sess, nil
}

