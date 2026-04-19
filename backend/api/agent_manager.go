package api

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

// resolveACPModel maps a MyLifeDB model value (e.g. "gpt-5.4") to the form
// expected by the target ACP agent's SetModel RPC. Opencode resolves IDs as
// <provider>/<modelID>; bare IDs silently no-op, so gateway-backed models
// need the "litellm/" prefix (matching the provider block in
// ~/.config/opencode/opencode.json). Other agents accept bare IDs.
func resolveACPModel(agentType agentsdk.AgentType, modelID string) string {
	if agentType == agentsdk.AgentOpencode && !strings.HasPrefix(modelID, "litellm/") {
		return "litellm/" + modelID
	}
	return modelID
}

// AgentManager owns the in-memory state for active ACP agent sessions and
// coordinates their lifecycle. Replaces the package-level globals
// (acpSessions, agentSessionStates) and free functions (CreateSession,
// StoreAcpSession, CleanupAgentSession, ...) that previously lived in api/.
type AgentManager struct {
	srv          *server.Server
	agentClient  *agentsdk.Client
	notifService *notifications.Service
	shutdownCtx  context.Context

	sessionsMu sync.Mutex
	sessions   map[string]agentsdk.Session

	statesMu sync.Mutex
	states   map[string]*agentsdk.SessionState
}

// NewAgentManager constructs a manager wired to the given server's components.
func NewAgentManager(srv *server.Server) *AgentManager {
	return &AgentManager{
		srv:          srv,
		agentClient:  srv.AgentClient(),
		notifService: srv.Notifications(),
		shutdownCtx:  srv.ShutdownContext(),
		sessions:     make(map[string]agentsdk.Session),
		states:       make(map[string]*agentsdk.SessionState),
	}
}

// GatewayModels returns the subset of AGENT_MODELS compatible with the given
// agent type. Resolved fresh each call so a config hot-reload takes effect.
func (m *AgentManager) GatewayModels(agentType string) []server.AgentModelInfo {
	return server.FilterModelsForAgent(m.srv.Cfg().AgentLLM.Models, agentType)
}

// agentTypeString converts the SDK enum to the string used in AGENT_MODELS
// and DB records.
func agentTypeString(t agentsdk.AgentType) string {
	switch t {
	case agentsdk.AgentCodex:
		return "codex"
	case agentsdk.AgentGemini:
		return "gemini"
	case agentsdk.AgentQwen:
		return "qwen"
	case agentsdk.AgentOpencode:
		return "opencode"
	default:
		return "claude_code"
	}
}

// parseAgentType converts the DB/AGENT_MODELS string back to the SDK enum.
// Unknown strings fall back to Claude Code.
func parseAgentType(s string) agentsdk.AgentType {
	switch s {
	case "codex":
		return agentsdk.AgentCodex
	case "gemini":
		return agentsdk.AgentGemini
	case "qwen":
		return agentsdk.AgentQwen
	case "opencode":
		return agentsdk.AgentOpencode
	default:
		return agentsdk.AgentClaudeCode
	}
}

// -------- Session map --------

// GetSession returns the live ACP session for the given ID, if any.
func (m *AgentManager) GetSession(sessionID string) (agentsdk.Session, bool) {
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	sess, ok := m.sessions[sessionID]
	return sess, ok
}

// StoreSession records an ACP session in the in-memory map.
func (m *AgentManager) StoreSession(sessionID string, sess agentsdk.Session) {
	m.sessionsMu.Lock()
	m.sessions[sessionID] = sess
	m.sessionsMu.Unlock()
}

// RemoveSession drops a session from the map without closing its process.
// Use when the caller has already closed or detected a dead process.
func (m *AgentManager) RemoveSession(sessionID string) {
	m.sessionsMu.Lock()
	delete(m.sessions, sessionID)
	m.sessionsMu.Unlock()
}

// CleanupSession closes the ACP session and removes all in-memory state.
func (m *AgentManager) CleanupSession(sessionID string) {
	m.sessionsMu.Lock()
	if sess, ok := m.sessions[sessionID]; ok {
		sess.Close()
		delete(m.sessions, sessionID)
	}
	m.sessionsMu.Unlock()

	m.statesMu.Lock()
	delete(m.states, sessionID)
	m.statesMu.Unlock()
}

// -------- Session state map --------

// GetOrCreateState returns the SessionState for the given session ID,
// creating one if it doesn't exist.
func (m *AgentManager) GetOrCreateState(sessionID string) *agentsdk.SessionState {
	m.statesMu.Lock()
	defer m.statesMu.Unlock()
	if state, ok := m.states[sessionID]; ok {
		return state
	}
	state := agentsdk.NewSessionState(sessionID)
	m.states[sessionID] = state
	return state
}

// PeekState returns the SessionState without creating one. Nil when the
// session has no in-memory state (no active WebSocket or ACP process).
func (m *AgentManager) PeekState(sessionID string) *agentsdk.SessionState {
	m.statesMu.Lock()
	defer m.statesMu.Unlock()
	return m.states[sessionID]
}

// SessionRuntimeState is a snapshot of per-session runtime flags used by REST
// endpoints to compute "working"/"unread" states without forcing creation of
// empty SessionState objects.
type SessionRuntimeState struct {
	IsProcessing bool
	ResultCount  int
}

// AllRuntimeStates snapshots every in-memory session's runtime flags.
func (m *AgentManager) AllRuntimeStates() map[string]SessionRuntimeState {
	m.statesMu.Lock()
	defer m.statesMu.Unlock()
	result := make(map[string]SessionRuntimeState, len(m.states))
	for id, ss := range m.states {
		ss.Mu.RLock()
		result[id] = SessionRuntimeState{
			IsProcessing: ss.IsProcessing(),
			ResultCount:  ss.ResultCount,
		}
		ss.Mu.RUnlock()
	}
	return result
}

// -------- Session lifecycle --------

// SetupACP wires frame broadcasting, sets mode/model, and stores the session
// in the in-memory map. Single entrypoint for setup after ACP process creation
// — used by CreateSession, history-load, and lazy-create paths.
//
// Model is set via UnstableSetSessionModel (bypasses the CLI allowlist so
// arbitrary gateway names work). Mode uses SetSessionMode (Claude Code only).
//
// When gateway models are configured, model options in config_option_update
// frames are rewritten so the UI only offers proxy-available models.
func (m *AgentManager) SetupACP(sess agentsdk.Session, sessionID, mode, defaultModel string) *agentsdk.SessionState {
	gatewayModels := m.GatewayModels(agentTypeString(sess.AgentType()))
	sessionState := m.GetOrCreateState(sessionID)

	sess.SetOnFrame(func(data []byte) {
		if len(gatewayModels) > 0 {
			data = rewriteModelOptions(data, gatewayModels)
		}
		sessionState.Mu.Lock()
		sessionState.TouchFrame()
		sessionState.Mu.Unlock()
		sessionState.AppendAndBroadcast(data)
	})

	if mode != "" {
		if err := sess.SetMode(context.Background(), mode); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Str("mode", mode).Msg("failed to set initial mode")
		}
	}

	// Model selection, per agent:
	//
	//   claude_code / codex / gemini:
	//     ACP session/set_model accepts arbitrary gateway-proxied names
	//     (claude-agent-acp uses UnstableSetSessionModel which bypasses the
	//     CLI allowlist). Call SetModel so both new sessions and mid-session
	//     dropdown changes propagate to the agent.
	//
	//   opencode:
	//     Accepts any model declared in opencode.json's provider.litellm.models
	//     block (see resolveACPModel for the "litellm/" prefix).
	//
	//   qwen — SKIPPED:
	//     qwen's session/set_model validates the modelId against an authType-
	//     specific registry (see Config.switchModel at cli.js:148334). Gateway
	//     names like "gpt-5.4" aren't in the "openai" authType registry, so
	//     the RPC returns -32603 "Model 'X' not found for authType 'openai'".
	//     The session still runs on the correct model because OPENAI_MODEL env
	//     (set at process spawn in server.go and CreateSession below) drives
	//     qwen's model resolution, and qwen auto-captures a RuntimeModelSnapshot
	//     on boot for unknown models that have complete credentials
	//     (syncRuntimeModelSnapshotWithCredentials at cli.js:148495). So
	//     SetModel is redundant at session creation, and mid-session dropdown
	//     changes won't take effect without respawning the process anyway.
	//     We skip the call to avoid a misleading warning.
	if defaultModel != "" && sess.AgentType() != agentsdk.AgentQwen {
		modelForACP := resolveACPModel(sess.AgentType(), defaultModel)
		if err := sess.SetModel(context.Background(), modelForACP); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Str("model", modelForACP).Msg("failed to set initial model")
		}
	}

	m.StoreSession(sessionID, sess)
	return sessionState
}

// rewriteModelOptions replaces the model config option in a config_option_update
// frame with the gateway model list. Non-config_option_update frames pass
// through unchanged. Ensures the UI only shows models available through the
// LLM proxy.
func rewriteModelOptions(data []byte, gatewayModels []server.AgentModelInfo) []byte {
	var frame struct {
		SessionUpdate string            `json:"sessionUpdate"`
		ConfigOptions []json.RawMessage `json:"configOptions"`
	}
	if err := json.Unmarshal(data, &frame); err != nil || frame.SessionUpdate != "config_option_update" {
		return data
	}

	modified := false
	for i, raw := range frame.ConfigOptions {
		var opt struct {
			Category string `json:"category"`
		}
		if err := json.Unmarshal(raw, &opt); err != nil || opt.Category != "model" {
			continue
		}

		var full map[string]any
		if err := json.Unmarshal(raw, &full); err != nil {
			continue
		}

		opts := make([]map[string]string, len(gatewayModels))
		for j, mi := range gatewayModels {
			opts[j] = map[string]string{
				"value": mi.Value, "name": mi.Name, "description": mi.Description,
			}
		}
		full["options"] = opts

		// Preserve the agent-reported currentValue if it's a known gateway
		// model. Fall back to gatewayModels[0] only when the agent reports
		// something unknown (e.g., SDK default "default" or "claude-sonnet-4-6"),
		// otherwise switching to a non-first gateway model would appear to the
		// UI as still-selecting the first one.
		currentVal, _ := full["currentValue"].(string)
		known := false
		for _, mi := range gatewayModels {
			if mi.Value == currentVal {
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

	result := map[string]any{
		"sessionUpdate": frame.SessionUpdate,
		"configOptions": frame.ConfigOptions,
	}
	if out, err := json.Marshal(result); err == nil {
		return out
	}
	return data
}

// CreateSession spawns an ACP agent process, persists the session, wires
// frame broadcasting, and optionally sends an initial prompt in a background
// goroutine. The caller owns the ACP session lifecycle — for user sessions it
// stays alive for interactive WebSocket use; auto-run callers close it when
// the prompt completes.
func (m *AgentManager) CreateSession(ctx context.Context, params SessionParams) (*SessionHandle, error) {
	agentTypeStr := params.AgentType
	if agentTypeStr == "" {
		agentTypeStr = "claude_code"
	}
	agentType := parseAgentType(agentTypeStr)

	gatewayModels := m.GatewayModels(agentTypeStr)

	// When the caller picked a non-default gateway model, override the env
	// vars the agent process would normally inherit from the pre-warmed pool.
	// Keeps the spawned process's ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL
	// (or OPENAI_MODEL / GEMINI_MODEL) consistent with the session's selected
	// model. A non-empty Env also causes the pool to be skipped — pool env is
	// baked at process spawn and can't be changed post-hoc.
	//
	// Note for qwen: OPENAI_MODEL is the *only* reliable way to pick a gateway
	// model. qwen's ACP session/set_model rejects unknown names (see SetupACP);
	// it auto-captures a RuntimeModelSnapshot from env+creds on boot instead.
	// opencode is missing from the switch because opencode reads its model
	// from opencode.json, not env vars.
	var sessionEnv map[string]string
	if params.DefaultModel != "" && len(gatewayModels) > 0 && params.DefaultModel != gatewayModels[0].Value {
		sessionEnv = make(map[string]string, 2)
		switch agentType {
		case agentsdk.AgentClaudeCode:
			sessionEnv["ANTHROPIC_MODEL"] = params.DefaultModel
			smallModel := params.DefaultModel
			for _, mi := range gatewayModels {
				if mi.Value == params.DefaultModel {
					if mi.ClaudeSmall != "" {
						smallModel = mi.ClaudeSmall
					}
					break
				}
			}
			sessionEnv["ANTHROPIC_SMALL_FAST_MODEL"] = smallModel
		case agentsdk.AgentCodex:
			sessionEnv["OPENAI_MODEL"] = params.DefaultModel
		case agentsdk.AgentQwen:
			sessionEnv["OPENAI_MODEL"] = params.DefaultModel
		case agentsdk.AgentGemini:
			sessionEnv["GEMINI_MODEL"] = params.DefaultModel
		}
	}

	sess, err := m.agentClient.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:      agentType,
		Mode:       params.PermissionMode,
		WorkingDir: params.WorkingDir,
		Env:        sessionEnv,
	})
	if err != nil {
		return nil, err
	}

	sessionID := sess.ID()

	if err := db.CreateAgentSession(sessionID, agentTypeStr, params.WorkingDir, params.Title, params.Source, params.AgentName); err != nil {
		log.Error().Err(err).Msg("failed to create agent session in DB")
		sess.Close()
		return nil, err
	}

	if params.PermissionMode != "" {
		db.SaveAgentSessionPermissionMode(sessionID, params.PermissionMode)
	}

	sessionState := m.SetupACP(sess, sessionID, params.PermissionMode, params.DefaultModel)

	log.Info().
		Str("sessionId", sessionID).
		Str("agentType", agentTypeStr).
		Str("workingDir", params.WorkingDir).
		Str("source", params.Source).
		Str("title", params.Title).
		Str("permissionMode", params.PermissionMode).
		Str("defaultModel", params.DefaultModel).
		Str("agentName", params.AgentName).
		Int("messageLen", len(params.Message)).
		Bool("envOverride", len(sessionEnv) > 0).
		Msg("agent session created")

	var promptDone chan struct{}
	if params.Message != "" {
		promptDone = make(chan struct{})
		sessionState.AppendAndBroadcast(agentsdk.SynthUserMessageChunk(params.Message))

		go func(acpSess agentsdk.Session, prompt string) {
			defer close(promptDone)

			sessionState.Mu.Lock()
			sessionState.SetProcessing(true, params.Source+"-prompt")
			sessionState.IsActive = true
			sessionState.TouchFrame()
			sessionState.Mu.Unlock()
			m.notifService.NotifyAgentSessionUpdated(sessionID, "working")

			sendCtx, cancel := context.WithCancel(m.shutdownCtx)
			defer cancel()

			internalDone := make(chan struct{})
			defer close(internalDone)
			sessionState.Mu.Lock()
			sessionState.RegisterPrompt(internalDone, cancel)
			sessionState.Mu.Unlock()

			go func() {
				select {
				case <-acpSess.Done():
					log.Info().Str("sessionId", sessionID).Msg("agent process exited during prompt")
					cancel()
				case <-sendCtx.Done():
				}
			}()

			if startBytes, err := json.Marshal(map[string]any{"type": "turn.start"}); err == nil {
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
				m.notifService.NotifyAgentSessionUpdated(sessionID, "result")
				return
			}

			for frame := range events {
				sessionState.AppendAndBroadcast(frame)
			}

			sessionState.Mu.Lock()
			sessionState.ResultCount++
			sessionState.SetProcessing(false, params.Source+"-prompt-complete")
			sessionState.ClearPrompt()
			sessionState.Mu.Unlock()

			m.notifService.NotifyAgentSessionUpdated(sessionID, "result")
		}(sess, params.Message)
	}

	return &SessionHandle{
		ID:           sessionID,
		AcpSession:   sess,
		SessionState: sessionState,
		PromptDone:   promptDone,
	}, nil
}
