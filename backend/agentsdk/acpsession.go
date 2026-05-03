package agentsdk

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// acpSession wraps an ACP ClientSideConnection as a Session.
type acpSession struct {
	cmd       *exec.Cmd
	conn      *acp.ClientSideConnection
	client    *acpClient
	sessionID string
	agentType AgentType

	mu     sync.Mutex
	closed bool

	// supportsClose is true when the agent advertised session/close capability
	// during ACP initialization. When false, only SIGINT is used on Close().
	supportsClose bool

	// MCP servers passed via ACP (reused in LoadSession)
	mcpServers []acp.McpServer

	// Cached from NewSessionResponse, emitted on first Send()
	initialModes  *SessionMeta
	initialModels *SessionMeta
}

// warmConn is a pre-warmed ACP process with Initialize already complete.
// Session-independent — can serve any SessionConfig via newSessionFromWarm().
type warmConn struct {
	cmd           *exec.Cmd
	conn          *acp.ClientSideConnection
	client        *acpClient
	done          <-chan struct{} // closed when agent process exits
	supportsClose bool           // agent advertised session/close capability
}

// spawnWarmConn launches an agent binary and completes the Initialize handshake.
// The returned warmConn is session-independent and ready for NewSession.
func spawnWarmConn(ctx context.Context, agentCfg AgentConfig, env map[string]string) (*warmConn, error) {
	cmd := exec.CommandContext(ctx, agentCfg.Command, agentCfg.Args...)

	cmd.Env = baseCommandEnv(agentCfg.CleanEnv)
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	cmd.Stderr = &logWriter{prefix: "agent"}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, &AgentError{
			Type:    ErrAgentCrash,
			Agent:   agentCfg.Type,
			Message: "failed to create stdin pipe",
			Cause:   err,
		}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, &AgentError{
			Type:    ErrAgentCrash,
			Agent:   agentCfg.Type,
			Message: "failed to create stdout pipe",
			Cause:   err,
		}
	}

	if err := cmd.Start(); err != nil {
		return nil, &AgentError{
			Type:    ErrAgentCrash,
			Agent:   agentCfg.Type,
			Message: "failed to start agent binary: " + agentCfg.Command,
			Cause:   err,
		}
	}

	log.Info().
		Str("agent", string(agentCfg.Type)).
		Str("command", agentCfg.Command).
		Int("pid", cmd.Process.Pid).
		Msg("agent process started")

	acpCli := &acpClient{}

	conn := acp.NewClientSideConnection(acpCli, stdin, stdout)

	initResp, err := conn.Initialize(ctx, acp.InitializeRequest{
		ProtocolVersion: acp.ProtocolVersionNumber,
		ClientCapabilities: acp.ClientCapabilities{
			Fs: acp.FileSystemCapability{
				ReadTextFile:  true,
				WriteTextFile: true,
			},
			Terminal: true,
		},
		ClientInfo: &acp.Implementation{
			Name:    "mylifedb",
			Version: "1.0.0",
		},
	})
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return nil, &AgentError{
			Type:    ErrAgentCrash,
			Agent:   agentCfg.Type,
			Message: "ACP initialize failed",
			Cause:   err,
		}
	}

	// Capture session/close capability from initialization response.
	// The ACP SDK v0.6.3 does not expose SessionCapabilities.Close yet,
	// so supportsClose is always false for now. The infrastructure is
	// here so it can be enabled once the SDK advertises the capability.
	supportsClose := false

	log.Info().
		Int("protocol", int(initResp.ProtocolVersion)).
		Str("agent_name", safeImplName(initResp.AgentInfo)).
		Bool("supportsClose", supportsClose).
		Msg("ACP initialized")

	return &warmConn{cmd: cmd, conn: conn, client: acpCli, done: conn.Done(), supportsClose: supportsClose}, nil
}

// newSessionFromWarm creates an acpSession from a pre-warmed connection.
// Sets session-specific fields on the acpClient before calling NewSession.
func newSessionFromWarm(ctx context.Context, warm *warmConn, agentCfg AgentConfig, config SessionConfig) (*acpSession, error) {
	// Set session-specific fields on the client (safe — no callbacks until Prompt)
	warm.client.autoApprove = config.Mode == "bypassPermissions"
	warm.client.workingDir = config.WorkingDir

	cwd := config.WorkingDir
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	mcpServers := config.McpServers
	if mcpServers == nil {
		mcpServers = []acp.McpServer{}
	}

	req := acp.NewSessionRequest{
		Cwd:        cwd,
		McpServers: mcpServers,
	}

	// Pass system prompt via _meta.systemPrompt (append mode).
	// This keeps the claude-agent-acp's default Claude Code preset
	// and appends our custom instructions.
	if config.SystemPrompt != "" {
		req.Meta = map[string]any{
			"systemPrompt": map[string]any{
				"append": config.SystemPrompt,
			},
		}
	}

	sessResp, err := warm.conn.NewSession(ctx, req)
	if err != nil {
		warm.cmd.Process.Kill()
		warm.cmd.Wait()
		return nil, &AgentError{
			Type:    ErrAgentCrash,
			Agent:   agentCfg.Type,
			Message: "ACP new session failed",
			Cause:   err,
		}
	}

	log.Info().
		Str("session_id", string(sessResp.SessionId)).
		Str("agent", string(agentCfg.Type)).
		Msg("ACP session created")

	// NOTE: SetSessionMode is NOT called here — the caller must call
	// session.SetMode() AFTER SetOnFrame() so the mode-change event
	// is captured and forwarded to connected clients.

	session := &acpSession{
		cmd:           warm.cmd,
		conn:          warm.conn,
		client:        warm.client,
		sessionID:     string(sessResp.SessionId),
		agentType:     agentCfg.Type,
		mcpServers:    mcpServers,
		supportsClose: warm.supportsClose,
	}

	// Cache session modes
	if sessResp.Modes != nil {
		modes := make([]map[string]any, len(sessResp.Modes.AvailableModes))
		for i, m := range sessResp.Modes.AvailableModes {
			entry := map[string]any{"id": string(m.Id), "name": m.Name}
			if m.Description != nil {
				entry["description"] = *m.Description
			}
			modes[i] = entry
		}
		modesJSON, _ := json.Marshal(modes)
		session.initialModes = &SessionMeta{
			ModeID:         string(sessResp.Modes.CurrentModeId),
			AvailableModes: modesJSON,
		}
	}

	if sessResp.Models != nil {
		models := make([]map[string]any, len(sessResp.Models.AvailableModels))
		for i, m := range sessResp.Models.AvailableModels {
			models[i] = map[string]any{
				"modelId": string(m.ModelId), "name": m.Name,
			}
		}
		modelsJSON, _ := json.Marshal(models)
		session.initialModels = &SessionMeta{
			ModelID:         string(sessResp.Models.CurrentModelId),
			AvailableModels: modelsJSON,
		}
	}

	go func() {
		<-warm.conn.Done()
		log.Info().
			Str("session_id", session.sessionID).
			Str("agent", string(agentCfg.Type)).
			Msg("ACP connection closed")
	}()

	return session, nil
}

// spawnACPSession launches an agent binary, creates the ACP connection,
// performs the initialization handshake, and creates a new session.
func spawnACPSession(ctx context.Context, agentCfg AgentConfig, config SessionConfig, env map[string]string) (*acpSession, error) {
	warm, err := spawnWarmConn(ctx, agentCfg, env)
	if err != nil {
		return nil, err
	}
	return newSessionFromWarm(ctx, warm, agentCfg, config)
}

// Send sends a prompt and streams back raw JSON frames.
// Prompt() blocks internally; frames arrive via the acpClient's SessionUpdate callback.
// The channel is closed when the turn completes.
func (s *acpSession) Send(ctx context.Context, prompt string) (<-chan []byte, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, &AgentError{
			Type:    ErrAgentCrash,
			Agent:   s.agentType,
			Message: "session is closed",
		}
	}
	s.mu.Unlock()

	// Suppress ACP's user_message_chunk echo — the host synthesizes its own.
	s.client.suppressUserMsg.Store(true)

	// Channel for synthetic frames only (metadata, turn.complete, errors).
	// ACP SessionUpdate frames go through onFrame directly — no temporary channel.
	events := make(chan []byte, 256)

	// Emit cached session metadata on first prompt
	s.mu.Lock()
	modes := s.initialModes
	models := s.initialModels
	s.initialModes = nil // only emit once
	s.initialModels = nil
	s.mu.Unlock()

	if modes != nil {
		payload := map[string]any{"type": "session.modeUpdate", "modeId": modes.ModeID}
		if modes.AvailableModes != nil {
			payload["availableModes"] = json.RawMessage(modes.AvailableModes)
		}
		if data, err := json.Marshal(payload); err == nil {
			events <- data
		}
	}
	if models != nil {
		payload := map[string]any{"type": "session.modelsUpdate", "modelId": models.ModelID}
		if models.AvailableModels != nil {
			payload["availableModels"] = json.RawMessage(models.AvailableModels)
		}
		if data, err := json.Marshal(payload); err == nil {
			events <- data
		}
	}

	go func() {
		defer close(events)

		resp, err := s.conn.Prompt(ctx, acp.PromptRequest{
			SessionId: acp.SessionId(s.sessionID),
			Prompt:    []acp.ContentBlock{acp.TextBlock(prompt)},
		})
		if err != nil {
			// Check if this is a context cancellation
			if ctx.Err() != nil {
				if data, err := json.Marshal(map[string]any{
					"type":       "turn.complete",
					"stopReason": "cancelled",
				}); err == nil {
					events <- data
				}
				return
			}
			if data, err := json.Marshal(map[string]any{
				"type":    "error",
				"message": err.Error(),
				"code":    "AGENT_ERROR",
			}); err == nil {
				events <- data
			}
			return
		}

		log.Info().
			Str("stop_reason", string(resp.StopReason)).
			Str("session_id", s.sessionID).
			Bool("has_usage", resp.Usage != nil).
			Msg("ACP prompt completed")

		turnComplete := map[string]any{
			"type":       "turn.complete",
			"stopReason": string(resp.StopReason),
		}
		if resp.Usage != nil {
			turnComplete["usage"] = resp.Usage
		}
		if data, err := json.Marshal(turnComplete); err == nil {
			events <- data
		}
	}()

	return events, nil
}

// LoadSession loads a historical session from the agent's persistence layer.
// Frames are delivered via the permanent onFrame handler as they arrive —
// no temporary collection channel needed.
func (s *acpSession) LoadSession(ctx context.Context, sessionID string, cwd string) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return &AgentError{
			Type:    ErrAgentCrash,
			Agent:   s.agentType,
			Message: "session is closed",
		}
	}
	s.mu.Unlock()

	// Allow ACP's user_message_chunk through — LoadSession replays historical messages.
	s.client.suppressUserMsg.Store(false)

	log.Info().Str("sessionId", sessionID).Str("cwd", cwd).Msg("calling ACP session/load")

	mcpServers := s.mcpServers
	if mcpServers == nil {
		mcpServers = []acp.McpServer{}
	}

	// conn.LoadSession blocks. During this call, the agent replays history
	// as SessionUpdate notifications → acpClient.emit() → onFrame handler.
	_, err := s.conn.LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  acp.SessionId(sessionID),
		Cwd:        cwd,
		McpServers: mcpServers,
	})

	if err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("LoadSession failed")
		return err
	}

	log.Info().Str("sessionId", sessionID).Msg("LoadSession completed")

	// Update the session's internal ACP session ID to the loaded one
	s.mu.Lock()
	s.sessionID = sessionID
	s.mu.Unlock()

	return nil
}

// RespondToPermission unblocks a pending permission request using an optionID.
func (s *acpSession) RespondToPermission(ctx context.Context, toolCallID string, optionID string) error {
	return s.client.respondToPermission(toolCallID, true, optionID)
}

// CancelAllPermissions cancels all pending permission requests.
func (s *acpSession) CancelAllPermissions() {
	s.client.cancelAllPermissions()
}

// SetMode changes the active mode for this session.
func (s *acpSession) SetMode(ctx context.Context, modeID string) error {
	_, err := s.conn.SetSessionMode(ctx, acp.SetSessionModeRequest{
		SessionId: acp.SessionId(s.sessionID),
		ModeId:    acp.SessionModeId(modeID),
	})
	if err == nil {
		// Update cached initial modes so Send()'s session.modeUpdate emission
		// reflects the actual current mode, not the stale default from NewSession.
		s.mu.Lock()
		if s.initialModes != nil {
			s.initialModes.ModeID = modeID
		}
		s.mu.Unlock()
	}
	return err
}

// SetModel changes the active model for this session.
func (s *acpSession) SetModel(ctx context.Context, modelID string) error {
	_, err := s.conn.UnstableSetSessionModel(ctx, acp.UnstableSetSessionModelRequest{
		SessionId: acp.SessionId(s.sessionID),
		ModelId:   acp.UnstableModelId(modelID),
	})
	return err
}

// SetConfigOption sets a generic config option via ACP SetSessionConfigOption.
func (s *acpSession) SetConfigOption(ctx context.Context, configID string, value string) error {
	_, err := s.conn.SetSessionConfigOption(ctx, acp.SetSessionConfigOptionRequest{
		SessionId: acp.SessionId(s.sessionID),
		ConfigId:  acp.SessionConfigId(configID),
		Value:     acp.SessionConfigValueId(value),
	})
	return err
}

// Stop cancels the current operation (sends SIGINT equivalent via ACP Cancel).
func (s *acpSession) Stop() error {
	return s.conn.Cancel(context.Background(), acp.CancelNotification{
		SessionId: acp.SessionId(s.sessionID),
	})
}

// SetOnFrame sets the permanent handler for all ACP frames.
// Must be called before any Send()/LoadSession() calls.
func (s *acpSession) SetOnFrame(fn func([]byte)) {
	s.client.mu.Lock()
	s.client.onFrame = fn
	s.client.mu.Unlock()
}

// Close terminates the session and kills the agent process.
// If the agent advertised session/close capability (supportsClose=true),
// a graceful ACP close is attempted first before sending SIGINT.
func (s *acpSession) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true

	log.Info().
		Str("session_id", s.sessionID).
		Str("agent", string(s.agentType)).
		Bool("supportsClose", s.supportsClose).
		Msg("closing ACP session")

	// Graceful close path: if the agent advertised session/close,
	// attempt a protocol-level close before sending SIGINT. This is
	// best-effort — failures are logged but the process is always killed.
	// Currently supportsClose is always false (SDK v0.6.3 does not expose
	// the capability), so this branch is unreachable until the SDK is updated.
	if s.supportsClose {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// session/close is not yet available in the SDK; log and fall through.
		_ = closeCtx
		log.Info().
			Str("session_id", s.sessionID).
			Msg("ACP session/close: capability advertised but SDK method not yet available; falling back to SIGINT")
	}

	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Signal(os.Interrupt)
		// Don't block on Wait — the conn.Done() watcher handles cleanup
		go func() {
			s.cmd.Wait()
		}()
	}
	return nil
}

// ID returns the session identifier.
func (s *acpSession) ID() string { return s.sessionID }

// AgentType returns which agent this session uses.
func (s *acpSession) AgentType() AgentType { return s.agentType }

// Done returns a channel that closes when the agent process exits.
func (s *acpSession) Done() <-chan struct{} { return s.conn.Done() }

// --- Helpers ---

type logWriter struct {
	prefix string
}

func (w *logWriter) Write(p []byte) (int, error) {
	log.Debug().Str("src", w.prefix).Msg(string(p))
	return len(p), nil
}

func safeImplName(impl *acp.Implementation) string {
	if impl == nil {
		return "<unknown>"
	}
	return impl.Name
}

func baseCommandEnv(clean bool) []string {
	if !clean {
		return os.Environ()
	}

	keepExact := map[string]bool{
		"HOME":          true,
		"PATH":          true,
		"SHELL":         true,
		"TERM":          true,
		"TMPDIR":        true,
		"USER":          true,
		"LOGNAME":       true,
		"LANG":          true,
		"COLORTERM":     true,
		"NO_COLOR":      true,
		"SSH_AUTH_SOCK": true,
	}
	keepPrefixes := []string{
		"LC_",
		"XDG_",
	}

	base := make([]string, 0, 16)
	for _, entry := range os.Environ() {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if keepExact[key] {
			base = append(base, entry)
			continue
		}
		for _, prefix := range keepPrefixes {
			if strings.HasPrefix(key, prefix) {
				base = append(base, entry)
				break
			}
		}
	}
	return base
}
