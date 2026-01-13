package claude

import (
	"os"
	"os/exec"
	"time"
)

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
	PTY *os.File  `json:"-"`
	Cmd *exec.Cmd `json:"-"`
}

// ToJSON returns a JSON-safe representation of the session
func (s *Session) ToJSON() map[string]interface{} {
	return map[string]interface{}{
		"id":           s.ID,
		"processId":    s.ProcessID,
		"workingDir":   s.WorkingDir,
		"createdAt":    s.CreatedAt,
		"lastActivity": s.LastActivity,
		"status":       s.Status,
		"title":        s.Title,
	}
}
