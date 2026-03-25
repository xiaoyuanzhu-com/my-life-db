package agentsdk

import (
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// WSClient represents a connected WebSocket client for an agent session.
type WSClient struct {
	ID   string
	Send chan []byte // buffered 256
}

// SessionState manages the in-memory state for a single agent WebSocket session.
// It tracks connected clients and an append-only message buffer for replay on reconnect.
type SessionState struct {
	Mu           sync.RWMutex
	rawMessages  [][]byte
	clients      map[*WSClient]bool
	IsProcessing bool
	IsActive     bool // true after first prompt sent (vs replay-only)
	ResultCount  int
	HistoryOnce  sync.Once // ensures LoadSession runs at most once per session
}

// NewSessionState creates a new SessionState.
func NewSessionState() *SessionState {
	return &SessionState{
		clients: make(map[*WSClient]bool),
	}
}

// AppendAndBroadcast appends data to the message buffer and sends it to all connected clients.
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
		case c.Send <- data:
		default:
			log.Warn().Str("clientId", c.ID).Msg("dropping message: client send buffer full")
		}
	}
}

// BroadcastToClients sends data to all connected clients without storing it.
func (s *SessionState) BroadcastToClients(data []byte) {
	s.Mu.RLock()
	clients := make([]*WSClient, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.Mu.RUnlock()

	for _, c := range clients {
		select {
		case c.Send <- data:
		default:
			log.Warn().Str("clientId", c.ID).Msg("dropping broadcast: client send buffer full")
		}
	}
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
