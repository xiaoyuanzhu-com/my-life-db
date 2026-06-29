package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/mcptools"
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
	frameStore   *agentsdk.FrameStore // optional, may be nil

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

// SetFrameStore wires a FrameStore into the manager. Must be called before
// any sessions are created. The frame store is propagated to each new
// SessionState so frames are persisted to disk.
func (m *AgentManager) SetFrameStore(fs *agentsdk.FrameStore) {
	m.frameStore = fs
}

// GatewayModels returns the subset of AGENT_MODELS compatible with the given
// agent type. Resolved fresh each call so a config hot-reload takes effect.
func (m *AgentManager) GatewayModels(agentType string) []server.AgentModelInfo {
	return server.FilterModelsForAgent(m.srv.Cfg().AgentLLM.Models, agentType)
}

// BuildModelEnv returns the env var overrides needed so a freshly spawned
// agent process boots with the chosen gateway model. Returns nil when the
// model matches the agent type's default (gatewayModels[0]) — leaving env
// untouched lets the agent fall through to the pre-warmed pool.
//
// Mirrors the inline env-build in CreateSession, factored out so lazy-spawn
// paths in the WS handler can apply the same per-session model preference.
// Opencode is intentionally absent: it reads its model from opencode.json, not
// env vars.
func (m *AgentManager) BuildModelEnv(agentType agentsdk.AgentType, model string, gatewayModels []server.AgentModelInfo) map[string]string {
	if model == "" || len(gatewayModels) == 0 || model == gatewayModels[0].Value {
		return nil
	}
	env := make(map[string]string, 2)
	switch agentType {
	case agentsdk.AgentClaudeCode:
		env["ANTHROPIC_MODEL"] = model
		smallModel := model
		for _, mi := range gatewayModels {
			if mi.Value == model {
				if mi.ClaudeSmall != "" {
					smallModel = mi.ClaudeSmall
				}
				break
			}
		}
		env["ANTHROPIC_SMALL_FAST_MODEL"] = smallModel
	case agentsdk.AgentCodex:
		env["OPENAI_MODEL"] = model
	case agentsdk.AgentQwen:
		env["OPENAI_MODEL"] = model
	case agentsdk.AgentGemini:
		env["GEMINI_MODEL"] = model
	}
	if len(env) == 0 {
		return nil
	}
	return env
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

// Idle-session sweeper. Each live session pins an agent subprocess (~hundreds
// of MB RSS) that otherwise survives until the user explicitly stops/deletes
// it or the server restarts. Long-lived servers therefore accumulate one
// process per session ever touched, even when only a handful are in use.
//
// The sweep is non-destructive: a reaped session is transparently respawned
// from its persisted DB record + on-disk frames the next time the user
// interacts with it (see ensureLiveACPSession).
const (
	reapSweepInterval = time.Hour
	reapMaxIdle       = 3 * 24 * time.Hour
)

// StartIdleReaper launches the background sweep. It runs until the server's
// shutdown context is cancelled. Call once during startup.
func (m *AgentManager) StartIdleReaper() {
	go func() {
		ticker := time.NewTicker(reapSweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-m.shutdownCtx.Done():
				return
			case <-ticker.C:
				m.reapIdleSessions(reapMaxIdle)
			}
		}
	}()
	log.Info().
		Dur("interval", reapSweepInterval).
		Dur("maxIdle", reapMaxIdle).
		Msg("agent idle-session reaper started")
}

// reapIdleSessions closes the agent process for every session whose last ACP
// frame is older than maxIdle. Two sessions are always spared:
//   - one currently processing a turn (would abort a live agent run), and
//   - one with a WebSocket client still attached (someone is watching).
func (m *AgentManager) reapIdleSessions(maxIdle time.Duration) {
	now := time.Now()

	// Snapshot IDs under the lock; Close() happens outside it.
	m.sessionsMu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.sessionsMu.Unlock()

	reaped := 0
	for _, id := range ids {
		state := m.PeekState(id)
		if state == nil {
			continue
		}

		state.Mu.RLock()
		last := state.LastFrameAt
		processing := state.IsProcessing()
		state.Mu.RUnlock()

		switch {
		case processing:
			continue // never abort an in-flight turn
		case state.HasClients():
			continue // someone is still connected
		case last.IsZero():
			continue // no recorded activity yet — don't reap blind
		case now.Sub(last) < maxIdle:
			continue
		}

		log.Info().
			Str("sessionId", id).
			Dur("idle", now.Sub(last)).
			Msg("reaping idle agent session")
		m.CleanupSession(id)
		reaped++
	}

	if reaped > 0 {
		log.Info().Int("reaped", reaped).Int("scanned", len(ids)).Msg("idle agent-session sweep complete")
	}
}

// EnsureLiveSession returns a live ACP session for sessionID, spawning one
// lazily if the existing entry is missing or its process has exited.
//
// Used by every user-initiated WS handler (prompt, setMode, setConfigOption)
// so that any user input always lands on a live agent, and by RunPromptTurn
// to apply a model change queued mid-turn (RespawnAfterTurn). The previous
// design branched on existence and synthesized a fake config_option_update
// frame when ACP was dead — which silently let session state desync from the
// dropdown (model snapping back to gateway default, effort vanishing).
//
// Returns (nil, nil) when there is no session record in the DB; callers
// should surface that distinctly from a spawn failure.
//
// Spawn parameters come from persisted state: agent type, working dir,
// storage id, permission mode, and last-selected model. When the session
// already has frames in memory, LoadSession is called so the new agent
// process inherits conversation memory.
func (m *AgentManager) EnsureLiveSession(sessionID string, sessionState *agentsdk.SessionState) (agentsdk.Session, error) {
	if existing, ok := m.GetSession(sessionID); ok {
		select {
		case <-existing.Done():
			log.Info().Str("sessionId", sessionID).Msg("existing ACP session process is dead, removing for lazy recreation")
			m.RemoveSession(sessionID)
		default:
			return existing, nil
		}
	}

	sessionRecord, _ := m.srv.AppDB().GetAgentSession(sessionID)
	if sessionRecord == nil {
		return nil, nil
	}

	agentType := parseAgentType(sessionRecord.AgentType)
	agentTypeStr := agentTypeString(agentType)
	workDir := sessionRecord.WorkingDir
	storageID := sessionRecord.StorageID
	mode, _ := m.srv.AppDB().GetAgentSessionPermissionMode(sessionID)

	gatewayModels := m.GatewayModels(agentTypeStr)
	var defaultModel string
	if len(gatewayModels) > 0 {
		defaultModel = gatewayModels[0].Value
	}
	persistedOpts, _ := m.srv.AppDB().GetAgentSessionConfigOptions(sessionID)
	if v := persistedOpts["model"]; v != "" {
		defaultModel = v
	}

	log.Info().Str("sessionId", sessionID).Msg("no live ACP session, creating lazily")
	sess, err := m.agentClient.CreateSession(m.shutdownCtx, agentsdk.SessionConfig{
		Agent:        agentType,
		Mode:         mode,
		WorkingDir:   workDir,
		Env:          m.BuildModelEnv(agentType, defaultModel, gatewayModels),
		McpServers:   m.buildSessionMcpServers(storageID),
		SystemPrompt: server.BuildAgentSystemPrompt(m.srv.Cfg().UserDataDir, storageID),
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
		if err := sess.LoadSession(m.shutdownCtx, sessionID, workDir); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("LoadSession failed on lazy create — agent will start with empty memory")
		} else {
			log.Info().Str("sessionId", sessionID).Msg("LoadSession succeeded on lazy create — agent memory restored")
		}
	}

	m.SetupACP(sess, sessionID, mode, defaultModel)
	return sess, nil
}

// RestartSession kills the existing ACP process and resets in-memory state
// so the session can be lazily recreated on the next prompt. The DB record
// is preserved — only the live process and runtime state are cleared.
func (m *AgentManager) RestartSession(sessionID string) error {
	// Wait for any in-flight prompt to finish before tearing down.
	state := m.PeekState(sessionID)
	if state != nil {
		state.WaitForPrompt()
	}

	// Kill the ACP process.
	m.sessionsMu.Lock()
	if sess, ok := m.sessions[sessionID]; ok {
		sess.CancelAllPermissions()
		sess.Close()
		delete(m.sessions, sessionID)
	}
	m.sessionsMu.Unlock()

	// Remove all runtime state (messages, processing flags, clients).
	// A fresh SessionState will be created by GetOrCreateState on the
	// next WS connect or prompt.
	m.statesMu.Lock()
	delete(m.states, sessionID)
	m.statesMu.Unlock()

	log.Info().Str("sessionId", sessionID).Msg("agent session restarted")
	return nil
}

// -------- Session state map --------

// GetOrCreateState returns the SessionState for the given session ID,
// creating one if it doesn't exist. When a FrameStore is configured,
// it is wired into new states so frames are persisted automatically.
//
// New states are seeded with the session's persisted result_count from the DB
// so the in-memory counter reflects the true total across server restarts.
// Without this, in-memory ResultCount starts at 0 and new live turns can't
// push DB result_count past the prior value (it's MAX-guarded), which
// permanently suppresses the unread dot.
func (m *AgentManager) GetOrCreateState(sessionID string) *agentsdk.SessionState {
	m.statesMu.Lock()
	defer m.statesMu.Unlock()
	if state, ok := m.states[sessionID]; ok {
		return state
	}
	state := agentsdk.NewSessionState(sessionID)
	if m.frameStore != nil {
		state.SetFrameStore(m.frameStore)
	}
	if rc, err := m.srv.AppDB().GetAgentSessionResultCount(sessionID); err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to load persisted result_count; in-memory starts at 0")
	} else {
		state.ResultCount = rc
	}
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
// Model is set via SetModel, which (since ACP v0.13.5) writes the "model"
// session config option — this bypasses the CLI allowlist so arbitrary gateway
// names work. Mode uses SetSessionMode (Claude Code only).
//
// When gateway models are configured, model options in config_option_update
// frames are rewritten so the UI only offers proxy-available models.
func (m *AgentManager) SetupACP(sess agentsdk.Session, sessionID, mode, defaultModel string) *agentsdk.SessionState {
	gatewayModels := m.GatewayModels(agentTypeString(sess.AgentType()))
	sessionState := m.GetOrCreateState(sessionID)

	// A fresh spawn always boots with the latest persisted config, so any
	// queued respawn-for-model-change is satisfied by reaching this point.
	sessionState.Mu.Lock()
	sessionState.RespawnAfterTurn = false
	sessionState.Mu.Unlock()

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
	//     The "model" session config option accepts arbitrary gateway-proxied
	//     names (claude-agent-acp's set-config-option bypasses the CLI
	//     allowlist). Call SetModel so both new sessions and mid-session
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

	// Restore the user's persisted effort pick on session boot so a resume
	// stays on the same reasoning level. Empty override → applyModelEffort
	// falls back to the model's declared Effort.
	persistedOpts, _ := m.srv.AppDB().GetAgentSessionConfigOptions(sessionID)
	applyModelEffort(sess, sessionState, gatewayModels, defaultModel, sessionID, persistedOpts["effort"])

	m.StoreSession(sessionID, sess)
	return sessionState
}

// applyModelEffort pushes an "effort" config option into claude-agent-acp via
// SetConfigOption. Used right after SetModel on both session boot and
// mid-session model changes.
//
// When override is non-empty (e.g. a value persisted from a previous run via
// the effort dropdown) it takes precedence over the model's declared Effort.
// Otherwise the per-model Effort from AGENT_MODELS is used.
//
// Returns the effort string actually applied, or "" when nothing was sent
// (non-claude_code agent, empty modelValue, or no effort to apply). Callers
// use this to keep config_options in sync with what the agent is running.
//
// Background: claude-agent-acp defaults Opus to effort="xhigh", which only
// Anthropic accepts. Non-Anthropic gateways (GLM, Kimi, MiniMax, Doubao)
// reject xhigh and expect "max" or low/medium/high. Since effort is really a
// per-model attribute (the SDK exposes it session-wide), each gateway model
// in AGENT_MODELS declares its own Effort; we apply it after SetModel so the
// first turn uses a compatible value. Models with Effort="" (e.g. Anthropic
// proxied Opus, DeepSeek) are left alone.
//
// After the RPC, the updated options are fanned out as a synthetic
// config_option_update frame because claude-agent-acp returns the new state
// inline rather than emitting a session/update notification — same trick the
// user-triggered setConfigOption handler uses to keep the UI in sync.
func applyModelEffort(sess agentsdk.Session, sessionState *agentsdk.SessionState, gatewayModels []server.AgentModelInfo, modelValue, sessionID, override string) string {
	if sess.AgentType() != agentsdk.AgentClaudeCode || modelValue == "" {
		return ""
	}
	effort := override
	if effort == "" {
		for _, m := range gatewayModels {
			if m.Value == modelValue {
				effort = m.Effort
				break
			}
		}
	}
	if effort == "" {
		return ""
	}
	updatedOpts, err := sess.SetConfigOption(context.Background(), "effort", effort)
	if err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Str("model", modelValue).Str("effort", effort).Msg("failed to apply model-specific effort override")
		return ""
	}
	broadcastConfigUpdate(sessionState, gatewayModels, updatedOpts, sessionID)
	return effort
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

// broadcastConfigUpdate fans out a synthetic config_option_update frame for
// updatedOpts. claude-agent-acp's SetConfigOption echoes the native CLI model
// dropdown in its inline response, so the frame must go through
// rewriteModelOptions — exactly like live ACP frames in SetOnFrame — or it
// clobbers the gateway-rewritten dropdown the UI already received.
func broadcastConfigUpdate(sessionState *agentsdk.SessionState, gatewayModels []server.AgentModelInfo, updatedOpts any, sessionID string) {
	if sessionState == nil {
		return
	}
	frame, err := json.Marshal(map[string]any{
		"sessionUpdate": "config_option_update",
		"configOptions": updatedOpts,
	})
	if err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to marshal config_option_update")
		return
	}
	if len(gatewayModels) > 0 {
		frame = rewriteModelOptions(frame, gatewayModels)
	}
	sessionState.AppendAndBroadcast(frame)
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

	// MyLifeDB is a managed-agents-only deployment: every session (user-initiated
	// or auto-run) must use a model from AGENT_MODELS. When the caller didn't
	// pick one, default to gatewayModels[0]. This centralizes the fallback so
	// auto-run callers don't need to know about the gateway list, and guarantees
	// SetupACP's SetModel call below fires — which is what overrides stale model
	// preferences in the CLI's own ~/.claude/settings.json (e.g. "opus[1m]"
	// resolving to claude-opus-4-6 when the gateway only allows claude-opus-4-7).
	if params.DefaultModel == "" && len(gatewayModels) > 0 {
		params.DefaultModel = gatewayModels[0].Value
	}

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
	sessionEnv := m.BuildModelEnv(agentType, params.DefaultModel, gatewayModels)

	storageID := params.StorageID
	if storageID == "" {
		storageID = mintStorageID()
	} else if !validStorageID(storageID) {
		return nil, fmt.Errorf("invalid storageId: %q", storageID)
	}

	mcpServers := m.buildSessionMcpServers(storageID)
	systemPrompt := server.BuildAgentSystemPrompt(m.srv.Cfg().UserDataDir, storageID)

	sess, err := m.agentClient.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:        agentType,
		Mode:         params.PermissionMode,
		WorkingDir:   params.WorkingDir,
		Env:          sessionEnv,
		McpServers:   mcpServers,
		SystemPrompt: systemPrompt,
	})
	if err != nil {
		return nil, err
	}

	sessionID := sess.ID()

	if err := m.srv.AppDB().CreateAgentSession(ctx, sessionID, agentTypeStr, params.WorkingDir, params.Title, params.Source, params.AgentName, params.TriggerKind, params.TriggerData, storageID); err != nil {
		log.Error().Err(err).Msg("failed to create agent session in DB")
		sess.Close()
		return nil, err
	}

	if params.PermissionMode != "" {
		m.srv.AppDB().SaveAgentSessionPermissionMode(ctx, sessionID, params.PermissionMode)
	}

	// Persist the model so a server restart can resume the session on the same
	// one. Without this, the lazy-spawn path in ensureLiveACPSession sees an
	// empty config_options["model"] and falls back to gatewayModels[0], then
	// SetupACP calls SetModel() with that default — silently overriding the
	// model the session was created with.
	if params.DefaultModel != "" {
		if err := m.srv.AppDB().SaveAgentSessionConfigOption(ctx, sessionID, "model", params.DefaultModel); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Str("model", params.DefaultModel).Msg("failed to persist initial model")
		}
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
		// Auto-run / REST-initiated prompts have no client-minted messageId
		// (no outbox round-trip on this path); pass "" so the synthesized
		// chunk carries no messageId field.
		sessionState.AppendAndBroadcast(agentsdk.SynthUserMessageChunk(params.Message, ""))

		// Register promptDone with sessionState BEFORE launching the helper
		// so a concurrent WaitForPrompt can't see PromptDone=nil and bypass
		// serialization. See agent_prompt_turn.go for the rest of the turn
		// lifecycle.
		promptCtx, pCancel := context.WithCancel(m.shutdownCtx)
		sessionState.Mu.Lock()
		sessionState.RegisterPrompt(promptDone, pCancel)
		sessionState.Mu.Unlock()

		go m.RunPromptTurn(promptCtx, pCancel, promptDone, sess, sessionState, sessionID, params.Message, params.Source)
	}

	return &SessionHandle{
		ID:           sessionID,
		AcpSession:   sess,
		SessionState: sessionState,
		PromptDone:   promptDone,
		StorageID:    storageID,
	}, nil
}

// buildSessionMcpServers reads <dataDir>/.mcp.json and converts every enabled
// entry into the ACP McpServer wire shape. The built-in mylifedb server is
// installed into .mcp.json at server startup (see skills.InstallClientConfig)
// so it flows through the same path as user-added servers; its localhost URL
// is detected by the internal-prefix check below and the runtime-only
// Authorization + X-MLD-Storage-Id headers are injected here (those aren't
// stored in .mcp.json since the token rotates per backend startup and the
// storage id is per-session).
func (m *AgentManager) buildSessionMcpServers(storageID string) []acp.McpServer {
	cfg := m.srv.Cfg()
	mcpToken := m.srv.MCPToken()
	internalPrefix := fmt.Sprintf("http://localhost:%d/api/", cfg.Port)

	specs, err := mcptools.AllSpecs(cfg.UserDataDir)
	if err != nil {
		log.Warn().Err(err).Msg("read .mcp.json for session MCP servers failed")
		return nil
	}

	out := make([]acp.McpServer, 0, len(specs))
	for _, s := range specs {
		if s.Disabled {
			continue
		}
		srv, err := specToAcpMcpServer(s, internalPrefix, mcpToken, storageID)
		if err != nil {
			log.Warn().Err(err).Str("server", s.Name).Msg("skipping invalid MCP server entry")
			continue
		}
		out = append(out, srv)
	}
	return out
}

// specToAcpMcpServer converts a parsed mcptools.ServerSpec into the ACP wire
// shape. For HTTP servers whose URL points at our own backend (matched by
// internalPrefix), runtime-only auth + session headers are appended after any
// user-provided headers.
func specToAcpMcpServer(s mcptools.ServerSpec, internalPrefix, mcpToken, storageID string) (acp.McpServer, error) {
	typ := s.Type
	if typ == "" {
		switch {
		case s.URL != "":
			typ = "http"
		case s.Command != "":
			typ = "stdio"
		default:
			return acp.McpServer{}, fmt.Errorf("server %q has neither url nor command", s.Name)
		}
	}

	switch typ {
	case "http":
		if s.URL == "" {
			return acp.McpServer{}, fmt.Errorf("http server %q missing url", s.Name)
		}
		headers := make([]acp.HttpHeader, 0, len(s.Headers)+2)
		for k, v := range s.Headers {
			headers = append(headers, acp.HttpHeader{Name: k, Value: v})
		}
		if strings.HasPrefix(s.URL, internalPrefix) {
			headers = append(headers,
				acp.HttpHeader{Name: "Authorization", Value: "Bearer " + mcpToken},
				acp.HttpHeader{Name: "X-MLD-Storage-Id", Value: storageID},
			)
		}
		return acp.McpServer{
			Http: &acp.McpServerHttpInline{
				Name:    s.Name,
				Type:    "http",
				Url:     s.URL,
				Headers: headers,
			},
		}, nil
	case "stdio":
		if s.Command == "" {
			return acp.McpServer{}, fmt.Errorf("stdio server %q missing command", s.Name)
		}
		env := make([]acp.EnvVariable, 0, len(s.Env))
		for k, v := range s.Env {
			env = append(env, acp.EnvVariable{Name: k, Value: v})
		}
		return acp.McpServer{
			Stdio: &acp.McpServerStdio{
				Name:    s.Name,
				Command: s.Command,
				Args:    s.Args,
				Env:     env,
			},
		}, nil
	default:
		return acp.McpServer{}, fmt.Errorf("server %q has unsupported type %q", s.Name, typ)
	}
}
