package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// PermissionResponse represents a response to an SDK permission request
type PermissionResponse struct {
	Behavior    string // "allow" or "deny"
	Message     string // Optional denial message
	AlwaysAllow bool   // If true, remember this tool as always allowed for the session
	ToolName    string // Tool name (needed for always-allow tracking)
}

// pendingPermission stores a pending permission request with its metadata
type pendingPermission struct {
	toolName  string
	requestID string
	ch        chan PermissionResponse
}

// GitInfo contains metadata about a Git repository
type GitInfo struct {
	IsRepo    bool   `json:"isRepo"`              // Whether the working dir is a Git repository
	Branch    string `json:"branch,omitempty"`    // Current branch name
	RemoteURL string `json:"remoteUrl,omitempty"` // Origin remote URL
}

// SessionMode defines how a session communicates with the Claude CLI
type SessionMode string

const (
	// ModeCLI uses PTY for raw terminal I/O (xterm.js rendering)
	ModeCLI SessionMode = "cli"
	// ModeUI uses JSON streaming over stdin/stdout (structured chat UI)
	ModeUI SessionMode = "ui"
)

// Client represents a WebSocket connection to a session
type Client struct {
	Conn *websocket.Conn
	Send chan []byte
}

// Session represents a Claude Code CLI session
type Session struct {
	ID           string      `json:"id"`
	ProcessID    int         `json:"processId"`
	WorkingDir   string      `json:"workingDir"`
	CreatedAt    time.Time   `json:"createdAt"`
	LastActivity time.Time   `json:"lastActivity"`
	Status       string      `json:"status"` // "archived", "active", "dead"
	Title          string             `json:"title"`
	Mode           SessionMode        `json:"mode"`           // "cli" or "ui"
	PermissionMode sdk.PermissionMode `json:"permissionMode"` // "default", "acceptEdits", "plan", "bypassPermissions"
	Git            *GitInfo           `json:"git"`            // Git repository metadata (nil if not a repo)

	// Internal fields (not serialized)
	Cmd     *exec.Cmd        `json:"-"`
	Clients map[*Client]bool `json:"-"`
	mu      sync.RWMutex     `json:"-"`

	// CLI mode (PTY-based)
	PTY       *os.File     `json:"-"`
	broadcast chan []byte  `json:"-"`
	backlog   []byte       `json:"-"` // Recent output for new clients
	backlogMu sync.RWMutex `json:"-"`

	// UI mode (JSON streaming)
	Stdin  io.WriteCloser `json:"-"`
	Stdout io.ReadCloser  `json:"-"`
	Stderr io.ReadCloser  `json:"-"`

	// UI mode message cache - stores all messages for clients connecting at any time
	// Before activation: loaded from JSONL file
	// After activation: merged with Claude's stdout (deduped by UUID)
	cachedMessages [][]byte         `json:"-"`
	seenUUIDs      map[string]bool  `json:"-"` // Track seen message UUIDs for deduplication
	cacheLoaded    bool             `json:"-"`
	cacheMu        sync.RWMutex     `json:"-"`

	// Pending control requests (UI mode) - maps request_id to response channel
	pendingRequests   map[string]chan map[string]interface{} `json:"-"`
	pendingRequestsMu sync.RWMutex                           `json:"-"`

	// Lazy activation support
	activated  bool          `json:"-"` // Whether the Claude process has been spawned
	activateFn func() error  `json:"-"` // Function to activate this session
	ready      chan struct{} `json:"-"` // Closed when Claude is ready to receive input

	// SDK-based UI mode (replaces direct subprocess management)
	sdkClient  *sdk.ClaudeSDKClient `json:"-"`
	sdkCtx     context.Context      `json:"-"`
	sdkCancel  context.CancelFunc   `json:"-"`

	// Permission bridging for async WebSocket flow (SDK mode only)
	// When SDK's CanUseTool callback is invoked, it blocks waiting for a response.
	// We broadcast a control_request to WebSocket clients and wait for the response here.
	// The map stores tool name alongside the channel so "always allow" can auto-approve
	// other pending requests for the same tool.
	pendingSDKPermissions   map[string]*pendingPermission `json:"-"`
	pendingSDKPermissionsMu sync.RWMutex                  `json:"-"`

	// Always-allowed tools for this session (SDK mode only)
	// When user clicks "Always allow", the tool name is added here.
	// Future permission requests for the same tool auto-allow without prompting.
	alwaysAllowedTools   map[string]bool `json:"-"`
	alwaysAllowedToolsMu sync.RWMutex    `json:"-"`

	// Pending AskUserQuestion requests (SDK mode only)
	// When AskUserQuestion is requested, we broadcast to frontend and wait for user answers.
	// Maps request_id to response channel.
	pendingQuestions   map[string]chan QuestionResponse `json:"-"`
	pendingQuestionsMu sync.RWMutex                     `json:"-"`
}

// QuestionResponse represents the user's answer to an AskUserQuestion request
type QuestionResponse struct {
	Answers map[string]interface{} `json:"answers"` // Question key -> answer
	Skipped bool                   `json:"skipped"` // True if user skipped
}

// AddClient registers a new WebSocket client to this session
// and sends the backlog to catch up
func (s *Session) AddClient(client *Client) {
	s.mu.Lock()
	s.Clients[client] = true
	s.mu.Unlock()

	// Send backlog to new client so they see recent history
	s.backlogMu.RLock()
	if len(s.backlog) > 0 {
		backlogCopy := make([]byte, len(s.backlog))
		copy(backlogCopy, s.backlog)
		s.backlogMu.RUnlock()

		// Send backlog (non-blocking)
		select {
		case client.Send <- backlogCopy:
		default:
		}
	} else {
		s.backlogMu.RUnlock()
	}
}

// RemoveClient unregisters a WebSocket client from this session
func (s *Session) RemoveClient(client *Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.Clients[client]; ok {
		delete(s.Clients, client)
		close(client.Send)
	}
}

// Broadcast sends data to all connected clients and appends to backlog
func (s *Session) Broadcast(data []byte) {
	// Append to backlog (keep everything for full session history)
	s.backlogMu.Lock()
	s.backlog = append(s.backlog, data...)
	s.backlogMu.Unlock()

	// Broadcast to all connected clients
	s.mu.RLock()
	defer s.mu.RUnlock()
	for client := range s.Clients {
		select {
		case client.Send <- data:
		default:
			// Client's send buffer is full, skip
		}
	}
}

// EnsureActivated ensures the session is activated and ready to receive input.
// If not activated, it calls the activation function to spawn the process and waits for readiness.
func (s *Session) EnsureActivated() error {
	s.mu.Lock()
	if s.activated {
		s.mu.Unlock()
		return nil
	}

	if s.activateFn == nil {
		s.mu.Unlock()
		return fmt.Errorf("session cannot be activated: no activation function")
	}

	// Reset message cache before starting new CLI process.
	// This clears any accumulated ephemeral messages (like init) from previous CLI runs
	// and reloads persisted history from JSONL.
	s.mu.Unlock() // Unlock before ResetMessageCache (it acquires cacheMu)
	s.ResetMessageCache()
	s.mu.Lock()

	log.Info().
		Str("sessionId", s.ID).
		Str("mode", string(s.Mode)).
		Str("workingDir", s.WorkingDir).
		Msg("activating session (starting new CLI process)")

	if err := s.activateFn(); err != nil {
		s.mu.Unlock()
		return fmt.Errorf("failed to activate session: %w", err)
	}

	s.activated = true
	readyChan := s.ready
	s.mu.Unlock()

	// Wait for readiness (UI mode: 100ms timer, CLI mode: first output)
	if readyChan != nil {
		select {
		case <-readyChan:
		case <-time.After(5 * time.Second):
		}
	}

	// Brief additional delay for CLI mode to ensure readline is fully initialized
	if s.Mode == ModeCLI {
		time.Sleep(200 * time.Millisecond)
	}

	return nil
}

// IsActivated returns whether the session process is currently running
func (s *Session) IsActivated() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activated
}

// SignalShutdown marks the session as shutting down.
// Call this early in shutdown sequence so process exit errors are expected.
func (s *Session) SignalShutdown() {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.sdkClient != nil {
		s.sdkClient.SignalShutdown()
	}
}

// ToJSON returns a JSON-safe representation of the session
func (s *Session) ToJSON() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := map[string]interface{}{
		"id":             s.ID,
		"processId":      s.ProcessID,
		"workingDir":     s.WorkingDir,
		"createdAt":      s.CreatedAt,
		"lastActivity":   s.LastActivity,
		"status":         s.Status,
		"title":          s.Title,
		"mode":           s.Mode,
		"permissionMode": s.PermissionMode,
		"clients":        len(s.Clients),
	}
	if s.Git != nil {
		result["git"] = s.Git
	}
	return result
}

// SendInputUI sends a user message to Claude via JSON stdin (UI mode only).
// Automatically activates the session if needed.
// For SDK mode, uses the SDK client; for legacy mode, writes directly to stdin.
func (s *Session) SendInputUI(content string) error {
	if s.Mode != ModeUI {
		return fmt.Errorf("SendInputUI called on non-UI session")
	}

	// Ensure session is activated and ready
	if err := s.EnsureActivated(); err != nil {
		return fmt.Errorf("failed to activate session: %w", err)
	}

	// SDK mode: use SDK client
	if s.sdkClient != nil {
		return s.sdkClient.SendMessage(content)
	}

	// Legacy mode: write directly to stdin
	if s.Stdin == nil {
		return fmt.Errorf("session stdin not available")
	}

	// Format as JSON user message
	msg := fmt.Sprintf(`{"type":"user","message":{"role":"user","content":%q}}`, content)
	_, err := s.Stdin.Write([]byte(msg + "\n"))
	return err
}

// Interrupt sends an interrupt signal to stop the current operation (UI mode only).
// For SDK mode, uses the SDK client's interrupt mechanism.
func (s *Session) Interrupt() error {
	if s.Mode != ModeUI {
		return fmt.Errorf("Interrupt called on non-UI session")
	}

	if s.sdkClient == nil {
		return fmt.Errorf("Cannot interrupt: session not active (no running process)")
	}

	return s.sdkClient.Interrupt()
}

// SetModel changes the AI model during conversation (UI mode only).
// For SDK mode, uses the SDK client's SetModel mechanism.
func (s *Session) SetModel(model string) error {
	if s.Mode != ModeUI {
		return fmt.Errorf("SetModel called on non-UI session")
	}

	if s.sdkClient == nil {
		return fmt.Errorf("Cannot set model: session not active (no running process)")
	}

	return s.sdkClient.SetModel(model)
}

// SendToolResult sends a tool result back to Claude (UI mode only).
// This is used for interactive tools like AskUserQuestion that require user input.
// The toolUseID must match the id from the tool_use block.
func (s *Session) SendToolResult(toolUseID string, content string) error {
	if s.Mode != ModeUI {
		return fmt.Errorf("SendToolResult called on non-UI session")
	}

	if s.sdkClient == nil {
		return fmt.Errorf("Cannot send tool result: session not active (no running process)")
	}

	return s.sdkClient.SendToolResult(toolUseID, content)
}

// SetPermissionMode changes the permission mode during conversation (UI mode only).
// For SDK mode, uses the SDK client's SetPermissionMode mechanism.
//
// Valid modes:
//   - sdk.PermissionModeDefault: Standard permission behavior
//   - sdk.PermissionModeAcceptEdits: Auto-accept file edits
//   - sdk.PermissionModePlan: Planning mode (no tool execution)
//   - sdk.PermissionModeBypassPermissions: Allow all tools (use with caution)
func (s *Session) SetPermissionMode(mode sdk.PermissionMode) error {
	if s.Mode != ModeUI {
		return fmt.Errorf("SetPermissionMode called on non-UI session")
	}

	if s.sdkClient == nil {
		return fmt.Errorf("Cannot set permission mode: session not active (no running process)")
	}

	return s.sdkClient.SetPermissionMode(mode)
}

// SendControlResponse sends a response to a control request (UI mode only)
// For SDK mode, routes to pendingSDKPermissions channel.
// For legacy mode, writes directly to stdin.
// If alwaysAllow is true and behavior is "allow", the tool is remembered for auto-approval.
// The message parameter is required for "deny" behavior - it will be included in the tool_result error.
func (s *Session) SendControlResponse(requestID string, subtype string, behavior string, message string, toolName string, alwaysAllow bool) error {
	if s.Mode != ModeUI {
		return fmt.Errorf("SendControlResponse called on non-UI session")
	}

	// If "always allow" is requested and we're allowing, remember this tool
	if alwaysAllow && behavior == "allow" && toolName != "" {
		s.alwaysAllowedToolsMu.Lock()
		if s.alwaysAllowedTools == nil {
			s.alwaysAllowedTools = make(map[string]bool)
		}
		s.alwaysAllowedTools[toolName] = true
		s.alwaysAllowedToolsMu.Unlock()

		log.Info().
			Str("sessionId", s.ID).
			Str("toolName", toolName).
			Msg("tool added to always-allowed list")
	}

	// Check if this is an SDK permission request first
	s.pendingSDKPermissionsMu.RLock()
	pending, isSDKRequest := s.pendingSDKPermissions[requestID]
	s.pendingSDKPermissionsMu.RUnlock()

	if isSDKRequest && pending != nil {
		// Route to SDK permission callback
		log.Debug().
			Str("sessionId", s.ID).
			Str("requestId", requestID).
			Str("behavior", behavior).
			Bool("alwaysAllow", alwaysAllow).
			Msg("routing control response to SDK permission channel")

		select {
		case pending.ch <- PermissionResponse{Behavior: behavior, Message: message, ToolName: toolName, AlwaysAllow: alwaysAllow}:
			// Broadcast control_response to ALL clients so they can clear their permission UI
			// This handles the case where multiple tabs have the same session open
			responseMsg := fmt.Sprintf(`{"type":"control_response","request_id":%q,"behavior":%q}`,
				requestID, behavior)
			s.BroadcastUIMessage([]byte(responseMsg))

			// If "always allow" was selected, auto-approve other pending requests for the same tool
			if alwaysAllow && behavior == "allow" && toolName != "" {
				s.autoApprovePendingForTool(toolName, requestID)
			}

			return nil
		default:
			return fmt.Errorf("permission channel full or closed")
		}
	}

	// Legacy mode: write directly to stdin
	if s.Stdin == nil {
		return fmt.Errorf("session stdin not available")
	}

	// Format as control response JSON
	data := fmt.Sprintf(`{"type":"control_response","request_id":%q,"response":{"subtype":%q,"response":{"behavior":%q}}}`,
		requestID,
		subtype,
		behavior,
	)
	_, err := s.Stdin.Write([]byte(data + "\n"))
	return err
}

// autoApprovePendingForTool auto-approves all other pending permission requests for the same tool.
// Called when user clicks "Always allow" - this ensures already-pending requests for that tool
// are also approved without requiring additional user interaction.
func (s *Session) autoApprovePendingForTool(toolName string, excludeRequestID string) {
	s.pendingSDKPermissionsMu.RLock()
	// Collect matching requests (can't send while holding lock)
	var toApprove []*pendingPermission
	for reqID, pending := range s.pendingSDKPermissions {
		if reqID != excludeRequestID && pending.toolName == toolName {
			toApprove = append(toApprove, pending)
		}
	}
	s.pendingSDKPermissionsMu.RUnlock()

	// Auto-approve each matching request
	for _, pending := range toApprove {
		log.Info().
			Str("sessionId", s.ID).
			Str("requestId", pending.requestID).
			Str("toolName", toolName).
			Msg("auto-approving pending request due to 'always allow'")

		select {
		case pending.ch <- PermissionResponse{Behavior: "allow", ToolName: toolName, AlwaysAllow: true}:
			// Broadcast control_response so frontend clears the permission UI
			responseMsg := fmt.Sprintf(`{"type":"control_response","request_id":%q,"behavior":"allow"}`,
				pending.requestID)
			s.BroadcastUIMessage([]byte(responseMsg))
		default:
			log.Warn().
				Str("sessionId", s.ID).
				Str("requestId", pending.requestID).
				Msg("failed to auto-approve pending request (channel full or closed)")
		}
	}
}

// ResetMessageCache clears the message cache and reloads from JSONL.
// This should be called when the CLI restarts to ensure a fresh state.
// It clears any accumulated ephemeral messages (like init) that don't persist to JSONL.
func (s *Session) ResetMessageCache() {
	s.cacheMu.Lock()
	oldCount := len(s.cachedMessages)
	s.cachedMessages = nil
	s.seenUUIDs = make(map[string]bool)
	s.cacheLoaded = false
	s.cacheMu.Unlock()

	log.Debug().
		Str("sessionId", s.ID).
		Int("clearedMessages", oldCount).
		Msg("reset message cache before CLI activation")

	// Reload from JSONL
	s.LoadMessageCache()
}

// LoadMessageCache loads messages from JSONL file into cache (UI mode)
// Only loads once; subsequent calls are no-op
//
// IMPORTANT: Uses ReadSessionHistoryRaw to preserve all message fields.
// The SessionMessageI interface's MarshalJSON() returns raw bytes from the JSONL file,
// ensuring system message fields (subtype, compactMetadata, etc.) are not lost.
//
// NOTE: control_request and control_response messages are filtered out during load.
// These are ephemeral permission protocol messages that only matter during live sessions.
// control_request comes from Claude CLI stdout but control_response is only broadcast
// live (not stored in JSONL). Loading stale control_requests would show phantom
// permission dialogs for already-completed tool calls.
func (s *Session) LoadMessageCache() error {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()

	if s.cacheLoaded {
		return nil
	}

	// Initialize seenUUIDs map
	if s.seenUUIDs == nil {
		s.seenUUIDs = make(map[string]bool)
	}

	// Read from JSONL file using Raw reader to preserve all fields
	messages, err := ReadSessionHistoryRaw(s.ID, s.WorkingDir)
	if err != nil {
		// Not an error if file doesn't exist (new session)
		s.cacheLoaded = true
		return nil
	}

	// Convert to [][]byte and track UUIDs for deduplication
	for _, msg := range messages {
		// Skip control_request/control_response - these are ephemeral permission protocol
		// messages that only matter during live sessions. control_response is never stored
		// in JSONL (only broadcast live), so loading stale control_requests would show
		// phantom permission dialogs for already-completed tool calls.
		msgType := msg.GetType()
		if msgType == "control_request" || msgType == "control_response" {
			continue
		}

		if data, err := json.Marshal(msg); err == nil {
			s.cachedMessages = append(s.cachedMessages, data)

			// Extract and track UUID for deduplication
			uuid := msg.GetUUID()
			if uuid != "" {
				s.seenUUIDs[uuid] = true
			}
		}
	}

	s.cacheLoaded = true
	return nil
}

// GetCachedMessages returns a copy of all cached messages (UI mode)
func (s *Session) GetCachedMessages() [][]byte {
	s.cacheMu.RLock()
	defer s.cacheMu.RUnlock()

	result := make([][]byte, len(s.cachedMessages))
	for i, msg := range s.cachedMessages {
		msgCopy := make([]byte, len(msg))
		copy(msgCopy, msg)
		result[i] = msgCopy
	}
	return result
}

// BroadcastUIMessage handles a message from Claude stdout (UI mode)
// - Deduplicates by UUID (skip if already seen from JSONL)
// - Adds new messages to cache (including control messages for live sessions)
// - Broadcasts new messages to all connected clients
//
// NOTE: We merge JSONL messages with stdout messages, deduplicating by UUID.
// This handles the case where Claude's stdout may replay some messages that
// are already in the JSONL file.
//
// control_request and control_response ARE cached for live sessions.
// The frontend tracks them by request_id to determine pending vs resolved permissions.
// This allows new clients connecting mid-session to see pending permission dialogs.
// Note: LoadMessageCache() excludes control messages from JSONL because control_response
// isn't stored there, so we can't determine pending state from history alone.
func (s *Session) BroadcastUIMessage(data []byte) {
	var msgType struct {
		Type string `json:"type"`
		UUID string `json:"uuid"`
	}
	if err := json.Unmarshal(data, &msgType); err != nil {
		log.Warn().Err(err).Msg("failed to parse message type")
	}

	// Deduplicate by UUID (only for messages with UUIDs)
	// Note: control_request/control_response don't have UUIDs, so they're not deduplicated
	if msgType.UUID != "" {
		s.cacheMu.Lock()
		if s.seenUUIDs == nil {
			s.seenUUIDs = make(map[string]bool)
		}
		if s.seenUUIDs[msgType.UUID] {
			// Already seen this message, skip
			s.cacheMu.Unlock()
			log.Debug().Str("uuid", msgType.UUID).Str("sessionId", s.ID).Msg("skipping duplicate message")
			return
		}
		s.seenUUIDs[msgType.UUID] = true
		s.cacheMu.Unlock()
	}

	// Add to cache (all messages including control messages for live session state)
	s.cacheMu.Lock()
	msgCopy := make([]byte, len(data))
	copy(msgCopy, data)
	s.cachedMessages = append(s.cachedMessages, msgCopy)
	s.cacheMu.Unlock()

	// Broadcast to all connected clients
	s.mu.RLock()
	defer s.mu.RUnlock()
	for client := range s.Clients {
		select {
		case client.Send <- data:
		default:
			// Client's send buffer is full, skip
			log.Warn().Str("sessionId", s.ID).Msg("client send buffer full, skipping message")
		}
	}
}

// RegisterControlRequest registers a pending control request and returns a channel for the response
func (s *Session) RegisterControlRequest(requestID string) chan map[string]interface{} {
	s.pendingRequestsMu.Lock()
	defer s.pendingRequestsMu.Unlock()

	if s.pendingRequests == nil {
		s.pendingRequests = make(map[string]chan map[string]interface{})
	}

	ch := make(chan map[string]interface{}, 1)
	s.pendingRequests[requestID] = ch
	return ch
}

// ResolveControlRequest resolves a pending control request with a response
func (s *Session) ResolveControlRequest(requestID string, response map[string]interface{}) {
	s.pendingRequestsMu.Lock()
	ch, ok := s.pendingRequests[requestID]
	if ok {
		delete(s.pendingRequests, requestID)
	}
	s.pendingRequestsMu.Unlock()

	if ok && ch != nil {
		select {
		case ch <- response:
		default:
		}
		close(ch)
	}
}

// CreatePermissionCallback creates a CanUseTool callback for SDK mode.
// This bridges the SDK's synchronous permission callback with the async WebSocket flow:
// 1. SDK calls CanUseTool callback (blocks until we return)
// 2. Check if tool is in configured allowedTools list - if so, auto-allow
// 3. Check if tool is in session's always-allowed list (from "Always allow" clicks) - if so, auto-allow
// 4. Otherwise broadcast a control_request message to all WebSocket clients
// 5. Frontend shows permission UI
// 6. User allows/denies via WebSocket control_response
// 7. SendControlResponse routes to pendingSDKPermissions channel
// 8. This callback receives the response and returns to SDK
//
// NOTE: Why we check allowedTools here instead of relying on CLI's --allowedTools flag:
// When --permission-prompt-tool is set to "stdio", the CLI delegates ALL permission
// decisions to the external handler (this callback) via the control protocol.
// The CLI's --allowedTools flag is still passed for documentation and potential
// future use, but the actual permission decisions are made here in the SDK layer.
// This matches the behavior of the official Python Agent SDK.
func (s *Session) CreatePermissionCallback() sdk.CanUseToolFunc {
	return func(toolName string, input map[string]any, ctx sdk.ToolPermissionContext) (sdk.PermissionResult, error) {
		// Special handling for AskUserQuestion
		// This tool requires user interaction, so we handle it specially:
		// 1. Broadcast the questions to frontend
		// 2. Wait for user answers
		// 3. Return PermissionResultDeny with the answers in the message
		//    (The "deny" message becomes Claude's way of receiving the user's answers)
		if toolName == "AskUserQuestion" {
			return s.handleAskUserQuestion(input)
		}

		// Check if tool is in the configured allowedTools list
		// This handles both simple tool names and Bash patterns
		if isToolAllowed(toolName, input) {
			log.Debug().
				Str("sessionId", s.ID).
				Str("toolName", toolName).
				Msg("tool is in allowedTools list, auto-approving")
			return sdk.PermissionResultAllow{
				Behavior: sdk.PermissionAllow,
			}, nil
		}

		// Check if this tool is always allowed for this session
		// (set when user clicks "Always allow for session" in the UI)
		s.alwaysAllowedToolsMu.RLock()
		isAlwaysAllowed := s.alwaysAllowedTools != nil && s.alwaysAllowedTools[toolName]
		s.alwaysAllowedToolsMu.RUnlock()

		if isAlwaysAllowed {
			log.Debug().
				Str("sessionId", s.ID).
				Str("toolName", toolName).
				Msg("tool is session-always-allowed, auto-approving")
			return sdk.PermissionResultAllow{
				Behavior: sdk.PermissionAllow,
			}, nil
		}

		// Generate a unique request ID
		requestID := fmt.Sprintf("sdk-perm-%d", time.Now().UnixNano())

		// Create response channel and register it with tool name
		// (tool name is needed so "always allow" can auto-approve other pending requests)
		responseChan := make(chan PermissionResponse, 1)
		s.pendingSDKPermissionsMu.Lock()
		s.pendingSDKPermissions[requestID] = &pendingPermission{
			toolName:  toolName,
			requestID: requestID,
			ch:        responseChan,
		}
		s.pendingSDKPermissionsMu.Unlock()

		// Build control_request message matching Claude's format
		controlRequest := map[string]interface{}{
			"type":       "control_request",
			"request_id": requestID,
			"request": map[string]interface{}{
				"subtype":   "can_use_tool",
				"tool_name": toolName,
				"input":     input,
			},
		}

		// Serialize the request
		data, err := json.Marshal(controlRequest)
		if err != nil {
			log.Error().Err(err).Msg("failed to marshal control_request")
			return sdk.PermissionResultDeny{
				Behavior: sdk.PermissionDeny,
				Message:  "Internal error marshaling permission request",
			}, nil
		}

		// Clean up SDK permission channel on exit
		defer func() {
			s.pendingSDKPermissionsMu.Lock()
			delete(s.pendingSDKPermissions, requestID)
			s.pendingSDKPermissionsMu.Unlock()
		}()

		// Broadcast to WebSocket clients
		s.BroadcastUIMessage(data)

		log.Debug().
			Str("sessionId", s.ID).
			Str("requestId", requestID).
			Str("toolName", toolName).
			Msg("permission callback waiting for response")

		// Wait for response or session close
		select {
		case resp := <-responseChan:
			log.Debug().
				Str("sessionId", s.ID).
				Str("requestId", requestID).
				Str("behavior", resp.Behavior).
				Msg("permission callback received response")

			if resp.Behavior == "allow" {
				return sdk.PermissionResultAllow{
					Behavior: sdk.PermissionAllow,
				}, nil
			}
			// Ensure deny message is not empty (required by Anthropic API)
			denyMessage := resp.Message
			if denyMessage == "" {
				denyMessage = fmt.Sprintf("Permission denied by user for tool: %s", toolName)
			}
			return sdk.PermissionResultDeny{
				Behavior:  sdk.PermissionDeny,
				Message:   denyMessage,
				Interrupt: true,
			}, nil

		case <-s.sdkCtx.Done():
			log.Debug().
				Str("sessionId", s.ID).
				Str("requestId", requestID).
				Msg("permission callback cancelled (session closed)")
			return sdk.PermissionResultDeny{
				Behavior: sdk.PermissionDeny,
				Message:  "Session closed",
			}, nil
		}
	}
}

// handleAskUserQuestion handles the AskUserQuestion tool by broadcasting to the frontend
// and waiting for user input. This is called by the permission callback.
//
// Flow (per official SDK docs at platform.claude.com/docs/en/agent-sdk/user-input):
// 1. Extract questions from tool input
// 2. Generate a unique request ID
// 3. Broadcast question_request to frontend via WebSocket
// 4. Wait for user to answer (or skip)
// 5. Return PermissionResultAllow with updated_input containing both questions AND answers
//    (The tool executes with the modified input, Claude receives the answers)
func (s *Session) handleAskUserQuestion(input map[string]any) (sdk.PermissionResult, error) {
	// Generate unique request ID
	requestID := fmt.Sprintf("ask-user-%d", time.Now().UnixNano())

	// Create response channel
	responseChan := make(chan QuestionResponse, 1)

	// Register pending question
	s.pendingQuestionsMu.Lock()
	if s.pendingQuestions == nil {
		s.pendingQuestions = make(map[string]chan QuestionResponse)
	}
	s.pendingQuestions[requestID] = responseChan
	s.pendingQuestionsMu.Unlock()

	// Build question_request message for frontend
	questionRequest := map[string]interface{}{
		"type":       "question_request",
		"request_id": requestID,
		"questions":  input["questions"],
	}

	// Serialize and broadcast
	data, err := json.Marshal(questionRequest)
	if err != nil {
		log.Error().Err(err).Msg("failed to marshal question_request")
		return sdk.PermissionResultDeny{
			Behavior: sdk.PermissionDeny,
			Message:  "Failed to marshal question request",
		}, nil
	}

	// Clean up on exit
	defer func() {
		s.pendingQuestionsMu.Lock()
		delete(s.pendingQuestions, requestID)
		s.pendingQuestionsMu.Unlock()
	}()

	// Broadcast to WebSocket clients
	s.BroadcastUIMessage(data)

	log.Info().
		Str("sessionId", s.ID).
		Str("requestId", requestID).
		Msg("AskUserQuestion waiting for user response")

	// Wait for response or session close
	select {
	case resp := <-responseChan:
		log.Info().
			Str("sessionId", s.ID).
			Str("requestId", requestID).
			Bool("skipped", resp.Skipped).
			Msg("AskUserQuestion received user response")

		if resp.Skipped {
			// User skipped - deny the tool with a message
			return sdk.PermissionResultDeny{
				Behavior: sdk.PermissionDeny,
				Message:  "User skipped this question",
			}, nil
		}

		// Return Allow with updated input containing both questions and answers
		// Per SDK docs: the tool executes with the modified input
		updatedInput := map[string]any{
			"questions": input["questions"],
			"answers":   resp.Answers,
		}

		return sdk.PermissionResultAllow{
			Behavior:     sdk.PermissionAllow,
			UpdatedInput: updatedInput,
		}, nil

	case <-s.sdkCtx.Done():
		log.Debug().
			Str("sessionId", s.ID).
			Str("requestId", requestID).
			Msg("AskUserQuestion cancelled (session closed)")
		return sdk.PermissionResultDeny{
			Behavior: sdk.PermissionDeny,
			Message:  "Session closed",
		}, nil
	}
}

// SendQuestionResponse sends a user's response to an AskUserQuestion request.
// Called from the WebSocket handler when the frontend sends a question_response message.
func (s *Session) SendQuestionResponse(requestID string, answers map[string]interface{}, skipped bool) error {
	s.pendingQuestionsMu.RLock()
	respChan, ok := s.pendingQuestions[requestID]
	s.pendingQuestionsMu.RUnlock()

	if !ok || respChan == nil {
		return fmt.Errorf("no pending question with request_id: %s", requestID)
	}

	select {
	case respChan <- QuestionResponse{Answers: answers, Skipped: skipped}:
		log.Info().
			Str("sessionId", s.ID).
			Str("requestId", requestID).
			Bool("skipped", skipped).
			Msg("sent question response to handler")
		return nil
	default:
		return fmt.Errorf("question response channel full or closed")
	}
}

// GetGitInfo retrieves Git repository information for a given directory.
// Returns nil if the directory is not a Git repository.
func GetGitInfo(workingDir string) *GitInfo {
	// Check if this is a Git repository
	cmd := exec.Command("git", "rev-parse", "--git-dir")
	cmd.Dir = workingDir
	if err := cmd.Run(); err != nil {
		return nil
	}

	info := &GitInfo{IsRepo: true}

	// Get current branch
	cmd = exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
	cmd.Dir = workingDir
	if output, err := cmd.Output(); err == nil {
		info.Branch = strings.TrimSpace(string(output))
	}

	// Get remote URL (origin)
	cmd = exec.Command("git", "remote", "get-url", "origin")
	cmd.Dir = workingDir
	if output, err := cmd.Output(); err == nil {
		info.RemoteURL = strings.TrimSpace(string(output))
	}

	return info
}

