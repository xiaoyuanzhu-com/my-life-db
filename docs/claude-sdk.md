# Claude SDK for Go

A Go SDK for interacting with Claude Code CLI, mirroring the architecture of the official [Python Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python).

## Location

```
backend/claude/sdk/
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ClaudeSDKClient                          │
│  High-level bidirectional client                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                      Query                           │   │
│  │  Control protocol handler                            │   │
│  │  ┌─────────────────────────────────────────────┐    │   │
│  │  │        SubprocessCLITransport               │    │   │
│  │  │  Process lifecycle & I/O management         │    │   │
│  │  └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Layers

| Layer | File | Purpose |
|-------|------|---------|
| **Client** | `client.go` | High-level API: Connect, SendMessage, Interrupt, SetModel |
| **Query** | `query.go` | Control protocol: Initialize, permission callbacks, hooks |
| **Transport** | `transport/subprocess.go` | Subprocess management, stdin/stdout/stderr handling |

## Quick Start

### One-shot Query

```go
import "github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"

messages, errors := sdk.QueryOnce(ctx, "What is 2+2?", sdk.ClaudeAgentOptions{})

for msg := range messages {
    if am, ok := msg.(sdk.AssistantMessage); ok {
        fmt.Println(sdk.GetTextContent(am))
    }
}
```

### Interactive Conversation

```go
client := sdk.NewClaudeSDKClient(sdk.ClaudeAgentOptions{
    AllowedTools: []string{"Read", "Glob", "Grep"},
    Cwd:          "/path/to/project",
})

if err := client.Connect(ctx, "What files are here?"); err != nil {
    log.Fatal(err)
}
defer client.Close()

for msg := range client.Messages() {
    switch m := msg.(type) {
    case sdk.AssistantMessage:
        fmt.Println(sdk.GetTextContent(m))
    case sdk.ResultMessage:
        fmt.Printf("Cost: %s\n", sdk.FormatCost(m.TotalCostUSD))
        return
    }
}
```

## Features

### Permission Handling

#### How Tool Permission Flow Works

When Claude wants to use a tool that's not in `AllowedTools`, a permission decision is required. The SDK supports this via the `CanUseTool` callback and the `--permission-prompt-tool` CLI flag.

**The Flow:**

```
┌─────────────┐     tool_use      ┌─────────────┐
│   Claude    │ ─────────────────>│  Claude CLI │
│   (API)     │                   │             │
└─────────────┘                   └──────┬──────┘
                                         │
                                         │ control_request
                                         │ (subtype: can_use_tool)
                                         ▼
                                  ┌─────────────┐
                                  │   Go SDK    │
                                  │   Query     │
                                  └──────┬──────┘
                                         │
                                         │ CanUseTool callback
                                         ▼
                                  ┌─────────────┐
                                  │  Your App   │
                                  │  (approve?) │
                                  └──────┬──────┘
                                         │
                                         │ PermissionResultAllow/Deny
                                         ▼
                                  ┌─────────────┐
                                  │   Go SDK    │ ─── control_response ───> CLI
                                  └─────────────┘
```

**Key Mechanism: `--permission-prompt-tool stdio`**

When `CanUseTool` callback is provided, the SDK automatically adds `--permission-prompt-tool stdio` to the CLI arguments. This flag tells the CLI to:
1. Send `control_request` messages (type: `can_use_tool`) via stdout instead of prompting interactively
2. Wait for `control_response` messages via stdin with the permission decision

This enables programmatic permission handling in non-interactive environments (web UIs, automated systems, etc.).

#### Basic Permission Callback

```go
client := sdk.NewClaudeSDKClient(sdk.ClaudeAgentOptions{
    CanUseTool: func(tool string, input map[string]any, ctx sdk.ToolPermissionContext) (sdk.PermissionResult, error) {
        // Auto-approve read-only tools
        if tool == "Read" || tool == "Glob" {
            return sdk.PermissionResultAllow{Behavior: sdk.PermissionAllow}, nil
        }

        // Deny dangerous commands
        if tool == "Bash" {
            if cmd, _ := input["command"].(string); strings.Contains(cmd, "rm -rf") {
                return sdk.PermissionResultDeny{
                    Behavior: sdk.PermissionDeny,
                    Message:  "Dangerous command not allowed",
                }, nil
            }
        }

        return sdk.PermissionResultAllow{Behavior: sdk.PermissionAllow}, nil
    },
})
```

#### WebSocket-based Approval (Web UI)

For web applications that need user confirmation via UI, see the implementation in `backend/claude/session.go`:

```go
// CreatePermissionCallback bridges SDK's synchronous callback with async WebSocket flow
func (s *Session) CreatePermissionCallback() sdk.CanUseToolFunc {
    return func(toolName string, input map[string]any, ctx sdk.ToolPermissionContext) (sdk.PermissionResult, error) {
        // 1. Generate unique request ID for tracking
        requestID := fmt.Sprintf("sdk-perm-%d", time.Now().UnixNano())

        // 2. Create channel to receive WebSocket response
        responseChan := make(chan PermissionResponse, 1)
        s.pendingSDKPermissions[requestID] = responseChan

        // 3. Broadcast control_request to WebSocket clients (frontend shows modal)
        controlRequest := map[string]interface{}{
            "type":       "control_request",
            "request_id": requestID,
            "request": map[string]interface{}{
                "subtype":   "can_use_tool",
                "tool_name": toolName,
                "input":     input,
            },
        }
        s.BroadcastUIMessage(json.Marshal(controlRequest))

        // 4. Block until user responds via WebSocket
        select {
        case resp := <-responseChan:
            if resp.Behavior == "allow" {
                return sdk.PermissionResultAllow{Behavior: sdk.PermissionAllow}, nil
            }
            return sdk.PermissionResultDeny{Behavior: sdk.PermissionDeny, Message: resp.Message}, nil
        case <-time.After(5 * time.Minute):
            return sdk.PermissionResultDeny{Message: "Permission request timed out"}, nil
        }
    }
}
```

#### Control Request/Response Format

**Control Request (from CLI):**
```json
{
  "type": "control_request",
  "request_id": "44fea74b-d2ad-4c51-804d-5588b01af756",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "WebFetch",
    "input": {"url": "https://example.com", "prompt": "..."},
    "tool_use_id": "toolu_01VJkFn7jEpDrMc62HpaWMCh",
    "permission_suggestions": [...]
  }
}
```

**Control Response (to CLI):**
```json
{
  "type": "control_response",
  "response": {
    "request_id": "44fea74b-d2ad-4c51-804d-5588b01af756",
    "subtype": "success",
    "response": {
      "behavior": "allow",
      "updatedInput": {...}
    }
  }
}
```

#### Permission Result Types

| Type | Fields | Description |
|------|--------|-------------|
| `PermissionResultAllow` | `Behavior`, `UpdatedInput`, `UpdatedPermissions` | Allow tool execution, optionally modify input |
| `PermissionResultDeny` | `Behavior`, `Message`, `Interrupt` | Deny with reason, optionally interrupt session |

### Hook System

Intercept and modify tool usage:

```go
hooks := sdk.NewHookManager()

// Log all tool usage
hooks.Register(sdk.HookPreToolUse, "*", func(input sdk.HookInput, toolUseID *string, ctx sdk.HookContext) (sdk.HookOutput, error) {
    if hi, ok := input.(sdk.PreToolUseHookInput); ok {
        log.Printf("[AUDIT] Tool: %s", hi.ToolName)
    }
    return sdk.PreToolUseAllow(), nil
})

// Validate bash commands
hooks.Register(sdk.HookPreToolUse, "Bash", sdk.ValidationHook(func(tool string, input map[string]any) (bool, string) {
    cmd, _ := input["command"].(string)
    if strings.Contains(cmd, "sudo") {
        return false, "sudo not allowed"
    }
    return true, ""
}))

client := sdk.NewClaudeSDKClient(sdk.ClaudeAgentOptions{
    Hooks: hooks.ToOptionsMap(),
})
```

#### Pre-built Hook Helpers

| Helper | Purpose |
|--------|---------|
| `PreToolUseAllow()` | Allow tool execution |
| `PreToolUseDeny(reason)` | Deny with reason |
| `PreToolUseModify(input)` | Allow with modified input |
| `ValidationHook(fn)` | Create validation hook |
| `LoggingHook(fn)` | Create logging hook |
| `DenyToolsHook(tools...)` | Deny specific tools |
| `AllowToolsHook(tools...)` | Only allow specific tools |

### Control Protocol

Mid-session control:

```go
// Interrupt current operation
client.Interrupt()

// Change permission mode
client.SetPermissionMode(sdk.PermissionModeAcceptEdits)

// Switch model
client.SetModel("claude-opus-4-5")

// Rewind files (requires EnableFileCheckpointing)
client.RewindFiles(userMessageID)
```

## Message Types

| Type | Description |
|------|-------------|
| `UserMessage` | User input |
| `AssistantMessage` | Claude's response with content blocks |
| `SystemMessage` | Internal system events |
| `ResultMessage` | Final result with cost/usage |
| `StreamEvent` | Partial updates during streaming |

### Content Blocks

| Block | Description |
|-------|-------------|
| `TextBlock` | Plain text |
| `ThinkingBlock` | Claude's reasoning |
| `ToolUseBlock` | Tool invocation |
| `ToolResultBlock` | Tool execution result |

### Helper Functions

```go
// Extract text from assistant message
text := sdk.GetTextContent(assistantMsg)

// Get all tool uses
tools := sdk.GetToolUses(assistantMsg)

// Check if result
if sdk.IsResultMessage(msg) { ... }

// Format cost
cost := sdk.FormatCost(resultMsg.TotalCostUSD) // "$0.0234"
```

## Configuration Options

```go
sdk.ClaudeAgentOptions{
    // Tools
    Tools:           []string{"Read", "Write"},  // Specific tools
    AllowedTools:    []string{"Read"},           // Auto-approved
    DisallowedTools: []string{"Bash(rm:*)"},     // Blocked

    // Permissions
    PermissionMode: sdk.PermissionModeDefault,   // default, acceptEdits, bypassPermissions
    CanUseTool:     permissionCallback,          // Custom callback

    // Session
    Resume:               "session-id",          // Resume existing session
    ContinueConversation: true,                  // Continue last conversation

    // Model
    Model:         "claude-sonnet-4-5",
    FallbackModel: "claude-haiku-3-5",
    MaxTurns:      &maxTurns,

    // Paths
    Cwd:     "/working/directory",
    CliPath: "/custom/path/to/claude",
    AddDirs: []string{"/additional/dir"},

    // Advanced
    SystemPrompt:            "Custom system prompt",
    Hooks:                   hooks.ToOptionsMap(),
    EnableFileCheckpointing: true,
    IncludePartialMessages:  true,
    Env:                     map[string]string{"KEY": "value"},
    ExtraArgs:               map[string]*string{"flag": nil},
}
```

## Files

```
backend/claude/sdk/
├── client.go           # ClaudeSDKClient, QueryOnce, helpers
├── query.go            # Query (control protocol handler)
├── types.go            # All type definitions
├── errors.go           # Error types
├── message_parser.go   # Message parsing
├── hooks.go            # Hook system
├── doc.go              # Package documentation
├── example_test.go     # Usage examples
└── transport/
    ├── transport.go    # Transport interface
    ├── options.go      # TransportOptions
    └── subprocess.go   # SubprocessCLITransport
```

## Comparison with Python SDK

This Go SDK mirrors the Python SDK's design:

| Python | Go |
|--------|-----|
| `ClaudeSDKClient` | `ClaudeSDKClient` |
| `query()` | `QueryOnce()` |
| `SubprocessCLITransport` | `SubprocessCLITransport` |
| `Query` | `Query` |
| `parse_message()` | `ParseMessage()` |
| `HookMatcher` | `HookMatcher` |
| `CanUseTool` callback | `CanUseToolFunc` |

## Integration Notes

This SDK is independent of the existing `backend/claude/` code (manager.go, session.go, etc.). It can be used alongside or as a replacement for the current implementation.

To integrate:
1. Import `"github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"`
2. Use `sdk.NewClaudeSDKClient()` or `sdk.QueryOnce()`
3. Handle messages via the typed `Messages()` channel

## AllowedTools vs CanUseTool

Understanding how these work together:

| Tool Status | What Happens |
|-------------|--------------|
| In `AllowedTools` | Auto-approved, no permission callback invoked |
| Not in `AllowedTools`, `CanUseTool` set | Permission callback invoked for approval |
| Not in `AllowedTools`, no callback | CLI's default behavior (may prompt or deny) |
| In `DisallowedTools` | Blocked entirely, tool not available to Claude |

**Example Configuration:**

```go
options := sdk.ClaudeAgentOptions{
    // These tools are auto-approved (no callback)
    AllowedTools: []string{"Read", "Glob", "Grep", "TodoWrite"},

    // These tools require user approval via callback
    // (WebFetch, Write, Edit, Bash, etc. will trigger CanUseTool)
    CanUseTool: myPermissionCallback,

    // These are completely blocked
    DisallowedTools: []string{"Bash(rm -rf:*)", "Bash(sudo:*)"},

    PermissionMode: sdk.PermissionModeDefault,
}
```

## Known Issues

### Duplicate tool_use IDs Error (Claude CLI 2.1.19)

When using `--output-format stream-json` with `--permission-prompt-tool stdio`, a bug in Claude CLI can cause:

```
API Error: 400 {"type":"error","error":{"type":"invalid_request_error",
"message":"messages.1.content.1: `tool_use` ids must be unique"}}
```

**Symptoms:**
- Tool executes successfully and returns results
- Error occurs when CLI tries to continue the conversation
- Happens with both client-side tools (WebFetch) and server-side tools (WebSearch)

**Root Cause:**
- Bug in Claude CLI's conversation state management in streaming JSON mode
- CLI creates duplicate tool_use IDs when constructing the next API request
- This is NOT a bug in this SDK - the SDK doesn't construct API messages

**Status:** Reported to Anthropic. Affects Claude CLI version 2.1.19.

**Workaround:** None currently. The permission approval flow works correctly; the error is downstream in the CLI.
