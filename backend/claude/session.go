package claude

import (
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Client represents a WebSocket connection to a session
type Client struct {
	Conn *websocket.Conn
	Send chan []byte
}

// Session represents a Claude Code CLI session
type Session struct {
	ID           string    `json:"id"`
	ProcessID    int       `json:"processId"`
	WorkingDir   string    `json:"workingDir"`
	CreatedAt    time.Time `json:"createdAt"`
	LastActivity time.Time `json:"lastActivity"`
	Status       string    `json:"status"` // "active", "disconnected", "dead"
	Title        string    `json:"title"`

	// Internal fields (not serialized)
	PTY     *os.File  `json:"-"`
	Cmd     *exec.Cmd `json:"-"`
	Clients map[*Client]bool `json:"-"`
	mu      sync.RWMutex `json:"-"`
	broadcast chan []byte `json:"-"`
}

// AddClient registers a new WebSocket client to this session
func (s *Session) AddClient(client *Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Clients[client] = true
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

// Broadcast sends data to all connected clients
func (s *Session) Broadcast(data []byte) {
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
		"clients":      len(s.Clients),
	}
}
