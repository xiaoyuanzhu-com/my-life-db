// Package claudesdk provides a Go SDK for interacting with Claude Code CLI.
//
// This SDK mirrors the design and architecture of the official Python Claude Agent SDK
// (https://github.com/anthropics/claude-agent-sdk-python), providing idiomatic Go
// interfaces for the same functionality.
//
// # Architecture
//
// The SDK is organized into several layers:
//
//   - Transport: Low-level subprocess management (stdin/stdout/stderr)
//   - Query: Control protocol handler with request/response routing
//   - ClaudeSDKClient: High-level bidirectional client
//
// # Quick Start
//
// For simple one-shot queries:
//
//	messages, errors := claudesdk.QueryOnce(ctx, "What is 2+2?", claudesdk.ClaudeAgentOptions{})
//	for msg := range messages {
//	    if am, ok := msg.(claudesdk.AssistantMessage); ok {
//	        fmt.Println(claudesdk.GetTextContent(am))
//	    }
//	}
//
// For interactive conversations:
//
//	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{})
//
//	if err := client.Connect(ctx, "Hello!"); err != nil {
//	    log.Fatal(err)
//	}
//	defer client.Close()
//
//	// Send messages
//	client.SendMessage("What files are in this directory?")
//
//	// Receive messages
//	for msg := range client.Messages() {
//	    switch m := msg.(type) {
//	    case claudesdk.AssistantMessage:
//	        fmt.Println(claudesdk.GetTextContent(m))
//	    case claudesdk.ResultMessage:
//	        fmt.Printf("Cost: %s\n", claudesdk.FormatCost(m.TotalCostUSD))
//	        return
//	    }
//	}
//
// # Permission Handling
//
// The SDK supports rich permission handling via callbacks:
//
//	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
//	    CanUseTool: func(toolName string, input map[string]any, ctx claudesdk.ToolPermissionContext) (claudesdk.PermissionResult, error) {
//	        // Auto-approve read-only tools
//	        if toolName == "Read" || toolName == "Glob" {
//	            return claudesdk.PermissionResultAllow{Behavior: claudesdk.PermissionAllow}, nil
//	        }
//	        // Deny dangerous commands
//	        if toolName == "Bash" {
//	            if cmd, ok := input["command"].(string); ok {
//	                if strings.Contains(cmd, "rm -rf") {
//	                    return claudesdk.PermissionResultDeny{
//	                        Behavior: claudesdk.PermissionDeny,
//	                        Message:  "Dangerous command not allowed",
//	                    }, nil
//	                }
//	            }
//	        }
//	        return claudesdk.PermissionResultAllow{Behavior: claudesdk.PermissionAllow}, nil
//	    },
//	})
//
// # Hook System
//
// Hooks allow intercepting and modifying tool usage:
//
//	hooks := claudesdk.NewHookManager()
//
//	// Log all tool usage
//	hooks.Register(claudesdk.HookPreToolUse, "*", claudesdk.LoggingHook(func(event, tool string, input map[string]any) {
//	    log.Printf("[%s] %s: %v", event, tool, input)
//	}))
//
//	// Validate Bash commands
//	hooks.Register(claudesdk.HookPreToolUse, "Bash", claudesdk.ValidationHook(func(tool string, input map[string]any) (bool, string) {
//	    if cmd, ok := input["command"].(string); ok {
//	        if strings.Contains(cmd, "sudo") {
//	            return false, "sudo commands are not allowed"
//	        }
//	    }
//	    return true, ""
//	}))
//
//	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
//	    Hooks: hooks.ToOptionsMap(),
//	})
//
// # Control Protocol
//
// The SDK implements the full Claude CLI control protocol:
//
//   - Initialize handshake with hooks registration
//   - Interrupt running operations
//   - Change permission mode mid-session
//   - Change model mid-session
//   - File checkpointing and rewind
//
// # Message Types
//
// The SDK provides typed message parsing:
//
//   - UserMessage: User input
//   - AssistantMessage: Claude's response with content blocks
//   - SystemMessage: Internal system events
//   - ResultMessage: Final result with cost/usage info
//   - StreamEvent: Partial message updates during streaming
//
// Content blocks within messages:
//
//   - TextBlock: Plain text
//   - ThinkingBlock: Claude's reasoning
//   - ToolUseBlock: Tool invocations
//   - ToolResultBlock: Tool execution results
package sdk
