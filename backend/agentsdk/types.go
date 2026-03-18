// Package agentsdk provides a thin wrapper over ACP (Agent Client Protocol)
// for interacting with agent CLIs like Claude Code and Codex. It handles
// MyLifeDB-specific concerns (LLM proxy injection, session limits, credential
// management) while ACP handles the agent communication protocol.
package agentsdk

import (
	"context"
	"encoding/json"
	"time"
)

// AgentType identifies which agent CLI to use.
type AgentType string

const (
	AgentClaudeCode AgentType = "claude_code"
	AgentCodex      AgentType = "codex"
)

// PermissionMode controls how the agent handles tool approvals.
type PermissionMode string

const (
	PermissionAuto PermissionMode = "auto" // auto-accept all tool use
	PermissionAsk  PermissionMode = "ask"  // emit EventPermissionRequest, wait for approval
	PermissionDeny PermissionMode = "deny" // deny all tool use
)

// AgentConfig registers an agent binary with the client.
type AgentConfig struct {
	Type    AgentType
	Name    string   // display name: "Claude Code"
	Command string   // binary: "claude-agent-acp"
	Args    []string // default CLI args
}

// SessionConfig configures an interactive agent session.
type SessionConfig struct {
	Agent        AgentType
	Model        string
	SystemPrompt string
	Permissions  PermissionMode
	WorkingDir   string
	MaxTurns     int
	Env          map[string]string // extra env vars for the agent process
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
}

// EventType identifies the kind of streaming event.
type EventType string

const (
	EventDelta             EventType = "delta"              // partial text (from ACP SessionUpdate)
	EventMessage           EventType = "message"            // complete message (tool use, tool result)
	EventPermissionRequest EventType = "permission_request" // agent needs approval (from ACP RequestPermission)
	EventComplete          EventType = "complete"           // turn finished
	EventError             EventType = "error"              // error occurred
)

// PermissionRequest is emitted when the agent needs user approval.
type PermissionRequest struct {
	ID       string          // unique ID for this request
	Tool     string          // tool name
	Input    json.RawMessage // tool input
	FilePath string          // affected file, if applicable
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

// Block represents a piece of content within a message.
type Block struct {
	Type       BlockType
	Text       string          // for text blocks
	Language   string          // for code blocks
	ToolName   string          // for tool_use / tool_result blocks
	ToolInput  json.RawMessage // for tool_use blocks
	ToolOutput string          // for tool_result blocks
}

// BlockType identifies the kind of content block.
type BlockType string

const (
	BlockText       BlockType = "text"
	BlockCode       BlockType = "code"
	BlockToolUse    BlockType = "tool_use"
	BlockToolResult BlockType = "tool_result"
)

// AgentInfo describes an available agent.
type AgentInfo struct {
	Type    AgentType
	Name    string
	Version string
}

// Session represents an interactive agent conversation.
type Session interface {
	// Send a message and stream back the agent's response.
	// The returned channel is always closed after EventComplete or EventError.
	Send(ctx context.Context, prompt string) (<-chan Event, error)

	// RespondToPermission responds to an EventPermissionRequest.
	RespondToPermission(ctx context.Context, requestID string, allowed bool) error

	// Stop cancels the current operation (SIGINT). Agent stays alive.
	Stop() error

	// Close terminates the session and kills the agent process.
	Close() error

	// ID returns the session identifier.
	ID() string

	// AgentType returns which agent this session uses.
	AgentType() AgentType
}
