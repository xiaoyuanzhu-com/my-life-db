//go:build acptest

package acptest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// Harness manages an ACP agent process and connection for testing.
// It records all events for later inspection.
type Harness struct {
	t    *testing.T
	cmd  *exec.Cmd
	conn *acp.ClientSideConnection

	sessionID acp.SessionId
	client    *recordingClient

	mu     sync.Mutex
	closed bool
}

// NewHarness launches an ACP agent and establishes a connection.
// It handles Initialize and NewSession automatically.
// Call Close() when done (or use t.Cleanup).
func NewHarness(t *testing.T, opts ...HarnessOption) *Harness {
	t.Helper()

	cfg := &harnessConfig{
		command: "claude-agent-acp",
		cwd:     t.TempDir(),
		timeout: 2 * time.Minute,
	}
	for _, opt := range opts {
		opt(cfg)
	}

	// Check prerequisites
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("MLD_LLM_ANTHROPIC_KEY")
	}

	// Check if claude CLI is authenticated (covers subscription-based auth)
	if apiKey == "" {
		authCmd := exec.Command("claude", "auth", "status")
		if authOut, err := authCmd.Output(); err == nil && strings.Contains(string(authOut), `"loggedIn": true`) {
			t.Logf("Using Claude CLI subscription auth (no API key needed)")
		} else {
			t.Skip("ANTHROPIC_API_KEY, MLD_LLM_ANTHROPIC_KEY, or 'claude auth login' required for ACP tests")
		}
	}

	if _, err := exec.LookPath(cfg.command); err != nil {
		t.Skipf("%s not found in PATH: %v", cfg.command, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.timeout)

	// Create recording client
	client := &recordingClient{
		t:              t,
		autoApprove:    cfg.autoApprove,
		permissionChan: make(chan permissionEvent, 16),
		emitNext:       1, // first seq from frameSeq.Add(1) is 1
	}
	client.emitCond = sync.NewCond(&client.emitMu)

	// Launch agent process
	cmd := exec.CommandContext(ctx, cfg.command)
	cmd.Env = os.Environ()
	if apiKey != "" {
		cmd.Env = append(cmd.Env, "ANTHROPIC_API_KEY="+apiKey)
	}
	if cfg.baseURL != "" {
		cmd.Env = append(cmd.Env, "ANTHROPIC_BASE_URL="+cfg.baseURL)
	}
	cmd.Stderr = &testWriter{t: t, prefix: "[agent stderr] "}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		t.Fatalf("StdinPipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatalf("StdoutPipe: %v", err)
	}

	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatalf("Start %s: %v", cfg.command, err)
	}

	// Create ACP connection
	conn := acp.NewClientSideConnection(client, stdin, stdout)

	h := &Harness{
		t:      t,
		cmd:    cmd,
		conn:   conn,
		client: client,
	}

	t.Cleanup(func() {
		cancel()
		h.Close()
	})

	// Initialize
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
			Name:    "mylifedb-acptest",
			Version: "0.1.0",
		},
	})
	if err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	t.Logf("ACP initialized: protocol=%d agent=%s/%s",
		initResp.ProtocolVersion,
		safeStr(initResp.AgentInfo, func(i *acp.Implementation) string { return i.Name }),
		safeStr(initResp.AgentInfo, func(i *acp.Implementation) string { return i.Version }),
	)

	if len(initResp.AuthMethods) > 0 {
		t.Logf("Auth methods available: %d", len(initResp.AuthMethods))
		for _, m := range initResp.AuthMethods {
			t.Logf("  - %s: %s", m.Id, m.Name)
		}
	}

	// Create session
	sessResp, err := conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd:        cfg.cwd,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}

	h.sessionID = sessResp.SessionId
	t.Logf("Session created: %s", sessResp.SessionId)

	if sessResp.Modes != nil {
		t.Logf("Available modes:")
		for _, m := range sessResp.Modes.AvailableModes {
			current := ""
			if m.Id == sessResp.Modes.CurrentModeId {
				current = " (current)"
			}
			t.Logf("  - %s: %s%s", m.Id, m.Name, current)
		}
	}
	if sessResp.Models != nil {
		t.Logf("Available models:")
		for _, m := range sessResp.Models.AvailableModels {
			current := ""
			if m.ModelId == sessResp.Models.CurrentModelId {
				current = " (current)"
			}
			t.Logf("  - %s: %s%s", m.ModelId, m.Name, current)
		}
	}

	return h
}

// Prompt sends a prompt and waits for completion. Returns the stop reason
// and all events recorded during the prompt.
func (h *Harness) Prompt(ctx context.Context, text string) (acp.StopReason, []RecordedEvent) {
	h.t.Helper()

	// Reset recorded events for this prompt
	h.client.resetEvents()

	resp, err := h.conn.Prompt(ctx, acp.PromptRequest{
		SessionId: h.sessionID,
		Prompt:    []acp.ContentBlock{acp.TextBlock(text)},
	})
	if err != nil {
		h.t.Fatalf("Prompt: %v", err)
	}

	events := h.client.getEvents()
	h.t.Logf("Prompt completed: stopReason=%s events=%d", resp.StopReason, len(events))

	return resp.StopReason, events
}

// Cancel sends a cancel notification.
func (h *Harness) Cancel(ctx context.Context) {
	if err := h.conn.Cancel(ctx, acp.CancelNotification{SessionId: h.sessionID}); err != nil {
		h.t.Logf("Cancel warning: %v", err)
	}
}

// SessionID returns the current session ID.
func (h *Harness) SessionID() acp.SessionId { return h.sessionID }

// Conn returns the raw ACP connection for advanced tests.
func (h *Harness) Conn() *acp.ClientSideConnection { return h.conn }

// Client returns the recording client for inspecting callbacks.
func (h *Harness) Client() *recordingClient { return h.client }

// Close kills the agent process and cleans up.
func (h *Harness) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true

	if h.cmd != nil && h.cmd.Process != nil {
		h.cmd.Process.Kill()
		h.cmd.Wait()
	}
}

// --- Configuration ---

type harnessConfig struct {
	command     string
	cwd         string
	timeout     time.Duration
	autoApprove bool
	baseURL     string
}

// HarnessOption configures the test harness.
type HarnessOption func(*harnessConfig)

// WithCommand sets the agent binary command.
func WithCommand(cmd string) HarnessOption {
	return func(c *harnessConfig) { c.command = cmd }
}

// WithCwd sets the working directory for the session.
func WithCwd(cwd string) HarnessOption {
	return func(c *harnessConfig) { c.cwd = cwd }
}

// WithTimeout sets the overall test timeout.
func WithTimeout(d time.Duration) HarnessOption {
	return func(c *harnessConfig) { c.timeout = d }
}

// WithAutoApprove enables auto-approval for all permission requests.
func WithAutoApprove() HarnessOption {
	return func(c *harnessConfig) { c.autoApprove = true }
}

// WithBaseURL sets the ANTHROPIC_BASE_URL for the agent.
func WithBaseURL(url string) HarnessOption {
	return func(c *harnessConfig) { c.baseURL = url }
}

// --- Recording Client ---

// RecordedEvent captures a single ACP event with metadata.
type RecordedEvent struct {
	Time      time.Time
	Seq       int64           // monotonic wire-order sequence number
	Type      string          // "agent_message", "agent_thought", "user_message", "tool_call", "tool_call_update", "plan", "mode_update", "commands_update", "permission", "read_file", "write_file", "terminal_create"
	Raw       json.RawMessage // original JSON for debugging
	SessionID acp.SessionId

	// Populated based on Type:
	AgentMessageChunk *acp.SessionUpdateAgentMessageChunk
	AgentThoughtChunk *acp.SessionUpdateAgentThoughtChunk
	UserMessageChunk  *acp.SessionUpdateUserMessageChunk
	ToolCall          *acp.SessionUpdateToolCall
	ToolCallUpdate    *acp.SessionToolCallUpdate
	Plan              *acp.SessionUpdatePlan
	ModeUpdate        *acp.SessionCurrentModeUpdate
	CommandsUpdate    *acp.SessionAvailableCommandsUpdate
	Permission        *acp.RequestPermissionRequest
	ReadFile          *acp.ReadTextFileRequest
	WriteFile         *acp.WriteTextFileRequest
	TerminalCreate    *acp.CreateTerminalRequest
}

type permissionEvent struct {
	request  acp.RequestPermissionRequest
	response chan acp.RequestPermissionResponse
}

type recordingClient struct {
	t              *testing.T
	autoApprove    bool
	permissionChan chan permissionEvent

	mu        sync.Mutex
	events    []RecordedEvent
	terminals map[string]*terminalState

	// Ordered delivery: the ACP SDK dispatches SessionUpdate via concurrent
	// goroutines (`go handleInbound()` in connection.go). Without ordering,
	// events are recorded in arbitrary goroutine-scheduled order, not wire order.
	// This mirrors the fix in production acpclient.go.
	frameSeq atomic.Int64 // next seq to assign (via Add(1))
	emitMu   sync.Mutex   // protects emitNext + emitCond
	emitNext int64         // next seq to emit (starts at 1)
	emitCond *sync.Cond   // signaled when emitNext advances
}

func (c *recordingClient) resetEvents() {
	c.mu.Lock()
	c.events = nil
	c.mu.Unlock()
}

func (c *recordingClient) getEvents() []RecordedEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	result := make([]RecordedEvent, len(c.events))
	copy(result, c.events)
	return result
}

func (c *recordingClient) record(evt RecordedEvent) {
	evt.Time = time.Now()
	c.mu.Lock()
	c.events = append(c.events, evt)
	c.mu.Unlock()
}

// --- ACP Client interface implementation ---

func (c *recordingClient) SessionUpdate(ctx context.Context, params acp.SessionNotification) error {
	raw, _ := json.Marshal(params)

	// Assign a monotonic sequence number for wire-order enforcement.
	// The ACP SDK dispatches each SessionUpdate via `go handleInbound()`
	// goroutines, so without this, events record in arbitrary order.
	seq := c.frameSeq.Add(1)

	// Wait for our turn — enforces wire order despite goroutine scheduling.
	c.emitMu.Lock()
	for c.emitNext != seq {
		c.emitCond.Wait()
	}
	defer func() {
		c.emitNext++
		c.emitCond.Broadcast()
		c.emitMu.Unlock()
	}()

	update := params.Update
	switch {
	case update.AgentMessageChunk != nil:
		text := ""
		if update.AgentMessageChunk.Content.Text != nil {
			text = update.AgentMessageChunk.Content.Text.Text
		}
		c.t.Logf("[update] seq=%d agent_message: %q", seq, truncate(text, 100))
		c.record(RecordedEvent{
			Seq:               seq,
			Type:              "agent_message",
			Raw:               raw,
			SessionID:         params.SessionId,
			AgentMessageChunk: update.AgentMessageChunk,
		})

	case update.AgentThoughtChunk != nil:
		text := ""
		if update.AgentThoughtChunk.Content.Text != nil {
			text = update.AgentThoughtChunk.Content.Text.Text
		}
		c.t.Logf("[update] seq=%d agent_thought: %q", seq, truncate(text, 100))
		c.record(RecordedEvent{
			Seq:               seq,
			Type:              "agent_thought",
			Raw:               raw,
			SessionID:         params.SessionId,
			AgentThoughtChunk: update.AgentThoughtChunk,
		})

	case update.UserMessageChunk != nil:
		c.t.Logf("[update] seq=%d user_message_chunk", seq)
		c.record(RecordedEvent{
			Seq:              seq,
			Type:             "user_message",
			Raw:              raw,
			SessionID:        params.SessionId,
			UserMessageChunk: update.UserMessageChunk,
		})

	case update.ToolCall != nil:
		c.t.Logf("[update] seq=%d tool_call: id=%s title=%q kind=%s status=%s",
			seq,
			update.ToolCall.ToolCallId,
			update.ToolCall.Title,
			update.ToolCall.Kind,
			update.ToolCall.Status,
		)
		c.record(RecordedEvent{
			Seq:       seq,
			Type:      "tool_call",
			Raw:       raw,
			SessionID: params.SessionId,
			ToolCall:  update.ToolCall,
		})

	case update.ToolCallUpdate != nil:
		status := ""
		if update.ToolCallUpdate.Status != nil {
			status = string(*update.ToolCallUpdate.Status)
		}
		c.t.Logf("[update] seq=%d tool_call_update: id=%s status=%s",
			seq, update.ToolCallUpdate.ToolCallId, status)
		c.record(RecordedEvent{
			Seq:            seq,
			Type:           "tool_call_update",
			Raw:            raw,
			SessionID:      params.SessionId,
			ToolCallUpdate: update.ToolCallUpdate,
		})

	case update.Plan != nil:
		c.t.Logf("[update] seq=%d plan: %d entries", seq, len(update.Plan.Entries))
		c.record(RecordedEvent{
			Seq:       seq,
			Type:      "plan",
			Raw:       raw,
			SessionID: params.SessionId,
			Plan:      update.Plan,
		})

	case update.CurrentModeUpdate != nil:
		c.t.Logf("[update] seq=%d mode_update: %s", seq, update.CurrentModeUpdate.CurrentModeId)
		c.record(RecordedEvent{
			Seq:        seq,
			Type:       "mode_update",
			Raw:        raw,
			SessionID:  params.SessionId,
			ModeUpdate: update.CurrentModeUpdate,
		})

	case update.AvailableCommandsUpdate != nil:
		c.t.Logf("[update] seq=%d commands_update: %d commands", seq, len(update.AvailableCommandsUpdate.AvailableCommands))
		c.record(RecordedEvent{
			Seq:            seq,
			Type:           "commands_update",
			Raw:            raw,
			SessionID:      params.SessionId,
			CommandsUpdate: update.AvailableCommandsUpdate,
		})

	default:
		c.t.Logf("[update] seq=%d unknown update type: %s", seq, string(raw))
		c.record(RecordedEvent{Seq: seq, Type: "unknown", Raw: raw, SessionID: params.SessionId})
	}

	return nil
}

func (c *recordingClient) RequestPermission(ctx context.Context, params acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	c.t.Logf("[permission] tool=%s options=%d",
		params.ToolCall.ToolCallId,
		len(params.Options))

	for i, opt := range params.Options {
		c.t.Logf("  option[%d]: kind=%s name=%q id=%s", i, opt.Kind, opt.Name, opt.OptionId)
	}

	if params.ToolCall.Title != nil {
		c.t.Logf("  title: %s", *params.ToolCall.Title)
	}
	if params.ToolCall.Kind != nil {
		c.t.Logf("  kind: %s", *params.ToolCall.Kind)
	}
	if params.ToolCall.RawInput != nil {
		raw, _ := json.Marshal(params.ToolCall.RawInput)
		c.t.Logf("  rawInput: %s", truncate(string(raw), 200))
	}

	c.record(RecordedEvent{
		Type:       "permission",
		SessionID:  params.SessionId,
		Permission: &params,
	})

	if c.autoApprove {
		// Find allow_once or allow_always
		for _, opt := range params.Options {
			if opt.Kind == acp.PermissionOptionKindAllowOnce {
				c.t.Logf("  → auto-approve (allow_once): %s", opt.OptionId)
				return acp.RequestPermissionResponse{
					Outcome: acp.NewRequestPermissionOutcomeSelected(opt.OptionId),
				}, nil
			}
		}
		// Fallback to first option
		if len(params.Options) > 0 {
			c.t.Logf("  → auto-approve (first option): %s", params.Options[0].OptionId)
			return acp.RequestPermissionResponse{
				Outcome: acp.NewRequestPermissionOutcomeSelected(params.Options[0].OptionId),
			}, nil
		}
	}

	// Block until test provides a response
	c.t.Logf("  → waiting for test to provide response...")
	select {
	case <-ctx.Done():
		return acp.RequestPermissionResponse{
			Outcome: acp.NewRequestPermissionOutcomeCancelled(),
		}, nil
	case evt := <-c.permissionChan:
		// Not used in auto-approve mode
		_ = evt
		return acp.RequestPermissionResponse{
			Outcome: acp.NewRequestPermissionOutcomeCancelled(),
		}, nil
	}
}

func (c *recordingClient) ReadTextFile(ctx context.Context, params acp.ReadTextFileRequest) (acp.ReadTextFileResponse, error) {
	c.t.Logf("[fs] read_text_file: %s", params.Path)
	c.record(RecordedEvent{
		Type:      "read_file",
		SessionID: params.SessionId,
		ReadFile:  &params,
	})

	content, err := os.ReadFile(params.Path)
	if err != nil {
		return acp.ReadTextFileResponse{}, fmt.Errorf("read %s: %w", params.Path, err)
	}
	return acp.ReadTextFileResponse{Content: string(content)}, nil
}

func (c *recordingClient) WriteTextFile(ctx context.Context, params acp.WriteTextFileRequest) (acp.WriteTextFileResponse, error) {
	c.t.Logf("[fs] write_text_file: %s (%d bytes)", params.Path, len(params.Content))
	c.record(RecordedEvent{
		Type:      "write_file",
		SessionID: params.SessionId,
		WriteFile: &params,
	})

	if err := os.WriteFile(params.Path, []byte(params.Content), 0644); err != nil {
		return acp.WriteTextFileResponse{}, fmt.Errorf("write %s: %w", params.Path, err)
	}
	return acp.WriteTextFileResponse{}, nil
}

func (c *recordingClient) CreateTerminal(ctx context.Context, params acp.CreateTerminalRequest) (acp.CreateTerminalResponse, error) {
	c.t.Logf("[terminal] create: %s %v", params.Command, params.Args)
	c.record(RecordedEvent{
		Type:           "terminal_create",
		SessionID:      params.SessionId,
		TerminalCreate: &params,
	})

	// Run the command synchronously for simplicity in tests
	args := params.Args
	cmd := exec.CommandContext(ctx, params.Command, args...)
	if params.Cwd != nil {
		cmd.Dir = *params.Cwd
	}
	for _, env := range params.Env {
		cmd.Env = append(cmd.Env, env.Name+"="+env.Value)
	}

	output, err := cmd.CombinedOutput()
	terminalID := fmt.Sprintf("term-%d", time.Now().UnixNano())

	// Store output for later retrieval
	c.mu.Lock()
	if c.terminals == nil {
		c.terminals = make(map[string]*terminalState)
	}
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		}
	}
	c.terminals[terminalID] = &terminalState{
		output:   string(output),
		exitCode: exitCode,
		exited:   true,
	}
	c.mu.Unlock()

	return acp.CreateTerminalResponse{TerminalId: terminalID}, nil
}

func (c *recordingClient) TerminalOutput(ctx context.Context, params acp.TerminalOutputRequest) (acp.TerminalOutputResponse, error) {
	c.mu.Lock()
	state, ok := c.terminals[params.TerminalId]
	c.mu.Unlock()

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

func (c *recordingClient) KillTerminalCommand(ctx context.Context, params acp.KillTerminalCommandRequest) (acp.KillTerminalCommandResponse, error) {
	c.t.Logf("[terminal] kill: %s", params.TerminalId)
	return acp.KillTerminalCommandResponse{}, nil
}

func (c *recordingClient) ReleaseTerminal(ctx context.Context, params acp.ReleaseTerminalRequest) (acp.ReleaseTerminalResponse, error) {
	c.t.Logf("[terminal] release: %s", params.TerminalId)
	c.mu.Lock()
	delete(c.terminals, params.TerminalId)
	c.mu.Unlock()
	return acp.ReleaseTerminalResponse{}, nil
}

func (c *recordingClient) WaitForTerminalExit(ctx context.Context, params acp.WaitForTerminalExitRequest) (acp.WaitForTerminalExitResponse, error) {
	c.mu.Lock()
	state, ok := c.terminals[params.TerminalId]
	c.mu.Unlock()

	if !ok {
		return acp.WaitForTerminalExitResponse{}, fmt.Errorf("terminal %s not found", params.TerminalId)
	}

	return acp.WaitForTerminalExitResponse{
		ExitCode: &state.exitCode,
	}, nil
}

// --- Supporting types ---

type terminalState struct {
	output   string
	exitCode int
	exited   bool
}

// --- Event query helpers ---

// Events returns all recorded events of the given type.
func Events(events []RecordedEvent, eventType string) []RecordedEvent {
	var result []RecordedEvent
	for _, e := range events {
		if e.Type == eventType {
			result = append(result, e)
		}
	}
	return result
}

// HasEvent returns true if any event of the given type exists.
func HasEvent(events []RecordedEvent, eventType string) bool {
	return len(Events(events, eventType)) > 0
}

// AgentText concatenates all agent message text from events.
func AgentText(events []RecordedEvent) string {
	var text string
	for _, e := range events {
		if e.AgentMessageChunk != nil && e.AgentMessageChunk.Content.Text != nil {
			text += e.AgentMessageChunk.Content.Text.Text
		}
	}
	return text
}

// ThoughtText concatenates all agent thought text from events.
func ThoughtText(events []RecordedEvent) string {
	var text string
	for _, e := range events {
		if e.AgentThoughtChunk != nil && e.AgentThoughtChunk.Content.Text != nil {
			text += e.AgentThoughtChunk.Content.Text.Text
		}
	}
	return text
}

// ToolCalls returns all tool call start events.
func ToolCalls(events []RecordedEvent) []RecordedEvent {
	return Events(events, "tool_call")
}

// Permissions returns all permission request events.
func Permissions(events []RecordedEvent) []RecordedEvent {
	return Events(events, "permission")
}

// --- Utilities ---

type testWriter struct {
	t      *testing.T
	prefix string
}

func (w *testWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s%s", w.prefix, string(p))
	return len(p), nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func safeStr[T any](ptr *T, fn func(*T) string) string {
	if ptr == nil {
		return "<nil>"
	}
	return fn(ptr)
}
