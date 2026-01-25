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

Custom permission callback for tool authorization:

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
