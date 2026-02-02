package sdk_test

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	claudesdk "github.com/xiaoyuanzhu-com/my-life-db/claude/sdk"
)

func intPtr(i int) *int {
	return &i
}

// TestGracefulExitSIGINT verifies that Claude CLI responds to SIGINT (not SIGTERM).
// This is a low-level test that directly spawns the process.
// Run with: go test -v -run TestGracefulExitSIGINT ./claude/sdk/
func TestGracefulExitSIGINT(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment")
	}

	ctx := context.Background()

	cmd := exec.CommandContext(ctx, "claude",
		"--output-format", "stream-json",
		"--verbose",
		"--max-turns", "1",
		"--input-format", "stream-json",
		"--system-prompt", "Be brief.",
	)
	cmd.Dir = "/tmp"

	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()

	t.Log("Starting claude process...")
	if err := cmd.Start(); err != nil {
		t.Fatalf("Failed to start: %v", err)
	}
	t.Logf("PID: %d", cmd.Process.Pid)

	// Send user message
	userMsg := `{"type":"user","message":{"role":"user","content":"Say hi"},"session_id":"test"}` + "\n"
	stdin.Write([]byte(userMsg))

	// Read until we see result
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		var msg map[string]any
		json.Unmarshal([]byte(line), &msg)
		msgType, _ := msg["type"].(string)
		if msgType == "result" {
			t.Log("Got result message")
			break
		}
	}

	t.Log("Waiting 2s for idle...")
	time.Sleep(2 * time.Second)

	// Close stdin
	stdin.Close()

	// Try SIGINT
	t.Log("Sending SIGINT...")
	sigintStart := time.Now()
	cmd.Process.Signal(syscall.SIGINT)

	// Wait with timeout
	done := make(chan error)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case err := <-done:
		duration := time.Since(sigintStart)
		t.Logf("Process exited in %v: %v", duration, err)
		if duration > 1*time.Second {
			t.Errorf("SIGINT took too long (%v)", duration)
		}
	case <-time.After(3 * time.Second):
		t.Log("SIGINT timeout after 3s, trying SIGTERM...")
		cmd.Process.Signal(syscall.SIGTERM)

		select {
		case <-done:
			t.Log("Process exited after SIGTERM")
		case <-time.After(3 * time.Second):
			cmd.Process.Kill()
			<-done
			t.Error("Process required SIGKILL - graceful shutdown not working")
		}
	}
}

// TestGracefulExitSDK tests graceful exit using the full SDK client.
// This is the production-like test.
// Run with: go test -v -run TestGracefulExitSDK ./claude/sdk/
func TestGracefulExitSDK(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment")
	}

	ctx := context.Background()

	// Create SDK client similar to production (with SkipInitialization and CanUseTool)
	client := claudesdk.NewClaudeSDKClient(claudesdk.ClaudeAgentOptions{
		SystemPrompt:       "You are helpful. Be very brief. One word answers only.",
		MaxTurns:           intPtr(1),
		Cwd:                "/tmp",
		SkipInitialization: true,
		CanUseTool: func(toolName string, input map[string]any, ctx claudesdk.ToolPermissionContext) (claudesdk.PermissionResult, error) {
			return claudesdk.PermissionResultAllow{Behavior: claudesdk.PermissionAllow}, nil
		},
	})

	t.Log("Connecting via SDK...")
	startTime := time.Now()

	if err := client.Connect(ctx, ""); err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	t.Logf("Connected in %v", time.Since(startTime))

	// Send a simple message
	t.Log("Sending user message...")
	if err := client.SendMessage("What is 2+2? Answer with just the number."); err != nil {
		t.Fatalf("Failed to send message: %v", err)
	}

	// Read messages until result
	timeout := time.After(60 * time.Second)

readLoop:
	for {
		select {
		case raw, ok := <-client.RawMessages():
			if !ok {
				break readLoop
			}

			msgType, _ := raw["type"].(string)
			if msgType == "result" {
				t.Log("Got result message")
				break readLoop
			}
			if msgType == "assistant" {
				if msg, ok := raw["message"].(map[string]any); ok {
					if content, ok := msg["content"].([]any); ok && len(content) > 0 {
						if first, ok := content[0].(map[string]any); ok {
							if text, ok := first["text"].(string); ok {
								t.Logf("Assistant: %s", text)
							}
						}
					}
				}
			}

		case <-timeout:
			t.Fatal("Timeout waiting for messages")
		}
	}

	// Wait for idle
	t.Log("Waiting 3s for idle...")
	time.Sleep(3 * time.Second)

	// Test graceful close
	t.Log("Calling Close()...")
	closeStart := time.Now()

	err := client.Close()
	closeDuration := time.Since(closeStart)

	t.Logf("Close() returned in %v", closeDuration)

	if err != nil {
		t.Errorf("Close() error: %v", err)
	}

	// Check timing: > 3s means SIGKILL was needed
	if closeDuration > 3*time.Second {
		t.Errorf("Close() took %v - hit SIGKILL timeout, NOT graceful", closeDuration)
	} else {
		t.Logf("Close() completed in %v - graceful shutdown worked", closeDuration)
	}
}
