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

// acpClient implements the acp.Client interface, translating ACP callbacks
// into our Event stream. One instance per session.
type acpClient struct {
	autoApprove bool
	workingDir  string

	// Current events channel — set by Send(), cleared when prompt completes.
	mu            sync.RWMutex
	currentEvents chan<- Event

	// Permission handling — maps request ID to response channel.
	permMu       sync.Mutex
	permChannels map[string]chan permResponse
}

type permResponse struct {
	allowed  bool
	optionID acp.PermissionOptionId
}

// setEvents sets the current events channel for streaming.
func (c *acpClient) setEvents(ch chan<- Event) {
	c.mu.Lock()
	c.currentEvents = ch
	c.mu.Unlock()
}

// clearEvents clears the current events channel.
func (c *acpClient) clearEvents() {
	c.mu.Lock()
	c.currentEvents = nil
	c.mu.Unlock()
}

// emit sends an event to the current channel, if any.
func (c *acpClient) emit(evt Event) {
	c.mu.RLock()
	ch := c.currentEvents
	c.mu.RUnlock()

	if ch != nil {
		ch <- evt
	}
}

// --- ACP Client interface implementation ---

// SessionUpdate receives streaming updates from the agent.
// Called on the ACP SDK's notification goroutine during Prompt().
func (c *acpClient) SessionUpdate(ctx context.Context, params acp.SessionNotification) error {
	update := params.Update

	switch {
	case update.AgentMessageChunk != nil:
		text := ""
		if update.AgentMessageChunk.Content.Text != nil {
			text = update.AgentMessageChunk.Content.Text.Text
		}
		// Skip empty initial chunk (turn-start marker)
		if text == "" {
			return nil
		}
		c.emit(Event{
			Type:  EventDelta,
			Delta: text,
		})

	case update.AgentThoughtChunk != nil:
		text := ""
		if update.AgentThoughtChunk.Content.Text != nil {
			text = update.AgentThoughtChunk.Content.Text.Text
		}
		if text == "" {
			return nil
		}
		c.emit(Event{
			Type: EventMessage,
			Message: &Message{
				Role: RoleAssistant,
				Content: []Block{{
					Type: BlockThinking,
					Text: text,
				}},
			},
		})

	case update.ToolCall != nil:
		tc := update.ToolCall
		rawInput, _ := marshalAny(tc.RawInput)
		c.emit(Event{
			Type: EventMessage,
			Message: &Message{
				Role: RoleAssistant,
				Content: []Block{{
					Type:      BlockToolUse,
					ToolName:  tc.Title,
					ToolUseID: string(tc.ToolCallId),
					ToolKind:  string(tc.Kind),
					ToolInput: rawInput,
				}},
			},
		})

	case update.ToolCallUpdate != nil:
		tc := update.ToolCallUpdate
		if tc.Status != nil && *tc.Status == acp.ToolCallStatusCompleted {
			// Extract output from content
			output := extractToolCallOutput(tc.Content)
			c.emit(Event{
				Type: EventMessage,
				Message: &Message{
					Role: RoleAssistant,
					Content: []Block{{
						Type:      BlockToolResult,
						ToolUseID: string(tc.ToolCallId),
						Text:      output,
					}},
				},
			})
		}

	case update.Plan != nil:
		// Plan entries — emit as a message with structured plan data
		if len(update.Plan.Entries) > 0 {
			entries := make([]PlanEntry, len(update.Plan.Entries))
			for i, e := range update.Plan.Entries {
				entries[i] = PlanEntry{
					Content:  e.Content,
					Status:   string(e.Status),
					Priority: string(e.Priority),
				}
			}
			c.emit(Event{
				Type: EventMessage,
				Message: &Message{
					Role: RoleAssistant,
					Content: []Block{{
						Type:        BlockPlan,
						PlanEntries: entries,
					}},
				},
			})
		}

	case update.CurrentModeUpdate != nil:
		modeID := string(update.CurrentModeUpdate.CurrentModeId)
		log.Info().Str("mode", modeID).Msg("ACP mode changed")
		c.emit(Event{
			Type: EventModeUpdate,
			SessionMeta: &SessionMeta{
				ModeID: modeID,
			},
		})

	case update.AvailableCommandsUpdate != nil:
		cmds := update.AvailableCommandsUpdate.AvailableCommands
		log.Debug().Int("commands", len(cmds)).Msg("ACP commands updated")

		cmdList := make([]map[string]any, len(cmds))
		for i, cmd := range cmds {
			entry := map[string]any{
				"name":        cmd.Name,
				"description": cmd.Description,
			}
			if cmd.Input != nil && cmd.Input.UnstructuredCommandInput != nil {
				entry["input"] = map[string]any{"hint": cmd.Input.UnstructuredCommandInput.Hint}
			}
			cmdList[i] = entry
		}
		cmdJSON, _ := json.Marshal(cmdList)

		c.emit(Event{
			Type: EventCommandsUpdate,
			SessionMeta: &SessionMeta{
				Commands: cmdJSON,
			},
		})

	case update.UserMessageChunk != nil:
		// Agent echoes user message — skip to avoid duplicate
		// (we already broadcast the user message ourselves)

	default:
		log.Debug().Msg("ACP: unknown session update type")
	}

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

	// Build permission request event
	rawInput, _ := marshalAny(params.ToolCall.RawInput)
	title := ""
	if params.ToolCall.Title != nil {
		title = *params.ToolCall.Title
	}
	kind := ""
	if params.ToolCall.Kind != nil {
		kind = string(*params.ToolCall.Kind)
	}

	// Build option info for the frontend
	options := make([]PermissionOption, len(params.Options))
	for i, opt := range params.Options {
		options[i] = PermissionOption{
			ID:   string(opt.OptionId),
			Kind: string(opt.Kind),
			Name: opt.Name,
		}
	}

	c.emit(Event{
		Type: EventPermissionRequest,
		PermissionRequest: &PermissionRequest{
			ID:       requestID,
			Tool:     title,
			ToolKind: kind,
			Input:    rawInput,
			Options:  options,
		},
	})

	// Block until RespondToPermission is called or context cancelled
	select {
	case <-ctx.Done():
		return acp.RequestPermissionResponse{
			Outcome: acp.NewRequestPermissionOutcomeCancelled(),
		}, nil

	case resp := <-respCh:
		if !resp.allowed {
			// Find reject option
			for _, opt := range params.Options {
				if opt.Kind == acp.PermissionOptionKindRejectOnce {
					return acp.RequestPermissionResponse{
						Outcome: acp.NewRequestPermissionOutcomeSelected(opt.OptionId),
					}, nil
				}
			}
			return acp.RequestPermissionResponse{
				Outcome: acp.NewRequestPermissionOutcomeCancelled(),
			}, nil
		}

		// Use the specified option ID if provided, otherwise find allow_once
		if resp.optionID != "" {
			return acp.RequestPermissionResponse{
				Outcome: acp.NewRequestPermissionOutcomeSelected(resp.optionID),
			}, nil
		}
		for _, opt := range params.Options {
			if opt.Kind == acp.PermissionOptionKindAllowOnce {
				return acp.RequestPermissionResponse{
					Outcome: acp.NewRequestPermissionOutcomeSelected(opt.OptionId),
				}, nil
			}
		}
		// Fallback to first option
		if len(params.Options) > 0 {
			return acp.RequestPermissionResponse{
				Outcome: acp.NewRequestPermissionOutcomeSelected(params.Options[0].OptionId),
			}, nil
		}
		return acp.RequestPermissionResponse{
			Outcome: acp.NewRequestPermissionOutcomeCancelled(),
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
				Outcome: acp.NewRequestPermissionOutcomeSelected(opt.OptionId),
			}, nil
		}
	}
	for _, opt := range params.Options {
		if opt.Kind == acp.PermissionOptionKindAllowOnce {
			return acp.RequestPermissionResponse{
				Outcome: acp.NewRequestPermissionOutcomeSelected(opt.OptionId),
			}, nil
		}
	}
	if len(params.Options) > 0 {
		return acp.RequestPermissionResponse{
			Outcome: acp.NewRequestPermissionOutcomeSelected(params.Options[0].OptionId),
		}, nil
	}
	return acp.RequestPermissionResponse{
		Outcome: acp.NewRequestPermissionOutcomeCancelled(),
	}, nil
}
