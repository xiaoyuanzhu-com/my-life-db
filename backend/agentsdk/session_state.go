package agentsdk

import (
	"context"
	"sync"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// WSClient represents a connected WebSocket client for an agent session.
// Each client maintains a cursor into the shared rawMessages slice and
// a notification channel to wake its write loop when new data arrives.
type WSClient struct {
	ID     string
	Notify chan struct{} // 1-buffered wake-up signal
	cursor int          // index into rawMessages; managed by Drain
}

// NewWSClient creates a WSClient with its cursor set to start.
// Pass start=0 to replay from the beginning, or len(rawMessages) to skip history.
func NewWSClient(id string, start int) *WSClient {
	return &WSClient{
		ID:     id,
		Notify: make(chan struct{}, 1),
		cursor: start,
	}
}

// SessionState manages the in-memory state for a single agent WebSocket session.
// It tracks connected clients and an append-only message buffer for replay on reconnect.
type SessionState struct {
	Mu           sync.RWMutex
	rawMessages  [][]byte
	clients      map[*WSClient]bool
	isProcessing bool
	IsActive     bool // true after first prompt sent (vs replay-only)
	Killed       bool // set by session.kill — suppresses Send() goroutine cleanup
	ResultCount  int
	HistoryOnce  sync.Once // ensures LoadSession runs at most once per session
	HistoryError string    // non-empty if LoadSession failed (shared across connections)

	// Shared prompt tracking — prevents concurrent Prompt() calls across
	// REST and WS goroutines on the same session.
	PromptDone   chan struct{}       // closed when current prompt goroutine exits
	PromptCancel context.CancelFunc // cancels the current prompt's context

	// Stuck-prompt watchdog: updated by onFrame, read by watchdog goroutine.
	LastFrameAt time.Time  // last time an ACP frame arrived via onFrame
	sessionID   string     // for logging
}

// NewSessionState creates a new SessionState.
func NewSessionState(sessionID string) *SessionState {
	return &SessionState{
		clients:   make(map[*WSClient]bool),
		sessionID: sessionID,
	}
}

// SetProcessing updates isProcessing with transition logging.
// source identifies the caller (e.g., "ws-prompt", "rest-prompt", "ws-kill").
// Caller must hold Mu.Lock().
func (s *SessionState) SetProcessing(val bool, source string) {
	old := s.isProcessing
	s.isProcessing = val
	if old != val {
		log.Info().
			Str("sessionId", s.sessionID).
			Bool("isProcessing", val).
			Str("source", source).
			Msg("IsProcessing transition")
	}
}

// IsProcessing returns the current processing state. Caller must hold Mu.RLock() or Mu.Lock().
func (s *SessionState) IsProcessing() bool {
	return s.isProcessing
}

// TouchFrame updates LastFrameAt to now. Called when an ACP frame arrives.
// Caller must hold Mu.Lock().
func (s *SessionState) TouchFrame() {
	s.LastFrameAt = time.Now()
}

// WaitForPrompt waits for any in-flight prompt goroutine to finish.
// If there's no active prompt, returns immediately.
// Cancels the old prompt's context first to unblock it.
func (s *SessionState) WaitForPrompt() {
	s.Mu.Lock()
	cancel := s.PromptCancel
	done := s.PromptDone
	s.Mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

// RegisterPrompt stores the done channel and cancel func for the current prompt.
// Caller must hold Mu.Lock().
func (s *SessionState) RegisterPrompt(done chan struct{}, cancel context.CancelFunc) {
	s.PromptDone = done
	s.PromptCancel = cancel
}

// ClearPrompt clears the prompt tracking fields. Caller must hold Mu.Lock().
func (s *SessionState) ClearPrompt() {
	s.PromptDone = nil
	s.PromptCancel = nil
}

// AppendAndBroadcast appends data to the message buffer and notifies all connected clients.
func (s *SessionState) AppendAndBroadcast(data []byte) {
	s.Mu.Lock()
	s.rawMessages = append(s.rawMessages, data)
	clients := make([]*WSClient, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.Mu.Unlock()

	for _, c := range clients {
		select {
		case c.Notify <- struct{}{}:
		default: // already notified, write loop will catch up
		}
	}
}

// BroadcastToClients sends data to all connected clients without storing it.
// Used for ephemeral frames (e.g. session.cancelled ack) that don't need replay.
func (s *SessionState) BroadcastToClients(data []byte) {
	s.Mu.Lock()
	// Store as a regular message so cursor-based clients pick it up.
	s.rawMessages = append(s.rawMessages, data)
	clients := make([]*WSClient, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.Mu.Unlock()

	for _, c := range clients {
		select {
		case c.Notify <- struct{}{}:
		default:
		}
	}
}

// Drain returns all messages from the client's cursor to the current end of the buffer,
// advancing the cursor. Returns nil if there are no new messages.
func (s *SessionState) Drain(c *WSClient) [][]byte {
	s.Mu.RLock()
	total := len(s.rawMessages)
	if c.cursor >= total {
		s.Mu.RUnlock()
		return nil
	}
	msgs := make([][]byte, total-c.cursor)
	copy(msgs, s.rawMessages[c.cursor:total])
	s.Mu.RUnlock()

	c.cursor = total
	return msgs
}

// MessageCount returns the current number of stored messages.
func (s *SessionState) MessageCount() int {
	s.Mu.RLock()
	defer s.Mu.RUnlock()
	return len(s.rawMessages)
}

// AddClient registers a WebSocket client.
func (s *SessionState) AddClient(c *WSClient) {
	s.Mu.Lock()
	s.clients[c] = true
	s.Mu.Unlock()
}

// RemoveClient unregisters a WebSocket client.
func (s *SessionState) RemoveClient(c *WSClient) {
	s.Mu.Lock()
	delete(s.clients, c)
	s.Mu.Unlock()
}

// GetRecentMessages returns the last n messages from the buffer.
// If n <= 0 or n > len(rawMessages), returns all messages.
func (s *SessionState) GetRecentMessages(n int) [][]byte {
	s.Mu.RLock()
	defer s.Mu.RUnlock()

	total := len(s.rawMessages)
	if n <= 0 || n > total {
		result := make([][]byte, total)
		copy(result, s.rawMessages)
		return result
	}

	start := total - n
	result := make([][]byte, n)
	copy(result, s.rawMessages[start:])
	return result
}

// GetMessagePage returns a page of messages from the buffer.
// page is 0-indexed, pageSize is the number of messages per page.
// Returns messages in chronological order.
func (s *SessionState) GetMessagePage(page, pageSize int) [][]byte {
	s.Mu.RLock()
	defer s.Mu.RUnlock()

	total := len(s.rawMessages)
	if pageSize <= 0 {
		pageSize = 100
	}

	start := page * pageSize
	if start >= total {
		return nil
	}

	end := start + pageSize
	if end > total {
		end = total
	}

	result := make([][]byte, end-start)
	copy(result, s.rawMessages[start:end])
	return result
}
