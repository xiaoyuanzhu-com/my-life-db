package agentsdk

import (
	"sync"
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
	IsProcessing bool
	IsActive     bool // true after first prompt sent (vs replay-only)
	Killed       bool // set by session.kill — suppresses Send() goroutine cleanup
	ResultCount  int
	HistoryOnce  sync.Once // ensures LoadSession runs at most once per session
	HistoryError string    // non-empty if LoadSession failed (shared across connections)
}

// NewSessionState creates a new SessionState.
func NewSessionState() *SessionState {
	return &SessionState{
		clients: make(map[*WSClient]bool),
	}
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
