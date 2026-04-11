// Package agentsdk provides a thin wrapper over ACP (Agent Client Protocol)
// for interacting with agent CLIs like Claude Code and Codex. It handles
// MyLifeDB-specific concerns (LLM proxy injection, session limits, credential
// management) while ACP handles the agent communication protocol.
package agentsdk

import (
	"context"
	"encoding/json"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// AgentType identifies which agent CLI to use.
type AgentType string

const (
	AgentClaudeCode AgentType = "claude_code"
	AgentCodex      AgentType = "codex"
)

// AgentConfig registers an agent binary with the client.
type AgentConfig struct {
	Type    AgentType
	Name    string            // display name: "Claude Code"
	Command string            // binary: "claude-agent-acp"
	Args    []string          // default CLI args
	Env     map[string]string // agent-specific default env vars
	CleanEnv bool             // when true, do not inherit the full parent environment
}

// SessionConfig configures an interactive agent session.
type SessionConfig struct {
	Agent        AgentType
	Model        string
	SystemPrompt string
	Mode         string // ACP mode ID (e.g. "bypassPermissions", "plan"); empty = default
	WorkingDir   string
	MaxTurns     int
	Env          map[string]string // extra env vars for the agent process
	McpServers   []acp.McpServer   // MCP servers to provide to the agent via ACP
}

// TaskConfig configures a one-off agent task.
type TaskConfig struct {
	SessionConfig
	Prompt  string
	Timeout time.Duration
}

// TaskResult is the output of a completed task.
type TaskResult struct {
	SessionID string
	Messages  []Message
	Usage     Usage
	ExitCode  int
}

// Event represents a streaming event from the agent.
// Translated from ACP callbacks into a flat stream.
type Event struct {
	Type              EventType
	Delta             string             // for EventDelta: partial text token
	Message           *Message           // for EventMessage: complete message
	PermissionRequest *PermissionRequest // for EventPermissionRequest
	Usage             *Usage             // for EventComplete: token usage stats
	Error             error              // for EventError
	StopReason        string             // for EventComplete: why the turn ended
	SessionMeta       *SessionMeta       // for EventModeUpdate/EventCommandsUpdate/EventModelsUpdate
}

// SessionMeta carries session-level metadata updates.
type SessionMeta struct {
	ModeID          string
	AvailableModes  json.RawMessage
	ModelID         string
	AvailableModels json.RawMessage
	Commands        json.RawMessage
}

// EventType identifies the kind of streaming event.
type EventType string

const (
	EventDelta             EventType = "delta"              // partial text (from ACP SessionUpdate)
	EventMessage           EventType = "message"            // complete message (tool use, tool result)
	EventPermissionRequest EventType = "permission_request" // agent needs approval (from ACP RequestPermission)
	EventComplete          EventType = "complete"           // turn finished
	EventError             EventType = "error"              // error occurred
	EventModeUpdate        EventType = "mode_update"
	EventCommandsUpdate    EventType = "commands_update"
	EventModelsUpdate      EventType = "models_update"
)

// PermissionRequest is emitted when the agent needs user approval.
type PermissionRequest struct {
	ID       string             // unique ID (= ACP ToolCallId)
	Tool     string             // tool title (e.g., "Write /path/file.txt")
	ToolKind string             // tool kind (e.g., "execute", "edit", "read")
	Input    json.RawMessage    // raw tool input
	Options  []PermissionOption // available permission options
}

// PermissionOption describes one choice in a permission request.
type PermissionOption struct {
	ID   string // option ID (e.g., "allow_always", "allow", "reject")
	Kind string // option kind (e.g., "allow_always", "allow_once", "reject_once")
	Name string // display name (e.g., "Always Allow", "Allow", "Reject")
}

// Usage tracks token consumption for a turn or task.
type Usage struct {
	InputTokens  int
	OutputTokens int
}

// Message is the common message format across all agents.
type Message struct {
	Role    Role
	Content []Block
}

// Role identifies the message author.
type Role string

const (
	RoleAssistant Role = "assistant"
	RoleUser      Role = "user"
	RoleSystem    Role = "system"
)

// PlanEntry represents a single entry in an agent plan.
type PlanEntry struct {
	Content  string `json:"content"`
	Status   string `json:"status"`   // pending, in_progress, completed
	Priority string `json:"priority"` // high, medium, low
}

// Block represents a piece of content within a message.
type Block struct {
	Type        BlockType
	Text        string          // for text, thinking, plan blocks
	Language    string          // for code blocks
	ToolName    string          // for tool_use blocks: tool title
	ToolUseID   string          // for tool_use / tool_result blocks: links them
	ToolKind    string          // for tool_use blocks: "execute", "edit", "read", etc.
	ToolInput   json.RawMessage // for tool_use blocks: raw input JSON
	PlanEntries []PlanEntry     // for plan blocks: structured entries
}

// BlockType identifies the kind of content block.
type BlockType string

const (
	BlockText       BlockType = "text"
	BlockCode       BlockType = "code"
	BlockThinking   BlockType = "thinking"
	BlockToolUse    BlockType = "tool_use"
	BlockToolResult BlockType = "tool_result"
	BlockPlan       BlockType = "plan"
)

// AgentInfo describes an available agent.
type AgentInfo struct {
	Type    AgentType
	Name    string
	Version string
}

// Session represents an interactive agent conversation.
type Session interface {
	// Send a message and stream back raw JSON frames.
	// The returned channel is closed when the turn completes.
	Send(ctx context.Context, prompt string) (<-chan []byte, error)

	// LoadSession loads a historical session from the agent's persistence layer.
	// Frames are delivered via the onFrame handler as they arrive.
	LoadSession(ctx context.Context, sessionID string, cwd string) error

	// RespondToPermission responds to an EventPermissionRequest using an optionID.
	RespondToPermission(ctx context.Context, toolCallID string, optionID string) error

	// CancelAllPermissions cancels all pending permission requests.
	CancelAllPermissions()

	// SetMode changes the active mode for this session.
	SetMode(ctx context.Context, modeID string) error

	// SetModel changes the active model for this session.
	SetModel(ctx context.Context, modelID string) error

	// Stop cancels the current operation (SIGINT). Agent stays alive.
	Stop() error

	// SetOnFrame sets the permanent handler for all ACP frames.
	// Must be called before any Send()/LoadSession() calls.
	SetOnFrame(fn func([]byte))

	// Close terminates the session and kills the agent process.
	Close() error

	// Done returns a channel that closes when the agent process exits.
	// Used to detect process death and clean up in-memory state (e.g. IsProcessing).
	Done() <-chan struct{}

	// ID returns the session identifier.
	ID() string

	// AgentType returns which agent this session uses.
	AgentType() AgentType
}
