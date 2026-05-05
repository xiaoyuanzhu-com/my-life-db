# Unified Agent Interface Design

Date: 2026-03-17

## Overview

A thin Go wrapper over the **Agent Client Protocol (ACP)** for interacting with multiple agent CLIs (Claude Code, Codex, Gemini, etc.) through a single API. ACP standardizes the agent↔client communication; our wrapper adds MyLifeDB-specific concerns (LLM proxy injection, session limits, credential management).

## Why ACP

[Agent Client Protocol](https://agentclientprotocol.com) is an open standard (analogous to LSP for AI agents) that standardizes communication between clients and coding agents via JSON-RPC over stdio. Without it, N agents × M clients = N×M integrations. With it, N+M.

**Agents with ACP support:** Claude Code (via [claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)), Codex, Gemini CLI, Goose, Cline, and many more.

**Go SDK:** [coder/acp-go-sdk](https://github.com/coder/acp-go-sdk) — we use this as the ACP client implementation.

**Key benefit:** No custom output parsers per agent. ACP standardizes the message format, permission flow, file access, and terminal operations. Adding a new agent = installing its ACP binary + registering it.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Features / Business Logic                              │
│  ↕ uses                                                 │
├─────────────────────────────────────────────────────────┤
│  agent.Client (thin Go wrapper)                         │
│  - Manages lifecycle, session limits, env merging       │
│  - CreateSession, RunTask, Complete                     │
│  ↕ uses                                                 │
│  ACP ClientSideConnection (coder/acp-go-sdk)            │
│  - JSON-RPC over stdio                                  │
│  - Standardized permission, session, message protocol   │
│  ↕ spawns                                               │
│  ACP Agent Binaries                                     │
│  (claude-agent-acp, codex, gemini-cli, etc.)            │
├─────────────────────────────────────────────────────────┤
│  LLM Layer (credential proxy)                           │
└─────────────────────────────────────────────────────────┘
```

## Two Interaction Modes

| Mode | Use Case | Example |
|------|----------|---------|
| **Session** | Interactive, multi-turn, streaming | Chat page — user has a live conversation |
| **Task** | One-off, fire-and-forget or await result | Inbox processing, summarization |

Both modes spawn an ACP agent process. The difference is lifecycle: sessions are long-lived and resumable; tasks run to completion.

## Interface

```go
package agent

import (
    "context"
    "encoding/json"
    "time"

    acp "github.com/coder/acp-go-sdk"
)

// Client is the entry point for all agent interactions.
// It wraps ACP connections with MyLifeDB-specific concerns.
type Client struct {
    agents      map[AgentType]AgentConfig // registered agent binaries
    defaults    SessionConfig             // default env vars (LLM proxy URL, etc.)
    maxSessions int                       // max concurrent agent processes (default 5)
    proxyBaseURL string                   // LLM proxy base URL for Complete()
    proxyToken  string                    // shared secret for LLM proxy auth
}

// NewClient creates a Client with registered agents and default config.
func NewClient(defaults SessionConfig, agents ...AgentConfig) *Client

// SetMaxSessions sets the maximum number of concurrent agent processes.
// Exceeding the limit returns ErrTooManySessions. Default is 5.
func (c *Client) SetMaxSessions(n int)

// CreateSession starts an interactive, multi-turn agent session via ACP.
// Spawns the agent binary, establishes ACP connection, returns a Session handle.
func (c *Client) CreateSession(ctx context.Context, config SessionConfig) (Session, error)

// ResumeSession resumes an existing session by ID via ACP.
func (c *Client) ResumeSession(ctx context.Context, sessionID string, config SessionConfig) (Session, error)

// RunTask runs a one-off agent task to completion.
// Spawns the agent, sends the prompt, waits for completion, returns result.
func (c *Client) RunTask(ctx context.Context, config TaskConfig) (TaskResult, error)

// Complete sends a simple prompt to the LLM proxy directly (no agent).
// Provider selects which proxy route to use: "anthropic" or "openai".
// For non-agentic tasks like summarization and classification.
func (c *Client) Complete(ctx context.Context, provider string, prompt string, model string) (string, Usage, error)

// AvailableAgents returns metadata about all registered agents.
func (c *Client) AvailableAgents() []AgentInfo

// Shutdown terminates all active sessions gracefully.
// Sends Close() to all processes, waits for ctx deadline, then kills remaining.
func (c *Client) Shutdown(ctx context.Context) error
```

### Session

```go
// Session wraps an ACP ClientSideConnection with a higher-level API.
// Under the hood, it holds a running agent process and an ACP connection
// communicating via JSON-RPC over stdin/stdout.
type Session interface {
    // Send a message via ACP Prompt method and stream back events.
    // The returned channel is always closed after EventComplete or EventError.
    // Callers must drain the channel. Send must not be called concurrently —
    // agent CLIs are sequential; a second Send blocks until the first completes.
    //
    // Context cancellation: if ctx is cancelled mid-stream, the channel emits
    // EventError with ctx.Err() then closes. The process stays alive (use Stop/Close
    // to kill it). Callers MUST drain the channel or cancel the context — abandoning
    // an undrained channel leaks the reader goroutine.
    Send(ctx context.Context, prompt string) (<-chan Event, error)

    // RespondToPermission responds to an ACP RequestPermission callback.
    // The requestID must match PermissionRequest.ID.
    RespondToPermission(ctx context.Context, requestID string, allowed bool) error

    // Stop cancels the current operation (ACP Cancel method / SIGINT).
    // The agent stays alive and can receive further Send calls.
    Stop() error

    // Close terminates the session and releases all resources.
    // Sends SIGTERM, waits grace period, then SIGKILL.
    Close() error

    // Session metadata.
    ID() string
    AgentType() AgentType
}
```

### Events

Our `Event` type normalizes ACP callbacks (`SessionUpdate`, `RequestPermission`, etc.) into a single stream for the WebSocket layer to consume:

```go
// Event represents a streaming event from the agent.
// These are translated from ACP callbacks into a flat stream.
type Event struct {
    Type              EventType
    Delta             string             // for EventDelta: partial text token
    Message           *Message           // for EventMessage: complete message
    PermissionRequest *PermissionRequest // for EventPermissionRequest
    Usage             *Usage             // for EventComplete: token usage stats
    Error             error              // for EventError
}

type EventType string

const (
    EventDelta             EventType = "delta"              // partial text (from ACP SessionUpdate)
    EventMessage           EventType = "message"            // complete message (tool use, tool result, etc.)
    EventPermissionRequest EventType = "permission_request" // agent needs approval (from ACP RequestPermission)
    EventComplete          EventType = "complete"           // turn finished
    EventError             EventType = "error"              // error occurred
)

// PermissionRequest is emitted when the agent needs user approval.
// Translated from ACP's RequestPermission callback.
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
```

### Messages

```go
// Message is the common message format, translated from ACP message types.
type Message struct {
    Role    Role
    Content []Block
}

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

type BlockType string

const (
    BlockText       BlockType = "text"
    BlockCode       BlockType = "code"
    BlockToolUse    BlockType = "tool_use"
    BlockToolResult BlockType = "tool_result"
)
```

## Configuration

```go
// AgentConfig registers an agent binary with the client.
type AgentConfig struct {
    Type    AgentType
    Name    string   // display name: "Claude Code"
    Command string   // binary path or command: "claude-agent-acp"
    Args    []string // default CLI args
}

// SessionConfig configures an interactive agent session.
type SessionConfig struct {
    Agent        AgentType          // required: which agent to use
    Model        string             // optional: model override
    SystemPrompt string             // optional: prepended to conversation
    Permissions  PermissionMode     // optional: default is PermissionAsk
    WorkingDir   string             // optional: agent's working directory
    MaxTurns     int                // optional: limit agentic loop iterations (0 = unlimited)
    Env          map[string]string  // optional: extra env vars for the agent process
}

// TaskConfig configures a one-off agent task.
type TaskConfig struct {
    SessionConfig                  // embeds all session config
    Prompt        string           // required: the task prompt
    Timeout       time.Duration    // optional: max time for the task (0 = no timeout)
}

// TaskResult is the output of a completed task.
type TaskResult struct {
    SessionID string
    Messages  []Message
    Usage     Usage
    ExitCode  int
}

type AgentType string

const (
    AgentClaudeCode AgentType = "claude_code"
    AgentCodex      AgentType = "codex"
)

type PermissionMode string

const (
    PermissionAuto PermissionMode = "auto" // auto-accept all tool use
    PermissionAsk  PermissionMode = "ask"  // emit EventPermissionRequest, wait for approval (default)
    PermissionDeny PermissionMode = "deny" // deny all tool use
)

// AgentInfo describes an available agent (returned by AvailableAgents).
type AgentInfo struct {
    Type    AgentType
    Name    string // display name
    Version string // agent version (from ACP Initialize)
}
```

## How the Wrapper Uses ACP

The wrapper implements ACP's `Client` interface to receive callbacks from the agent, and translates them into our `Event` stream:

```go
// Internal: implements acp.Client interface
type acpClientImpl struct {
    events chan<- Event
}

// ACP calls this when the agent sends a message update
func (c *acpClientImpl) SessionUpdate(update acp.SessionUpdate) {
    // Translate ACP update → Event{Type: EventDelta or EventMessage}
    // Send to events channel
}

// ACP calls this when the agent needs permission
func (c *acpClientImpl) RequestPermission(req acp.PermissionRequest) (acp.PermissionResponse, error) {
    // Emit Event{Type: EventPermissionRequest}
    // Block until RespondToPermission is called
    // Return the response to ACP
}

// ACP calls this when the agent wants to read a file
func (c *acpClientImpl) ReadTextFile(path string) (string, error) {
    // Read file from the working directory
    return os.ReadFile(path)
}

// ACP calls this when the agent wants to write a file
func (c *acpClientImpl) WriteTextFile(path, content string) error {
    return os.WriteFile(path, []byte(content), 0644)
}

// ACP calls this when the agent wants a terminal
func (c *acpClientImpl) CreateTerminal(cmd string, args []string) (acp.Terminal, error) {
    // Spawn subprocess, return handle
}
```

### Session Lifecycle (under the hood)

```
CreateSession(config)
  │
  ├── 1. Merge default env with config.Env
  ├── 2. Spawn agent binary: exec.Command(agentConfig.Command, args...)
  │      Set env: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, MLD_PROXY_TOKEN, etc.
  ├── 3. Create ACP connection: acp.NewClientSideConnection(client, stdin, stdout)
  ├── 4. ACP Initialize handshake (negotiate capabilities)
  ├── 5. ACP NewSession
  └── 6. Return Session handle

session.Send(prompt)
  │
  ├── 1. Call ACP Prompt(prompt)
  ├── 2. ACP agent processes prompt, calls back:
  │      SessionUpdate → Event{EventDelta/EventMessage}
  │      RequestPermission → Event{EventPermissionRequest} → block for response
  │      ReadTextFile/WriteTextFile → handled transparently
  │      CreateTerminal → handled transparently
  └── 3. On completion → Event{EventComplete}

session.Close()
  │
  ├── 1. Send SIGTERM to agent process
  ├── 2. Wait grace period
  └── 3. SIGKILL if still alive
```

## LLM Configuration

The wrapper does not manage LLM credentials directly. It injects env vars when spawning agent processes:

```go
client := agent.NewClient(
    agent.SessionConfig{
        Env: map[string]string{
            "ANTHROPIC_BASE_URL": "http://localhost:8080/api/anthropic",
            "ANTHROPIC_API_KEY":  "dummy",
            "MLD_PROXY_TOKEN":    proxyToken,
        },
    },
    agent.AgentConfig{
        Type:    agent.AgentClaudeCode,
        Name:    "Claude Code",
        Command: "claude-agent-acp",
    },
)
```

The `Client` merges per-call `Env` with `defaults.Env` (per-call takes precedence). The application layer sets the LLM proxy URL once at startup.

## Agent Registration

Agents are registered as binary commands — no Go adapter code per agent:

```go
// Register Claude Code (via ACP bridge)
agent.AgentConfig{
    Type:    agent.AgentClaudeCode,
    Name:    "Claude Code",
    Command: "claude-agent-acp",  // npm install -g @zed-industries/claude-agent-acp
}

// Register Codex
agent.AgentConfig{
    Type:    agent.AgentCodex,
    Name:    "Codex",
    Command: "codex",  // npm install -g @openai/codex
    Args:    []string{"--acp"},
}

// Adding a new agent = install binary + register config. No Go code changes.
```

## Dependencies

- **Node.js** — Required runtime. Most agent ACP binaries are distributed via npm.
- **coder/acp-go-sdk** — Go library for the ACP client side.
- **Agent binaries** — Installed via npm at Docker build time:
  ```dockerfile
  RUN npm install -g @zed-industries/claude-agent-acp
  # Future: npm install -g @openai/codex, etc.
  ```

## Error Handling

```go
type AgentError struct {
    Type    ErrorType
    Agent   AgentType
    Message string
    Cause   error
}

func (e *AgentError) Error() string { return fmt.Sprintf("agent %s: %s: %s", e.Agent, e.Type, e.Message) }
func (e *AgentError) Unwrap() error { return e.Cause }

type ErrorType string

const (
    ErrQuotaExceeded   ErrorType = "quota_exceeded"    // 429 from LLM proxy
    ErrNoCredentials   ErrorType = "no_credentials"    // no API key configured at any level
    ErrTooManySessions ErrorType = "too_many_sessions" // concurrent session limit reached
    ErrAgentCrash      ErrorType = "agent_crash"       // CLI process died unexpectedly
    ErrTimeout         ErrorType = "timeout"           // task exceeded time limit
    ErrNotFound        ErrorType = "not_found"         // session not found for resume
)
```

**Process crash behavior:** When the agent process dies mid-session, the current `Send()` channel emits `EventError` with `ErrAgentCrash`. The session is no longer usable — the caller must create a new session or try `ResumeSession`. No automatic restart.

## What the Wrapper Handles (not ACP)

| Concern | Why not in ACP |
|---------|---------------|
| LLM proxy env injection | MyLifeDB-specific credential security model |
| Max session enforcement | Application-level resource management |
| `Complete()` direct LLM calls | No agent needed for simple completions |
| Default env merging | Application configuration concern |
| Session persistence to DB | Application storage concern |
| Graceful shutdown of all sessions | Application lifecycle concern |

## Non-Goals

- **Custom agent runtime** — We don't rebuild agentic loops. Agent CLIs + ACP are the runtime.
- **Multi-agent orchestration** — One agent per session/task. No chaining.
- **Provider abstraction** — The wrapper doesn't abstract LLM providers. That's the LLM layer's job.
- **ACP protocol extensions** — We use standard ACP. No custom JSON-RPC methods.
- **Custom per-agent parsers** — ACP standardizes the protocol. No adapter code per agent.
