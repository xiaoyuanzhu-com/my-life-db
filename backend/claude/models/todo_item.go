package models

// TodoItem represents a task in a Claude Code session
type TodoItem struct {
	Content    string `json:"content"`
	Status     string `json:"status"`     // "pending", "in_progress", "completed"
	ActiveForm string `json:"activeForm"` // Present continuous form (e.g., "Running tests")
}
