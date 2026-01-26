package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// PermissionResponse represents a response to an SDK permission request
type PermissionResponse struct {
	Behavior string // "allow" or "deny"
	Message  string // Optional denial message
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
	Title        string      `json:"title"`
	Mode         SessionMode `json:"mode"` // "cli" or "ui"

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
	pendingSDKPermissions   map[string]chan PermissionResponse `json:"-"`
	pendingSDKPermissionsMu sync.RWMutex                       `json:"-"`
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

// ToJSON returns a JSON-safe representation of the session
func (s *Session) ToJSON() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return map[string]interface{}{
		"id":           s.ID,
		"processId":    s.ProcessID,
		"workingDir":   s.WorkingDir,
		"createdAt":    s.CreatedAt,
		"lastActivity": s.LastActivity,
		"status":       s.Status,
		"title":        s.Title,
		"mode":         s.Mode,
		"clients":      len(s.Clients),
	}
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
		return fmt.Errorf("Interrupt only supported in SDK mode")
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
		return fmt.Errorf("SetModel only supported in SDK mode")
	}

	return s.sdkClient.SetModel(model)
}

// SendControlResponse sends a response to a control request (UI mode only)
// For SDK mode, routes to pendingSDKPermissions channel.
// For legacy mode, writes directly to stdin.
func (s *Session) SendControlResponse(requestID string, subtype string, behavior string) error {
	if s.Mode != ModeUI {
		return fmt.Errorf("SendControlResponse called on non-UI session")
	}

	// Check if this is an SDK permission request first
	s.pendingSDKPermissionsMu.RLock()
	ch, isSDKRequest := s.pendingSDKPermissions[requestID]
	s.pendingSDKPermissionsMu.RUnlock()

	if isSDKRequest && ch != nil {
		// Route to SDK permission callback
		log.Debug().
			Str("sessionId", s.ID).
			Str("requestId", requestID).
			Str("behavior", behavior).
			Msg("routing control response to SDK permission channel")

		select {
		case ch <- PermissionResponse{Behavior: behavior}:
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

// LoadMessageCache loads messages from JSONL file into cache (UI mode)
// Only loads once; subsequent calls are no-op
//
// IMPORTANT: Uses ReadSessionHistoryRaw to preserve all message fields.
// The SessionMessageI interface's MarshalJSON() returns raw bytes from the JSONL file,
// ensuring system message fields (subtype, compactMetadata, etc.) are not lost.
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
// - Adds new messages to cache
// - Broadcasts new messages to all connected clients
//
// NOTE: We merge JSONL messages with stdout messages, deduplicating by UUID.
// This handles the case where Claude's stdout may replay some messages that
// are already in the JSONL file.
func (s *Session) BroadcastUIMessage(data []byte) {
	// Extract UUID for deduplication
	var msg struct {
		UUID string `json:"uuid"`
	}
	if err := json.Unmarshal(data, &msg); err == nil && msg.UUID != "" {
		s.cacheMu.Lock()
		if s.seenUUIDs == nil {
			s.seenUUIDs = make(map[string]bool)
		}
		if s.seenUUIDs[msg.UUID] {
			// Already seen this message, skip
			s.cacheMu.Unlock()
			log.Debug().Str("uuid", msg.UUID).Str("sessionId", s.ID).Msg("skipping duplicate message")
			return
		}
		s.seenUUIDs[msg.UUID] = true
		s.cacheMu.Unlock()
	}

	// Add to cache
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
// 2. We broadcast a control_request message to all WebSocket clients
// 3. Frontend shows permission modal
// 4. User allows/denies via WebSocket control_response
// 5. SendControlResponse routes to pendingSDKPermissions channel
// 6. This callback receives the response and returns to SDK
func (s *Session) CreatePermissionCallback() sdk.CanUseToolFunc {
	return func(toolName string, input map[string]any, ctx sdk.ToolPermissionContext) (sdk.PermissionResult, error) {
		// Generate a unique request ID
		requestID := fmt.Sprintf("sdk-perm-%d", time.Now().UnixNano())

		// Create response channel and register it
		responseChan := make(chan PermissionResponse, 1)
		s.pendingSDKPermissionsMu.Lock()
		if s.pendingSDKPermissions == nil {
			s.pendingSDKPermissions = make(map[string]chan PermissionResponse)
		}
		s.pendingSDKPermissions[requestID] = responseChan
		s.pendingSDKPermissionsMu.Unlock()

		// Clean up on exit
		defer func() {
			s.pendingSDKPermissionsMu.Lock()
			delete(s.pendingSDKPermissions, requestID)
			s.pendingSDKPermissionsMu.Unlock()
		}()

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

		// Broadcast to WebSocket clients
		data, err := json.Marshal(controlRequest)
		if err != nil {
			log.Error().Err(err).Msg("failed to marshal control_request")
			return sdk.PermissionResultDeny{
				Behavior: sdk.PermissionDeny,
				Message:  "Internal error marshaling permission request",
			}, nil
		}

		s.BroadcastUIMessage(data)

		log.Debug().
			Str("sessionId", s.ID).
			Str("requestId", requestID).
			Str("toolName", toolName).
			Msg("permission callback waiting for response")

		// Wait for response with timeout
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
			return sdk.PermissionResultDeny{
				Behavior: sdk.PermissionDeny,
				Message:  resp.Message,
			}, nil

		case <-time.After(5 * time.Minute):
			log.Warn().
				Str("sessionId", s.ID).
				Str("requestId", requestID).
				Msg("permission callback timed out")
			return sdk.PermissionResultDeny{
				Behavior: sdk.PermissionDeny,
				Message:  "Permission request timed out",
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
