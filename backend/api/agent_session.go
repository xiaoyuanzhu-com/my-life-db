package api

import (
	"context"
	"encoding/json"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

// SessionParams configures a new agent session. Used by both the REST API
// (user-initiated) and the agent runner (auto-triggered).
type SessionParams struct {
	AgentType      string              // "claude_code" or "codex"
	WorkingDir     string
	Title          string
	Message        string              // initial prompt; empty = no prompt sent
	PermissionMode string              // e.g. "bypassPermissions"; empty = default
	DefaultModel   string              // default model to set via ACP (from AGENT_MODELS)
	GatewayModels  []server.AgentModelInfo // when set, replaces model options in ACP frames
	Source         string              // "user" or "auto"
	AgentFile      string              // agent definition file (auto-run only)
}

// SetupACPSession wires frame broadcasting, sets mode/model, and stores the
// session in the in-memory map. This is the single entrypoint for session
// setup after ACP process creation — used by CreateSession, history-load,
// and lazy-create paths.
//
// Model is set via the generic SetSessionConfigOption RPC (both agents support it).
// Mode uses the legacy SetSessionMode RPC (only Claude Code has modes;
// Codex doesn't expose mode as a configOption).
//
// When gatewayModels is non-empty, the model options in config_option_update
// frames are replaced with the gateway model list so the UI only shows
// models available through the LLM proxy.
func SetupACPSession(sess agentsdk.Session, sessionID, mode, defaultModel string, gatewayModels []server.AgentModelInfo) *agentsdk.SessionState {
	sessionState := GetOrCreateSessionState(sessionID)
	sess.SetOnFrame(func(data []byte) {
		if len(gatewayModels) > 0 {
			data = rewriteModelOptions(data, gatewayModels)
		}
		sessionState.Mu.Lock()
		sessionState.TouchFrame()
		sessionState.Mu.Unlock()
		sessionState.AppendAndBroadcast(data)
	})

	// Set mode after onFrame so the mode-change event is captured.
	// Uses legacy SetSessionMode — only Claude Code supports modes.
	if mode != "" && sess.AgentType() == agentsdk.AgentClaudeCode {
		if err := sess.SetMode(context.Background(), mode); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Str("mode", mode).Msg("failed to set initial mode")
		}
	}

	// Set default model via UnstableSetSessionModel. Using SetConfigOption for
	// "model" would hit claude-agent-acp's allowlist (built from the CLI's
	// advertised model list + ANTHROPIC_MODEL) and reject arbitrary gateway
	// model names. UnstableSetSessionModel bypasses that check and calls the
	// CLI's set_model directly, which accepts any string.
	if defaultModel != "" {
		if err := sess.SetModel(context.Background(), defaultModel); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Str("model", defaultModel).Msg("failed to set initial model")
		}
	}

	StoreAcpSession(sessionID, sess)
	return sessionState
}

// rewriteModelOptions replaces the model config option in a config_option_update
// frame with the gateway model list. Non-config_option_update frames pass through
// unchanged. This ensures the UI only shows models available through the LLM proxy.
func rewriteModelOptions(data []byte, gatewayModels []server.AgentModelInfo) []byte {
	var frame struct {
		SessionUpdate string            `json:"sessionUpdate"`
		ConfigOptions []json.RawMessage `json:"configOptions"`
	}
	if err := json.Unmarshal(data, &frame); err != nil || frame.SessionUpdate != "config_option_update" {
		return data // not a config_option_update frame
	}

	modified := false
	for i, raw := range frame.ConfigOptions {
		var opt struct {
			Category string `json:"category"`
		}
		if err := json.Unmarshal(raw, &opt); err != nil || opt.Category != "model" {
			continue
		}

		// Parse full option, replace options array and default
		var full map[string]any
		if err := json.Unmarshal(raw, &full); err != nil {
			continue
		}

		opts := make([]map[string]string, len(gatewayModels))
		for j, m := range gatewayModels {
			opts[j] = map[string]string{
				"value": m.Value, "name": m.Name, "description": m.Description,
			}
		}
		full["options"] = opts

		// Preserve the agent-reported currentValue if it's a known gateway
		// model. Only fall back to gatewayModels[0] when the agent reports
		// something we don't recognize (e.g., an SDK internal default like
		// "default" or "claude-sonnet-4-6"). Without this guard, switching to
		// a non-first gateway model would appear to the UI as still-selecting
		// the first one.
		currentVal, _ := full["currentValue"].(string)
		known := false
		for _, m := range gatewayModels {
			if m.Value == currentVal {
				known = true
				break
			}
		}
		if !known {
			full["currentValue"] = gatewayModels[0].Value
		}

		if rewritten, err := json.Marshal(full); err == nil {
			frame.ConfigOptions[i] = rewritten
			modified = true
		}
	}

	if !modified {
		return data
	}

	// Rebuild the full frame
	result := map[string]any{
		"sessionUpdate": frame.SessionUpdate,
		"configOptions": frame.ConfigOptions,
	}
	if out, err := json.Marshal(result); err == nil {
		return out
	}
	return data
}

// SessionHandle is returned by CreateSession so the caller can manage
// the session lifecycle (e.g. close after completion for auto-run).
type SessionHandle struct {
	ID           string
	AcpSession   agentsdk.Session
	SessionState *agentsdk.SessionState
	// PromptDone is closed when the initial prompt completes.
	// Nil if no message was provided.
	PromptDone <-chan struct{}
}

// CreateSession is the shared internal function for creating an agent session.
// It spawns the ACP process, persists to DB, wires frame broadcasting, synths
// the user message, and sends the initial prompt.
//
// The caller owns the ACP session lifecycle — for user sessions it stays alive
// for interactive WebSocket use; for auto-run sessions the caller closes it
// after the prompt completes.
func CreateSession(
	ctx context.Context,
	agentClient *agentsdk.Client,
	notifService *notifications.Service,
	shutdownCtx context.Context,
	params SessionParams,
) (*SessionHandle, error) {
	// Map agentType string to agentsdk.AgentType
	agentTypeStr := params.AgentType
	if agentTypeStr == "" {
		agentTypeStr = "claude_code"
	}
	agentType := agentsdk.AgentClaudeCode
	if agentTypeStr == "codex" {
		agentType = agentsdk.AgentCodex
	}

	// When the caller picked a non-default gateway model, override the env
	// vars the agent process would normally inherit from the pre-warmed pool.
	// This keeps the spawned process's ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL
	// (or OPENAI_MODEL) consistent with the session's selected model, so
	// fallback paths and secondary requests use the same model the user chose.
	// Passing a non-empty Env also causes the pool to be skipped for this call
	// (pool env is baked at process spawn and can't be changed post-hoc).
	var sessionEnv map[string]string
	if params.DefaultModel != "" && len(params.GatewayModels) > 0 && params.DefaultModel != params.GatewayModels[0].Value {
		sessionEnv = make(map[string]string, 2)
		switch agentType {
		case agentsdk.AgentClaudeCode:
			sessionEnv["ANTHROPIC_MODEL"] = params.DefaultModel
			smallModel := params.DefaultModel
			for _, m := range params.GatewayModels {
				if m.Value == params.DefaultModel {
					if m.ClaudeSmall != "" {
						smallModel = m.ClaudeSmall
					}
					break
				}
			}
			sessionEnv["ANTHROPIC_SMALL_FAST_MODEL"] = smallModel
		case agentsdk.AgentCodex:
			sessionEnv["OPENAI_MODEL"] = params.DefaultModel
		}
	}

	// Spawn ACP agent process.
	sess, err := agentClient.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:      agentType,
		Mode:       params.PermissionMode,
		WorkingDir: params.WorkingDir,
		Env:        sessionEnv,
	})
	if err != nil {
		return nil, err
	}

	sessionID := sess.ID()

	// Persist to database
	if err := db.CreateAgentSession(sessionID, agentTypeStr, params.WorkingDir, params.Title, params.Source, params.AgentFile); err != nil {
		log.Error().Err(err).Msg("failed to create agent session in DB")
		sess.Close()
		return nil, err
	}

	// Save permission mode if provided
	if params.PermissionMode != "" {
		db.SaveAgentSessionPermissionMode(sessionID, params.PermissionMode)
	}

	// Common setup: wire broadcasting, set mode/model, store in map
	sessionState := SetupACPSession(sess, sessionID, params.PermissionMode, params.DefaultModel, params.GatewayModels)

	log.Info().
		Str("sessionId", sessionID).
		Str("agentType", agentTypeStr).
		Str("workingDir", params.WorkingDir).
		Str("source", params.Source).
		Msg("agent session created")

	// Synthesize user message so it appears in the chat UI
	var promptDone chan struct{}
	if params.Message != "" {
		promptDone = make(chan struct{})
		sessionState.AppendAndBroadcast(agentsdk.SynthUserMessageChunk(params.Message))

		// Send prompt in a background goroutine
		go func(acpSess agentsdk.Session, prompt string) {
			defer close(promptDone)

			sessionState.Mu.Lock()
			sessionState.SetProcessing(true, params.Source+"-prompt")
			sessionState.IsActive = true
			sessionState.TouchFrame()
			sessionState.Mu.Unlock()
			notifService.NotifyAgentSessionUpdated(sessionID, "working")

			sendCtx, cancel := context.WithCancel(shutdownCtx)
			defer cancel()

			// Register with SessionState so WS handler can coordinate
			internalDone := make(chan struct{})
			defer close(internalDone)
			sessionState.Mu.Lock()
			sessionState.RegisterPrompt(internalDone, cancel)
			sessionState.Mu.Unlock()

			// Monitor process exit
			go func() {
				select {
				case <-acpSess.Done():
					log.Info().Str("sessionId", sessionID).Msg("agent process exited during prompt")
					cancel()
				case <-sendCtx.Done():
				}
			}()

			// Emit turn.start so the frontend knows processing has begun.
			// Stored in rawMessages for burst replay on reconnect.
			if startBytes, err := json.Marshal(map[string]any{
				"type": "turn.start",
			}); err == nil {
				sessionState.AppendAndBroadcast(startBytes)
			}

			events, err := acpSess.Send(sendCtx, prompt)
			if err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send prompt")
				sessionState.Mu.Lock()
				sessionState.SetProcessing(false, params.Source+"-prompt-send-error")
				sessionState.Mu.Unlock()
				if errBytes, err := json.Marshal(map[string]any{
					"type": "error", "message": "Failed to send message: " + err.Error(), "code": "SEND_ERROR",
				}); err == nil {
					sessionState.AppendAndBroadcast(errBytes)
				}
				notifService.NotifyAgentSessionUpdated(sessionID, "result")
				return
			}

			// The events channel contains synthetic frames (turn.complete,
			// session.modeUpdate, session.modelsUpdate, errors) that are NOT
			// delivered via onFrame — they must be broadcast explicitly.
			for frame := range events {
				sessionState.AppendAndBroadcast(frame)
			}

			// Channel closed = turn complete
			sessionState.Mu.Lock()
			sessionState.ResultCount++
			sessionState.SetProcessing(false, params.Source+"-prompt-complete")
			sessionState.ClearPrompt()
			sessionState.Mu.Unlock()

			notifService.NotifyAgentSessionUpdated(sessionID, "result")
		}(sess, params.Message)
	}

	return &SessionHandle{
		ID:           sessionID,
		AcpSession:   sess,
		SessionState: sessionState,
		PromptDone:   promptDone,
	}, nil
}
