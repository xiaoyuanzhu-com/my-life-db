package agentsdk

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"sync"

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

	// Cached from NewSessionResponse, emitted on first Send()
	initialModes  *SessionMeta
	initialModels *SessionMeta
}

// spawnACPSession launches an agent binary, creates the ACP connection,
// performs the initialization handshake, and creates a new session.
func spawnACPSession(ctx context.Context, agentCfg AgentConfig, config SessionConfig, env map[string]string) (*acpSession, error) {
	// Build command
	cmd := exec.CommandContext(ctx, agentCfg.Command, agentCfg.Args...)

	// Set environment: inherit current env + merge configured env
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	if config.WorkingDir != "" {
		cmd.Dir = config.WorkingDir
	}

	// Stderr goes to our logger
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

	// Create ACP client
	acpCli := &acpClient{
		autoApprove: config.Permissions == PermissionAuto,
		workingDir:  config.WorkingDir,
	}

	// Create ACP connection
	conn := acp.NewClientSideConnection(acpCli, stdin, stdout)

	// Initialize handshake
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

	log.Info().
		Int("protocol", int(initResp.ProtocolVersion)).
		Str("agent_name", safeImplName(initResp.AgentInfo)).
		Msg("ACP initialized")

	// Create session
	cwd := config.WorkingDir
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	sessResp, err := conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd:        cwd,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
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

	// Set mode if specified
	if config.Permissions == PermissionDeny {
		conn.SetSessionMode(ctx, acp.SetSessionModeRequest{
			SessionId: sessResp.SessionId,
			ModeId:    "plan",
		})
	}

	session := &acpSession{
		cmd:       cmd,
		conn:      conn,
		client:    acpCli,
		sessionID: string(sessResp.SessionId),
		agentType: agentCfg.Type,
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

	// Cache session models
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

	// Watch for process exit
	go func() {
		<-conn.Done()
		log.Info().
			Str("session_id", session.sessionID).
			Str("agent", string(agentCfg.Type)).
			Msg("ACP connection closed")
	}()

	return session, nil
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

	events := make(chan []byte, 256)

	// Wire the events channel to the ACP client
	s.client.setEvents(events)

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
		defer s.client.clearEvents()

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

		log.Debug().
			Str("stop_reason", string(resp.StopReason)).
			Str("session_id", s.sessionID).
			Msg("ACP prompt completed")

		if data, err := json.Marshal(map[string]any{
			"type":       "turn.complete",
			"stopReason": string(resp.StopReason),
		}); err == nil {
			events <- data
		}
	}()

	return events, nil
}

// LoadSession loads a historical session from the agent's persistence layer.
// Returns the collected raw JSON frames synchronously. The ACP conn.LoadSession()
// call blocks while the agent replays history via SessionUpdate notifications.
//
// Design: We use a large-buffer channel + async drain goroutine to avoid
// deadlock. The ACP SDK's reader goroutine calls emit() for each replayed
// event. If emit() blocks (channel full), the reader can't deliver the
// LoadSession JSON-RPC response, causing deadlock. The drain goroutine
// ensures the channel is always being consumed.
func (s *acpSession) LoadSession(ctx context.Context, sessionID string, cwd string) ([][]byte, error) {
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

	log.Info().Str("sessionId", sessionID).Str("cwd", cwd).Msg("calling ACP session/load")

	// Large buffer to avoid blocking the ACP SDK's reader goroutine.
	collector := make(chan []byte, 4096)
	s.client.setEvents(collector)

	// Drain collector into a slice asynchronously — this prevents deadlock
	// between emit() blocking on a full channel and conn.LoadSession()
	// waiting for the response that the blocked reader can't deliver.
	var collected [][]byte
	drainDone := make(chan struct{})
	go func() {
		defer close(drainDone)
		for frame := range collector {
			collected = append(collected, frame)
		}
	}()

	// conn.LoadSession blocks. During this call, the agent replays history
	// as SessionUpdate notifications → acpClient.emit() → collector channel.
	_, err := s.conn.LoadSession(ctx, acp.LoadSessionRequest{
		SessionId:  acp.SessionId(sessionID),
		Cwd:        cwd,
		McpServers: []acp.McpServer{},
	})

	// Stop collecting: disconnect the channel, close it, wait for drain.
	s.client.clearEvents()
	close(collector)
	<-drainDone

	if err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Int("frames", len(collected)).Msg("LoadSession failed")
		return nil, err
	}

	log.Info().Str("sessionId", sessionID).Int("frames", len(collected)).Msg("LoadSession completed")

	// Update the session's internal ACP session ID to the loaded one
	s.mu.Lock()
	s.sessionID = sessionID
	s.mu.Unlock()

	return collected, nil
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
	return err
}

// SetModel changes the active model for this session.
func (s *acpSession) SetModel(ctx context.Context, modelID string) error {
	_, err := s.conn.SetSessionModel(ctx, acp.SetSessionModelRequest{
		SessionId: acp.SessionId(s.sessionID),
		ModelId:   acp.ModelId(modelID),
	})
	return err
}

// Stop cancels the current operation (sends SIGINT equivalent via ACP Cancel).
func (s *acpSession) Stop() error {
	return s.conn.Cancel(context.Background(), acp.CancelNotification{
		SessionId: acp.SessionId(s.sessionID),
	})
}

// Close terminates the session and kills the agent process.
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
		Msg("closing ACP session")

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
