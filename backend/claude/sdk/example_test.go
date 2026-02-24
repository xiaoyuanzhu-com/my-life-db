package sdk_test

import (
	"context"
	"fmt"
	"strings"
	"time"

	claudesdk "github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"
)

// ExampleClaudeSDKClient_simple demonstrates a simple interactive conversation
func ExampleClaudeSDKClient_simple() {
	ctx := context.Background()

	// Create client with basic options
	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
		Cwd: "/path/to/project",
	})

	// Connect with an initial prompt
	if err := client.Connect(ctx, "What files are in this directory?"); err != nil {
		fmt.Printf("Failed to connect: %v\n", err)
		return
	}
	defer client.Close()

	// Receive messages
	for msg := range client.Messages() {
		switch m := msg.(type) {
		case claudesdk.AssistantMessage:
			fmt.Println(claudesdk.GetTextContent(m))

		case claudesdk.ResultMessage:
			fmt.Printf("Done! Cost: %s\n", claudesdk.FormatCost(m.TotalCostUSD))
			return
		}
	}
}

// ExampleClaudeSDKClient_withPermissions demonstrates custom permission handling
func ExampleClaudeSDKClient_withPermissions() {
	ctx := context.Background()

	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
		CanUseTool: func(toolName string, input map[string]any, ctx claudesdk.ToolPermissionContext) (claudesdk.PermissionResult, error) {
			// Auto-approve read-only tools
			if toolName == "Read" || toolName == "Glob" || toolName == "Grep" {
				return claudesdk.PermissionResultAllow{
					Behavior: claudesdk.PermissionAllow,
				}, nil
			}

			// Deny dangerous bash commands
			if toolName == "Bash" {
				if cmd, ok := input["command"].(string); ok {
					if strings.Contains(cmd, "rm -rf") || strings.Contains(cmd, "sudo") {
						return claudesdk.PermissionResultDeny{
							Behavior: claudesdk.PermissionDeny,
							Message:  "Dangerous command not allowed",
						}, nil
					}
				}
			}

			// Allow everything else
			return claudesdk.PermissionResultAllow{
				Behavior: claudesdk.PermissionAllow,
			}, nil
		},
	})

	if err := client.Connect(ctx, ""); err != nil {
		fmt.Printf("Failed to connect: %v\n", err)
		return
	}
	defer client.Close()

	// Send messages
	client.SendMessage("List files and then try to delete them")

	// Process responses...
}

// ExampleClaudeSDKClient_withHooks demonstrates the hook system
func ExampleClaudeSDKClient_withHooks() {
	ctx := context.Background()

	hooks := claudesdk.NewHookManager()

	// Log all tool usage
	hooks.Register(claudesdk.HookPreToolUse, "*", func(input claudesdk.HookInput, toolUseID *string, ctx claudesdk.HookContext) (claudesdk.HookOutput, error) {
		if hi, ok := input.(claudesdk.PreToolUseHookInput); ok {
			fmt.Printf("[AUDIT] Tool: %s\n", hi.ToolName)
		}
		return claudesdk.PreToolUseAllow(), nil
	})

	// Only allow specific tools
	hooks.Register(claudesdk.HookPreToolUse, "Bash", claudesdk.ValidationHook(func(tool string, input map[string]any) (bool, string) {
		if cmd, ok := input["command"].(string); ok {
			// Only allow read-only commands
			if strings.HasPrefix(cmd, "ls") || strings.HasPrefix(cmd, "cat") {
				return true, ""
			}
			return false, "Only read-only bash commands are allowed"
		}
		return false, "Invalid command"
	}))

	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
		Hooks: hooks.ToOptionsMap(),
	})

	if err := client.Connect(ctx, ""); err != nil {
		fmt.Printf("Failed to connect: %v\n", err)
		return
	}
	defer client.Close()
}

// ExampleQueryOnce demonstrates a one-shot query
func ExampleQueryOnce() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	messages, errors := claudesdk.QueryOnce(ctx, "What is 2 + 2?", claudesdk.ClaudeAgentOptions{})

	// Check for errors in a separate goroutine
	go func() {
		for err := range errors {
			fmt.Printf("Error: %v\n", err)
		}
	}()

	// Process messages
	for msg := range messages {
		switch m := msg.(type) {
		case claudesdk.AssistantMessage:
			fmt.Println(claudesdk.GetTextContent(m))

		case claudesdk.ResultMessage:
			if m.IsError {
				fmt.Println("Query failed")
			}
		}
	}
}

// ExampleClaudeSDKClient_interrupt demonstrates interrupting a long operation
func ExampleClaudeSDKClient_interrupt() {
	ctx := context.Background()

	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{})

	if err := client.Connect(ctx, "Analyze the entire codebase"); err != nil {
		fmt.Printf("Failed to connect: %v\n", err)
		return
	}
	defer client.Close()

	// After 5 seconds, interrupt
	go func() {
		time.Sleep(5 * time.Second)
		if err := client.Interrupt(); err != nil {
			fmt.Printf("Interrupt failed: %v\n", err)
		}
	}()

	// Process messages until interrupted or complete
	for msg := range client.Messages() {
		switch m := msg.(type) {
		case claudesdk.AssistantMessage:
			fmt.Println(claudesdk.GetTextContent(m))

		case claudesdk.ResultMessage:
			if m.IsError {
				fmt.Println("Interrupted or error")
			} else {
				fmt.Println("Completed")
			}
			return
		}
	}
}

// ExampleClaudeSDKClient_modelSwitch demonstrates changing models mid-conversation
func ExampleClaudeSDKClient_modelSwitch() {
	ctx := context.Background()

	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
		Model: "claude-sonnet-4-5", // Start with Sonnet
	})

	if err := client.Connect(ctx, ""); err != nil {
		fmt.Printf("Failed to connect: %v\n", err)
		return
	}
	defer client.Close()

	// First query with Sonnet
	client.SendMessage("Outline a plan for this feature")

	// Wait for response...

	// Switch to Opus for implementation
	if err := client.SetModel("claude-opus-4-5"); err != nil {
		fmt.Printf("Failed to switch model: %v\n", err)
		return
	}

	// Continue with Opus
	client.SendMessage("Now implement the plan")
}
