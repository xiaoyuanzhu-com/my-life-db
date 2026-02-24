package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	Behavior     string         // "allow" or "deny"
	Message      string         // Optional denial message
	AlwaysAllow  bool           // If true, remember this tool as always allowed for the session
	ToolName     string         // Tool name (needed for always-allow tracking)
	UpdatedInput map[string]any // Updated tool input (used by AskUserQuestion to inject answers)
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
	LastActivity     time.Time `json:"lastActivity"`
	LastUserActivity time.Time `json:"lastUserActivity"`
	Status       string      `json:"status"` // "archived", "active", "dead"
	Title          string             `json:"title"`
	PermissionMode sdk.PermissionMode `json:"permissionMode"` // "default", "acceptEdits", "plan", "bypassPermissions"
	Git            *GitInfo           `json:"git"`            // Git repository metadata (nil if not a repo)

	// Internal fields (not serialized)
	Clients map[*Client]bool `json:"-"`
	mu      sync.RWMutex     `json:"-"`

	// Raw message list — the SINGLE SOURCE OF TRUTH for all session message data (D1).
	// Append-only (R1): messages are never reordered or mutated.
	// Populated from JSONL on first activation, then extended with stdout (deduped by UUID).
	//
	// ALL message reads, counts, and derived state for active sessions MUST come from
	// this list (or from fields derived from it, like resultCount below).
	// Do NOT read from JSONL files, JSONL cache (SessionEntry), or stdout directly.
	rawMessages [][]byte         `json:"-"`
	seenUUIDs   map[string]bool  `json:"-"` // Track seen message UUIDs for deduplication
	rawLoaded   bool             `json:"-"`
	rawMu       sync.RWMutex     `json:"-"`

	// Page model (§6) — partitions the raw message list into bounded pages.
	// A page seals when either the message count or byte size threshold is
	// reached (and no open stream is in progress).
	// All fields protected by rawMu.
	pageBreaks       []int `json:"-"` // Raw-list indices where each sealed page ends
	currentPageStart int   `json:"-"` // Raw-list index where current (open) page begins
	currentPageCount int   `json:"-"` // Non-closed-stream-event count in current page
	currentPageBytes int   `json:"-"` // Total byte size of messages in current page
	hasOpenStream    bool  `json:"-"` // True if stream_events exist without a following assistant

	// Pending control requests - maps request_id to response channel
	pendingRequests   map[string]chan map[string]interface{} `json:"-"`
	pendingRequestsMu sync.RWMutex                           `json:"-"`

	// Lazy activation support
	activated  bool          `json:"-"` // Whether the Claude process has been spawned
	activateFn func() error  `json:"-"` // Function to activate this session
	ready      chan struct{} `json:"-"` // Closed when Claude is ready to receive input

	// SDK-based session (replaces direct subprocess management)
	sdkClient  *sdk.ClaudeSDKClient `json:"-"`
	sdkCtx     context.Context      `json:"-"`
	sdkCancel  context.CancelFunc   `json:"-"`

	// Permission bridging for async WebSocket flow
	// When SDK's CanUseTool callback is invoked, it blocks waiting for a response.
	// We broadcast a control_request to WebSocket clients and wait for the response here.
	// The map stores tool name alongside the channel so "always allow" can auto-approve
	// other pending requests for the same tool.
	pendingSDKPermissions   map[string]*pendingPermission `json:"-"`
	pendingSDKPermissionsMu sync.RWMutex                  `json:"-"`

	// Always-allowed tools for this session
	// When user clicks "Always allow", the tool name is added here.
	// Future permission requests for the same tool auto-allow without prompting.
	alwaysAllowedTools   map[string]bool `json:"-"`
	alwaysAllowedToolsMu sync.RWMutex    `json:"-"`

	// Processing state — tracked by BroadcastUIMessage from the unified message stream.
	// init message → true (Claude started a turn), result message → false (turn complete).
	isProcessing   bool       `json:"-"`
	onStateChanged func()     `json:"-"` // Called when isProcessing/pendingPermissionCount changes; triggers SSE notification

	// Result count — total number of completed turns (historical + live).
	// Initialized from JSONL in LoadRawMessages(), then incremented by live stdout
	// results in BroadcastUIMessage(). This is the authoritative count for active
	// sessions — do NOT use SessionEntry.ResultCount (JSONL cache) instead, as it
	// lags behind due to fsnotify delay and will miss the "unread" state window.
	resultCount int `json:"-"`

	// Pending permission count — tracked by BroadcastUIMessage from control_request/control_response.
	// control_request → increment (waiting for user input), control_response → decrement (resolved).
	pendingPermissionCount int `json:"-"`

}

// AddClient registers a new WebSocket client to this session
func (s *Session) AddClient(client *Client) {
	s.mu.Lock()
	s.Clients[client] = true
	s.mu.Unlock()
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

	// Reset raw messages before starting new process.
	// This clears any accumulated ephemeral messages (like init) from previous runs
	// and reloads persisted history from JSONL.
	s.mu.Unlock() // Unlock before ResetRawMessages (it acquires rawMu)
	s.ResetRawMessages()
	s.mu.Lock()

	log.Info().
		Str("sessionId", s.ID).
		Str("workingDir", s.WorkingDir).
		Msg("activating session (starting new process)")

	if err := s.activateFn(); err != nil {
		s.mu.Unlock()
		return fmt.Errorf("failed to activate session: %w", err)
	}

	s.activated = true
	readyChan := s.ready
	s.mu.Unlock()

	// Wait for readiness
	if readyChan != nil {
		select {
		case <-readyChan:
		case <-time.After(5 * time.Second):
		}
	}

	return nil
}

// IsActivated returns whether the session process is currently running
func (s *Session) IsActivated() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activated
}

// IsProcessing returns whether Claude is actively generating (mid-turn).
func (s *Session) IsProcessing() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.isProcessing
}

// ResultCount returns the total number of completed turns (historical + live).
// This is the source of truth for active sessions. Do not re-derive from
// rawMessages iteration or from the JSONL cache (SessionEntry.ResultCount).
func (s *Session) ResultCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.resultCount
}

// HasPendingPermission returns whether the session is waiting for user permission input.
// Tracked via control_request/control_response messages in BroadcastUIMessage.
func (s *Session) HasPendingPermission() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.pendingPermissionCount > 0
}

// ClientCount returns the number of connected WebSocket clients.
func (s *Session) ClientCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.Clients)
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
		"workingDir":     s.WorkingDir,
		"createdAt":      s.CreatedAt,
		"lastActivity":     s.LastActivity,
		"lastUserActivity": s.LastUserActivity,
		"status":         "active", // Newly created/listed sessions are always active
		"title":          s.Title,
		"permissionMode": s.PermissionMode,
	}
	if s.Git != nil {
		result["git"] = s.Git
	}
	return result
}

// SendInputUI sends a user message to Claude via the SDK client.
// Automatically activates the session if needed.
func (s *Session) SendInputUI(content string) error {
	// Ensure session is activated and ready
	if err := s.EnsureActivated(); err != nil {
		return fmt.Errorf("failed to activate session: %w", err)
	}

	if s.sdkClient == nil {
		return fmt.Errorf("session not active (no SDK client)")
	}

	return s.sdkClient.SendMessage(content)
}

// Interrupt sends an interrupt signal to stop the current operation.
// Uses the SDK client's interrupt mechanism.
func (s *Session) Interrupt() error {
	if s.sdkClient == nil {
		return fmt.Errorf("Cannot interrupt: session not active (no running process)")
	}

	return s.sdkClient.Interrupt()
}

// SetModel changes the AI model during conversation.
// Uses the SDK client's SetModel mechanism.
func (s *Session) SetModel(model string) error {
	if s.sdkClient == nil {
		return fmt.Errorf("Cannot set model: session not active (no running process)")
	}

	return s.sdkClient.SetModel(model)
}

// SendToolResult sends a tool result back to Claude.
// This is used for interactive tools like AskUserQuestion that require user input.
// The toolUseID must match the id from the tool_use block.
func (s *Session) SendToolResult(toolUseID string, content string) error {
	if s.sdkClient == nil {
		return fmt.Errorf("Cannot send tool result: session not active (no running process)")
	}

	return s.sdkClient.SendToolResult(toolUseID, content)
}

// SetPermissionMode changes the permission mode during conversation.
// Uses the SDK client's SetPermissionMode mechanism.
//
// Valid modes:
//   - sdk.PermissionModeDefault: Standard permission behavior
//   - sdk.PermissionModeAcceptEdits: Auto-accept file edits
//   - sdk.PermissionModePlan: Planning mode (no tool execution)
//   - sdk.PermissionModeBypassPermissions: Allow all tools (use with caution)
func (s *Session) SetPermissionMode(mode sdk.PermissionMode) error {
	if s.sdkClient == nil {
		return fmt.Errorf("Cannot set permission mode: session not active (no running process)")
	}

	return s.sdkClient.SetPermissionMode(mode)
}

// SendControlResponse sends a response to a control request.
// For SDK mode, routes to pendingSDKPermissions channel.
// For legacy mode, writes directly to stdin.
// If alwaysAllow is true and behavior is "allow", the tool is remembered for auto-approval.
// The message parameter is required for "deny" behavior - it will be included in the tool_result error.
// The updatedInput parameter is used by AskUserQuestion to inject user answers into the tool input.
func (s *Session) SendControlResponse(requestID string, subtype string, behavior string, message string, toolName string, alwaysAllow bool, updatedInput map[string]any) error {
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
			Bool("hasUpdatedInput", updatedInput != nil).
			Msg("routing control response to SDK permission channel")

		select {
		case pending.ch <- PermissionResponse{Behavior: behavior, Message: message, ToolName: toolName, AlwaysAllow: alwaysAllow, UpdatedInput: updatedInput}:
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

	return fmt.Errorf("no pending SDK permission for request_id: %s", requestID)
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

// ResetRawMessages clears the raw message list and reloads from JSONL.
// This should be called when the process restarts to ensure a fresh state.
// It clears any accumulated ephemeral messages (like init) that don't persist to JSONL.
func (s *Session) ResetRawMessages() {
	s.rawMu.Lock()
	oldCount := len(s.rawMessages)
	s.rawMessages = nil
	s.seenUUIDs = make(map[string]bool)
	s.rawLoaded = false
	s.pageBreaks = nil
	s.currentPageStart = 0
	s.currentPageCount = 0
	s.currentPageBytes = 0
	s.hasOpenStream = false
	s.rawMu.Unlock()

	// Reset resultCount so LoadRawMessages() re-derives it from JSONL.
	s.mu.Lock()
	s.resultCount = 0
	s.mu.Unlock()

	log.Debug().
		Str("sessionId", s.ID).
		Int("clearedMessages", oldCount).
		Msg("reset raw messages before activation")

	// Reload from JSONL
	s.LoadRawMessages()
}

// LoadRawMessages loads messages from JSONL file into the raw message list.
// Only loads once; subsequent calls are no-op.
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
func (s *Session) LoadRawMessages() error {
	s.rawMu.Lock()
	defer s.rawMu.Unlock()

	if s.rawLoaded {
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
		s.rawLoaded = true
		return nil
	}

	// Convert to [][]byte and track UUIDs for deduplication
	loadedResultCount := 0
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
			s.rawMessages = append(s.rawMessages, data)

			// Extract and track UUID for deduplication
			uuid := msg.GetUUID()
			if uuid != "" {
				s.seenUUIDs[uuid] = true
			}

			// Count result messages so resultCount reflects total (historical + live).
			// Without this, resultCount only tracks live stdout results (from BroadcastUIMessage),
			// causing the session list to miss the "unread" state when a new result arrives
			// before fsnotify updates the JSONL cache.
			if msgType == "result" {
				loadedResultCount++
			}
		}
	}

	// Initialize resultCount from JSONL-loaded results so the session list can
	// correctly detect unread state even before fsnotify updates the JSONL cache.
	s.mu.Lock()
	s.resultCount = loadedResultCount
	s.mu.Unlock()

	// Derive page breaks from loaded messages (§6.5).
	// JSONL doesn't contain stream_events (ephemeral), so hasOpenStream is always
	// false during re-derivation — the algorithm reduces to sealing every 100 messages.
	s.derivePageBreaks()

	s.rawLoaded = true
	return nil
}

// GetRawMessages returns a copy of all raw messages
func (s *Session) GetRawMessages() [][]byte {
	s.rawMu.RLock()
	defer s.rawMu.RUnlock()

	result := make([][]byte, len(s.rawMessages))
	for i, msg := range s.rawMessages {
		msgCopy := make([]byte, len(msg))
		copy(msgCopy, msg)
		result[i] = msgCopy
	}
	return result
}

// DefaultPageSize is the message-count threshold per page for WebSocket pagination.
const DefaultPageSize = 500

// DefaultPageBytes is the byte-size threshold per page for WebSocket pagination.
// A page seals when either DefaultPageSize or DefaultPageBytes is reached.
const DefaultPageBytes = 500 * 1024 // 500 KB

// TotalPages returns the total number of pages (sealed + 1 open page).
// The open page always exists, even if empty.
func (s *Session) TotalPages() int {
	s.rawMu.RLock()
	defer s.rawMu.RUnlock()
	return len(s.pageBreaks) + 1
}

// GetPage returns the materialized messages for a given page number.
// Materialization excludes closed stream_events from ALL pages (§7.3).
// Active stream_events (trailing run with no following assistant) are kept
// on the open page for mid-stream reconnection recovery.
// Returns nil if the page number is out of range.
func (s *Session) GetPage(page int) (messages [][]byte, sealed bool) {
	s.rawMu.RLock()
	defer s.rawMu.RUnlock()

	totalPages := len(s.pageBreaks) + 1
	if page < 0 || page >= totalPages {
		return nil, false
	}

	// Determine raw-list slice for this page
	start := 0
	if page > 0 {
		start = s.pageBreaks[page-1]
	}
	end := len(s.rawMessages)
	if page < len(s.pageBreaks) {
		end = s.pageBreaks[page]
		sealed = true
	}

	messages = materializePageSlice(s.rawMessages[start:end], sealed)
	return messages, sealed
}

// GetPageRange returns materialized messages for a range of pages [fromPage, toPage).
// Used for the WS burst (last 2 pages).
func (s *Session) GetPageRange(fromPage, toPage int) [][]byte {
	s.rawMu.RLock()
	defer s.rawMu.RUnlock()

	totalPages := len(s.pageBreaks) + 1
	if fromPage < 0 {
		fromPage = 0
	}
	if toPage > totalPages {
		toPage = totalPages
	}

	var result [][]byte
	for page := fromPage; page < toPage; page++ {
		start := 0
		if page > 0 {
			start = s.pageBreaks[page-1]
		}
		end := len(s.rawMessages)
		sealed := false
		if page < len(s.pageBreaks) {
			end = s.pageBreaks[page]
			sealed = true
		}

		result = append(result, materializePageSlice(s.rawMessages[start:end], sealed)...)
	}
	return result
}

// materializePageSlice filters a raw page slice for serving.
// Excludes closed stream_events (those followed by an assistant message).
// Keeps active stream_events (trailing run with no assistant after them)
// on the open page for mid-stream reconnection recovery.
//
// For sealed pages, all streams are closed (seal requires !hasOpenStream),
// so ALL stream_events are excluded — the fast path skips the boundary scan.
//
// For the open page, we scan backward from the end to find the boundary:
// the trailing run of stream_events with no assistant after them is active.
// Everything before that boundary is filtered (closed stream_events excluded).
func materializePageSlice(slice [][]byte, sealed bool) [][]byte {
	if sealed {
		// Fast path: all stream_events are closed on sealed pages.
		var out [][]byte
		for _, msg := range slice {
			if !isStreamEvent(msg) {
				out = append(out, msg)
			}
		}
		return out
	}

	// Open page: find the boundary between closed and active stream_events.
	// Scan backward from the end. Active stream_events are a trailing run
	// of stream_events with no assistant (or any non-stream_event) after them.
	//
	// Example:
	//   [se, se, assistant, result, user, se, se, assistant, result, se, se]
	//                                                                ^--- activeFrom = 9
	//   Served: [assistant, result, user, assistant, result, se, se]
	activeFrom := len(slice) // index where active stream_events begin (= len means none)
	for i := len(slice) - 1; i >= 0; i-- {
		if isStreamEvent(slice[i]) {
			activeFrom = i
		} else {
			break
		}
	}

	var out [][]byte
	for i, msg := range slice {
		if i >= activeFrom {
			// Active stream_event — keep it
			out = append(out, msg)
		} else if !isStreamEvent(msg) {
			// Non-stream_event or closed stream_event — keep non-stream, skip stream
			out = append(out, msg)
		}
	}
	return out
}

// checkPageSeal checks if the current page should be sealed after an append.
// A page seals when either the message count or byte size threshold is reached,
// provided no stream is open.
// Must be called with rawMu held.
func (s *Session) checkPageSeal() {
	if (s.currentPageCount >= DefaultPageSize || s.currentPageBytes >= DefaultPageBytes) && !s.hasOpenStream {
		// Seal the current page
		s.pageBreaks = append(s.pageBreaks, len(s.rawMessages))
		s.currentPageStart = len(s.rawMessages)
		s.currentPageCount = 0
		s.currentPageBytes = 0
		// hasOpenStream is already false
	}
}

// derivePageBreaks re-derives page breaks by running the sealing algorithm
// over the full raw message list. Called on load from JSONL.
// Must be called with rawMu held.
func (s *Session) derivePageBreaks() {
	s.pageBreaks = nil
	s.currentPageStart = 0
	s.currentPageCount = 0
	s.currentPageBytes = 0
	s.hasOpenStream = false

	for i, msg := range s.rawMessages {
		msgType := fastMessageType(msg)
		switch msgType {
		case "stream_event":
			s.hasOpenStream = true
		case "assistant":
			s.hasOpenStream = false
			s.currentPageCount++
		default:
			s.currentPageCount++
		}
		s.currentPageBytes += len(msg)

		// Check seal after processing this message
		if (s.currentPageCount >= DefaultPageSize || s.currentPageBytes >= DefaultPageBytes) && !s.hasOpenStream {
			s.pageBreaks = append(s.pageBreaks, i+1)
			s.currentPageStart = i + 1
			s.currentPageCount = 0
			s.currentPageBytes = 0
		}
	}
}

// fastMessageType extracts the "type" field from raw JSON bytes.
// Uses fast byte scanning before falling back to JSON parsing.
func fastMessageType(data []byte) string {
	// Quick extraction: find "type":" and read the value
	prefix := data[:min(120, len(data))]

	// Try common types with fast byte check
	if bytes.Contains(prefix, []byte(`"stream_event"`)) {
		return "stream_event"
	}
	if bytes.Contains(prefix, []byte(`"assistant"`)) {
		// Confirm with JSON parse to avoid false positives
		var envelope struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &envelope) == nil {
			return envelope.Type
		}
	}

	// Fall back to JSON parse for other types
	var envelope struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &envelope) == nil {
		return envelope.Type
	}
	return ""
}

// BroadcastUIMessage handles a message from Claude stdout
// - Drops queue-operation and file-history-snapshot (never stored)
// - Deduplicates by UUID (skip if already seen from JSONL)
// - Appends new messages to rawMessages and updates page counters
// - Broadcasts new messages to all connected clients
//
// NOTE: We merge JSONL messages with stdout messages, deduplicating by UUID.
// This handles the case where Claude's stdout may replay some messages that
// are already in the JSONL file.
//
// Tool permission control_request/control_response (can_use_tool) ARE stored for live
// sessions. The frontend tracks them by request_id to determine pending vs resolved
// permissions, allowing new clients connecting mid-session to see pending permission
// dialogs. Note: LoadRawMessages() excludes control messages from JSONL because
// control_response isn't stored there, so we can't determine pending state from
// history alone.
//
// Ephemeral responses like set_permission_mode should use BroadcastToClients instead
// to avoid accumulation across reconnections.
func (s *Session) BroadcastUIMessage(data []byte) {
	var msgEnvelope struct {
		Type    string `json:"type"`
		UUID    string `json:"uuid"`
		Subtype string `json:"subtype"`
	}
	if err := json.Unmarshal(data, &msgEnvelope); err != nil {
		log.Warn().Err(err).Msg("failed to parse message type")
	}

	// Drop types that no consumer needs (§3.2). These never enter the raw list
	// and are never broadcast. This is an intentional optimisation — like large
	// content stripping — to keep the raw list lean.
	if msgEnvelope.Type == "queue-operation" || msgEnvelope.Type == "file-history-snapshot" {
		return
	}

	// Track processing state from the unified message stream.
	// init (system subtype) = turn started, result = turn complete.
	if msgEnvelope.Type == "system" && msgEnvelope.Subtype == "init" {
		s.mu.Lock()
		changed := !s.isProcessing
		s.isProcessing = true
		cb := s.onStateChanged
		s.mu.Unlock()
		if changed && cb != nil {
			cb()
		}
	} else if msgEnvelope.Type == "result" {
		s.mu.Lock()
		changed := s.isProcessing
		s.isProcessing = false
		s.resultCount++
		cb := s.onStateChanged
		s.mu.Unlock()
		if changed && cb != nil {
			cb()
		}
	}

	// Track pending permission count from control messages.
	// control_request = session is now waiting for user input (working → ready).
	// control_response = permission resolved, session resumes processing (ready → working).
	if msgEnvelope.Type == "control_request" {
		s.mu.Lock()
		s.pendingPermissionCount++
		cb := s.onStateChanged
		s.mu.Unlock()
		if cb != nil {
			cb()
		}
	} else if msgEnvelope.Type == "control_response" {
		s.mu.Lock()
		if s.pendingPermissionCount > 0 {
			s.pendingPermissionCount--
		}
		cb := s.onStateChanged
		s.mu.Unlock()
		if cb != nil {
			cb()
		}
	}

	msgType := msgEnvelope // keep variable name for the rest of the function

	// Deduplicate by UUID (only for messages with UUIDs)
	// Note: control_request/control_response don't have UUIDs, so they're not deduplicated
	if msgType.UUID != "" {
		s.rawMu.Lock()
		if s.seenUUIDs == nil {
			s.seenUUIDs = make(map[string]bool)
		}
		if s.seenUUIDs[msgType.UUID] {
			// Already seen this message, skip
			s.rawMu.Unlock()
			log.Debug().Str("uuid", msgType.UUID).Str("sessionId", s.ID).Msg("skipping duplicate message")
			return
		}
		s.seenUUIDs[msgType.UUID] = true
		s.rawMu.Unlock()
	}

	// Strip large Read tool content before storing and broadcasting
	data = StripReadToolContent(data)

	// Append to raw list (R1: append-only, never mutated).
	// Stream event eviction is handled at the view/materialization layer (§7.3),
	// not by modifying the raw list.
	s.rawMu.Lock()
	msgCopy := make([]byte, len(data))
	copy(msgCopy, data)
	s.rawMessages = append(s.rawMessages, msgCopy)

	// Update page counters and check seal (§6.2, §6.5).
	switch msgEnvelope.Type {
	case "stream_event":
		s.hasOpenStream = true
		// stream_events don't count toward seal threshold
	case "assistant":
		s.hasOpenStream = false
		s.currentPageCount++
	default:
		s.currentPageCount++
	}
	s.currentPageBytes += len(msgCopy)
	s.checkPageSeal()
	s.rawMu.Unlock()

	// Broadcast to all connected clients
	s.BroadcastToClients(data)
}

// BroadcastToClients sends a message to all connected WebSocket clients
// without adding it to rawMessages. Use this for ephemeral messages
// (e.g. set_permission_mode confirmations) that should not be replayed to
// reconnecting clients.
func (s *Session) BroadcastToClients(data []byte) {
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

// isStreamEvent checks if a raw JSON message is a stream_event type.
// Uses a lightweight prefix check before falling back to JSON parsing.
func isStreamEvent(data []byte) bool {
	// Quick check: stream_event messages contain "stream_event" near the start
	// This avoids JSON parsing for the vast majority of messages
	if len(data) < 30 || !bytes.Contains(data[:min(100, len(data))], []byte(`"stream_event"`)) {
		return false
	}
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return false
	}
	return envelope.Type == "stream_event"
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
		// NOTE: AskUserQuestion is handled through the standard permission flow.
		// The frontend detects tool_name="AskUserQuestion" in control_request and shows
		// the question UI instead of the permission UI. The response includes updated_input
		// with the user's answers.

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
				Bool("hasUpdatedInput", resp.UpdatedInput != nil).
				Msg("permission callback received response")

			if resp.Behavior == "allow" {
				result := sdk.PermissionResultAllow{
					Behavior: sdk.PermissionAllow,
				}
				// If UpdatedInput is provided (e.g., from AskUserQuestion with user answers),
				// include it in the result so Claude receives the modified input
				if resp.UpdatedInput != nil {
					result.UpdatedInput = resp.UpdatedInput
				}
				return result, nil
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
