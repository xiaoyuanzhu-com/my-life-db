package agentsdk

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"

	acp "github.com/coder/acp-go-sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// acpClient implements the acp.Client interface, re-marshaling ACP notifications
// as raw JSON bytes and emitting them via a permanent handler. One instance per session.
//
// Design: a single `onFrame` callback handles ALL frames for the session lifetime.
// No temporary channels, no set/clear cycle, no gaps where frames can be dropped.
//
// Ordering: the ACP SDK (v0.6.4+) serializes notification delivery via a bounded
// queue + single processNotifications() goroutine, so SessionUpdate calls arrive
// in pipe order. No client-side ordering needed.
type acpClient struct {
	autoApprove bool
	workingDir  string

	// Permanent frame handler — set once via SetOnFrame(), never cleared.
	// Every frame from the ACP SDK is delivered here. Never nil after setup.
	mu      sync.RWMutex
	onFrame func([]byte)

	// Diagnostic counter for logging frame sequence.
	frameSeq atomic.Int64

	// Permission handling — maps request ID to response channel.
	permMu       sync.Mutex
	permChannels map[string]chan permResponse
}

type permResponse struct {
	allowed  bool
	optionID acp.PermissionOptionId
}

// emit sends raw JSON bytes to the permanent handler immediately (unordered).
// Used for out-of-band frames like permission requests that don't participate
// in the SessionUpdate sequencing.
func (c *acpClient) emit(data []byte) {
	c.mu.RLock()
	fn := c.onFrame
	c.mu.RUnlock()

	if fn != nil {
		fn(data)
	} else {
		log.Warn().Msg("ACP: frame dropped — onFrame not set")
	}
}

// --- ACP Client interface implementation ---

// SessionUpdate receives streaming updates from the agent.
// Called on the ACP SDK's notification goroutine during Prompt().
// Re-marshals the ACP notification's Update to raw JSON and emits it.
func (c *acpClient) SessionUpdate(ctx context.Context, params acp.SessionNotification) error {
	update := params.Update

	// Skip empty initial agent_message_chunk (turn-start marker from ACP)
	if update.AgentMessageChunk != nil &&
		update.AgentMessageChunk.Content.Text != nil &&
		update.AgentMessageChunk.Content.Text.Text == "" {
		return nil
	}

	// Debug: log frame sequence to detect ACP SDK goroutine reordering.
	seq := c.frameSeq.Add(1)
	frameType := "unknown"
	framePreview := ""
	switch {
	case update.UserMessageChunk != nil:
		frameType = "user_message_chunk"
		if update.UserMessageChunk.Content.Text != nil {
			t := update.UserMessageChunk.Content.Text.Text
			if len(t) > 80 {
				t = t[:80]
			}
			framePreview = t
		}
	case update.AgentMessageChunk != nil:
		frameType = "agent_message_chunk"
		if update.AgentMessageChunk.Content.Text != nil {
			t := update.AgentMessageChunk.Content.Text.Text
			if len(t) > 80 {
				t = t[:80]
			}
			framePreview = t
		}
	case update.AgentThoughtChunk != nil:
		frameType = "agent_thought_chunk"
		if update.AgentThoughtChunk.Content.Text != nil {
			t := update.AgentThoughtChunk.Content.Text.Text
			if len(t) > 80 {
				t = t[:80]
			}
			framePreview = t
		}
	case update.ToolCall != nil:
		frameType = fmt.Sprintf("tool_call[%s]", update.ToolCall.ToolCallId)
	case update.ToolCallUpdate != nil:
		frameType = fmt.Sprintf("tool_call_update[%s]", update.ToolCallUpdate.ToolCallId)
	case update.AvailableCommandsUpdate != nil:
		frameType = "available_commands_update"
	default:
		frameType = "other"
	}
	log.Info().Int64("seq", seq).Str("frameType", frameType).Str("preview", framePreview).Msg("ACP SessionUpdate received")

	// Marshal the ACP SessionUpdate to JSON (uses ACP SDK's custom MarshalJSON
	// which produces JSON with a "sessionUpdate" discriminator field).
	data, err := json.Marshal(update)
	if err != nil {
		log.Warn().Err(err).Int64("seq", seq).Msg("ACP: failed to marshal session update")
		return nil
	}

	// ⚠️ Mutates raw frame — reviewed perf exception to raw-frame-integrity principle.
	// See StripHeavyToolCallContent doc comment for rationale and list of stripped fields.
	data = StripHeavyToolCallContent(data)

	c.emit(data)
	return nil
}

// RequestPermission handles permission requests from the agent.
// Called on the ACP SDK's notification goroutine — blocks agent until resolved.
func (c *acpClient) RequestPermission(ctx context.Context, params acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	if c.autoApprove {
		return autoApprovePermission(params)
	}

	// Generate a request ID from the tool call ID
	requestID := string(params.ToolCall.ToolCallId)

	// Create response channel
	respCh := make(chan permResponse, 1)
	c.permMu.Lock()
	if c.permChannels == nil {
		c.permChannels = make(map[string]chan permResponse)
	}
	c.permChannels[requestID] = respCh
	c.permMu.Unlock()

	defer func() {
		c.permMu.Lock()
		delete(c.permChannels, requestID)
		c.permMu.Unlock()
	}()

	// Build permission request JSON frame
	toolCallJSON, _ := json.Marshal(params.ToolCall)
	optionsJSON, _ := json.Marshal(params.Options)

	frame, _ := json.Marshal(map[string]json.RawMessage{
		"type":     json.RawMessage(`"permission.request"`),
		"toolCall": toolCallJSON,
		"options":  optionsJSON,
	})
	// Strip heavy payloads from the embedded toolCall (same fields as tool_call frames).
	frame = StripHeavyPermissionContent(frame)
	c.emit(frame)

	// Block until RespondToPermission is called or context cancelled
	select {
	case <-ctx.Done():
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
		}, nil

	case resp := <-respCh:
		if !resp.allowed {
			// Find reject option
			for _, opt := range params.Options {
				if opt.Kind == acp.PermissionOptionKindRejectOnce {
					return acp.RequestPermissionResponse{
						Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: opt.OptionId}},
					}, nil
				}
			}
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
			}, nil
		}

		// Use the specified option ID if provided, otherwise find allow_once
		if resp.optionID != "" {
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: resp.optionID}},
			}, nil
		}
		for _, opt := range params.Options {
			if opt.Kind == acp.PermissionOptionKindAllowOnce {
				return acp.RequestPermissionResponse{
					Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: opt.OptionId}},
				}, nil
			}
		}
		// Fallback to first option
		if len(params.Options) > 0 {
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: params.Options[0].OptionId}},
			}, nil
		}
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
		}, nil
	}
}

// cancelAllPermissions cancels all pending permission requests.
func (c *acpClient) cancelAllPermissions() {
	c.permMu.Lock()
	defer c.permMu.Unlock()
	for id, ch := range c.permChannels {
		select {
		case ch <- permResponse{allowed: false}:
		default:
		}
		delete(c.permChannels, id)
	}
}

// respondToPermission unblocks a pending RequestPermission call.
func (c *acpClient) respondToPermission(requestID string, allowed bool, optionID string) error {
	c.permMu.Lock()
	ch, ok := c.permChannels[requestID]
	c.permMu.Unlock()

	if !ok {
		return &AgentError{
			Type:    ErrNotFound,
			Message: "no pending permission request: " + requestID,
		}
	}

	ch <- permResponse{
		allowed:  allowed,
		optionID: acp.PermissionOptionId(optionID),
	}
	return nil
}

// ReadTextFile handles file read requests from the agent.
// Note: claude-agent-acp doesn't actually call this (reads internally),
// but we implement it for protocol completeness.
func (c *acpClient) ReadTextFile(ctx context.Context, params acp.ReadTextFileRequest) (acp.ReadTextFileResponse, error) {
	log.Debug().Str("path", params.Path).Msg("ACP ReadTextFile callback")

	content, err := os.ReadFile(params.Path)
	if err != nil {
		return acp.ReadTextFileResponse{}, fmt.Errorf("read %s: %w", params.Path, err)
	}
	return acp.ReadTextFileResponse{Content: string(content)}, nil
}

// WriteTextFile handles file write requests from the agent.
// Note: claude-agent-acp doesn't actually call this (writes internally),
// but we implement it for protocol completeness.
func (c *acpClient) WriteTextFile(ctx context.Context, params acp.WriteTextFileRequest) (acp.WriteTextFileResponse, error) {
	log.Debug().Str("path", params.Path).Int("bytes", len(params.Content)).Msg("ACP WriteTextFile callback")

	if err := os.WriteFile(params.Path, []byte(params.Content), 0644); err != nil {
		return acp.WriteTextFileResponse{}, fmt.Errorf("write %s: %w", params.Path, err)
	}
	return acp.WriteTextFileResponse{}, nil
}

// --- Terminal management ---

// terminalState tracks a running terminal process.
type terminalState struct {
	cmd      *exec.Cmd
	output   string
	exitCode int
	exited   bool
	mu       sync.Mutex
}

var (
	terminalsMu     sync.Mutex
	terminals       = make(map[string]*terminalState)
	terminalCounter atomic.Int64
)

func (c *acpClient) CreateTerminal(ctx context.Context, params acp.CreateTerminalRequest) (acp.CreateTerminalResponse, error) {
	log.Info().Str("command", params.Command).Strs("args", params.Args).Msg("ACP CreateTerminal")

	cmd := exec.CommandContext(ctx, params.Command, params.Args...)
	if params.Cwd != nil {
		cmd.Dir = *params.Cwd
	} else if c.workingDir != "" {
		cmd.Dir = c.workingDir
	}
	for _, env := range params.Env {
		cmd.Env = append(cmd.Env, env.Name+"="+env.Value)
	}

	output, err := cmd.CombinedOutput()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	}

	termID := fmt.Sprintf("term-%d", terminalCounter.Add(1))
	state := &terminalState{
		cmd:      cmd,
		output:   string(output),
		exitCode: exitCode,
		exited:   true,
	}

	terminalsMu.Lock()
	terminals[termID] = state
	terminalsMu.Unlock()

	return acp.CreateTerminalResponse{TerminalId: termID}, nil
}

func (c *acpClient) TerminalOutput(ctx context.Context, params acp.TerminalOutputRequest) (acp.TerminalOutputResponse, error) {
	terminalsMu.Lock()
	state, ok := terminals[params.TerminalId]
	terminalsMu.Unlock()

	if !ok {
		return acp.TerminalOutputResponse{}, fmt.Errorf("terminal %s not found", params.TerminalId)
	}

	resp := acp.TerminalOutputResponse{
		Output: state.output,
	}
	if state.exited {
		resp.ExitStatus = &acp.TerminalExitStatus{
			ExitCode: &state.exitCode,
		}
	}
	return resp, nil
}

func (c *acpClient) KillTerminalCommand(ctx context.Context, params acp.KillTerminalCommandRequest) (acp.KillTerminalCommandResponse, error) {
	log.Debug().Str("id", params.TerminalId).Msg("ACP KillTerminalCommand")
	terminalsMu.Lock()
	state, ok := terminals[params.TerminalId]
	terminalsMu.Unlock()

	if ok && state.cmd != nil && state.cmd.Process != nil {
		state.cmd.Process.Kill()
	}
	return acp.KillTerminalCommandResponse{}, nil
}

func (c *acpClient) ReleaseTerminal(ctx context.Context, params acp.ReleaseTerminalRequest) (acp.ReleaseTerminalResponse, error) {
	log.Debug().Str("id", params.TerminalId).Msg("ACP ReleaseTerminal")
	terminalsMu.Lock()
	delete(terminals, params.TerminalId)
	terminalsMu.Unlock()
	return acp.ReleaseTerminalResponse{}, nil
}

func (c *acpClient) WaitForTerminalExit(ctx context.Context, params acp.WaitForTerminalExitRequest) (acp.WaitForTerminalExitResponse, error) {
	terminalsMu.Lock()
	state, ok := terminals[params.TerminalId]
	terminalsMu.Unlock()

	if !ok {
		return acp.WaitForTerminalExitResponse{}, fmt.Errorf("terminal %s not found", params.TerminalId)
	}

	return acp.WaitForTerminalExitResponse{
		ExitCode: &state.exitCode,
	}, nil
}

// --- Helpers ---

func autoApprovePermission(params acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	// Prefer allow_always, then allow_once
	for _, opt := range params.Options {
		if opt.Kind == acp.PermissionOptionKindAllowAlways {
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: opt.OptionId}},
			}, nil
		}
	}
	for _, opt := range params.Options {
		if opt.Kind == acp.PermissionOptionKindAllowOnce {
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: opt.OptionId}},
			}, nil
		}
	}
	if len(params.Options) > 0 {
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: params.Options[0].OptionId}},
		}, nil
	}
	return acp.RequestPermissionResponse{
		Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
	}, nil
}
