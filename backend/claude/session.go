package claude

import (
	"fmt"
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
	Status       string    `json:"status"` // "archived", "active", "dead"
	Title        string    `json:"title"`

	// Internal fields (not serialized)
	PTY        *os.File         `json:"-"`
	Cmd        *exec.Cmd        `json:"-"`
	Clients    map[*Client]bool `json:"-"`
	mu         sync.RWMutex     `json:"-"`
	broadcast  chan []byte      `json:"-"`
	backlog    []byte           `json:"-"` // Recent output for new clients
	backlogMu  sync.RWMutex     `json:"-"`

	// Lazy activation support
	activated  bool             `json:"-"` // Whether the Claude process has been spawned
	activateFn func() error     `json:"-"` // Function to activate this session
	ready      chan struct{}    `json:"-"` // Closed when Claude is ready to receive input
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

// EnsureActivated ensures the session is activated (Claude process is running)
// If not activated, it calls the activation function to spawn the process
func (s *Session) EnsureActivated() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.activated {
		return nil
	}

	fmt.Printf("[EnsureActivated] Session %s is being activated (stack trace below)\n", s.ID)
	// Print stack trace to see who called this
	// Uncomment if needed: debug.PrintStack()

	if s.activateFn == nil {
		return fmt.Errorf("session cannot be activated: no activation function")
	}

	fmt.Printf("[EnsureActivated] Calling activateFn for session %s\n", s.ID)
	if err := s.activateFn(); err != nil {
		return fmt.Errorf("failed to activate session: %w", err)
	}

	s.activated = true
	fmt.Printf("[EnsureActivated] Session %s successfully activated\n", s.ID)
	return nil
}

// IsActivated returns whether the session process is currently running
func (s *Session) IsActivated() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activated
}

// WaitUntilReady waits for the session to be ready to receive input
// Returns error if timeout is reached or session is not activated
func (s *Session) WaitUntilReady(timeout time.Duration) error {
	s.mu.RLock()
	readyChan := s.ready
	activated := s.activated
	s.mu.RUnlock()

	if !activated {
		return fmt.Errorf("session not activated")
	}

	if readyChan == nil {
		// Session was activated before the ready channel was added (legacy sessions)
		// Assume it's ready
		return nil
	}

	select {
	case <-readyChan:
		return nil
	case <-time.After(timeout):
		return fmt.Errorf("timeout waiting for session to be ready")
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
