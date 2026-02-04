package sdk_test

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestAskUserQuestionBehavior tests what happens when Claude uses AskUserQuestion in SDK mode.
// This helps us understand if Claude Code auto-responds or waits for our tool_result.
// Run with: go test -v -run TestAskUserQuestionBehavior ./claude/sdk/
func TestAskUserQuestionBehavior(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment")
	}

	ctx := context.Background()

	// Use a unique session ID (must be valid UUID)
	sessionID := uuid.New().String()

	cmd := exec.CommandContext(ctx, "claude",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--dangerously-skip-permissions", // Skip all permission prompts
		"--verbose",
		"--max-turns", "3",
		"--session-id", sessionID,
		"--system-prompt", "You are testing the AskUserQuestion tool. When asked to ask a question, use the AskUserQuestion tool immediately.",
	)
	cmd.Dir = "/tmp"

	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("Failed to get stdin pipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("Failed to get stdout pipe: %v", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatalf("Failed to get stderr pipe: %v", err)
	}

	// Log stderr in background
	go func() {
		stderrScanner := bufio.NewScanner(stderr)
		for stderrScanner.Scan() {
			t.Logf("STDERR: %s", stderrScanner.Text())
		}
	}()

	t.Log("Starting claude process...")
	if err := cmd.Start(); err != nil {
		t.Fatalf("Failed to start: %v", err)
	}
	t.Logf("PID: %d", cmd.Process.Pid)

	// Cleanup
	defer func() {
		stdin.Close()
		cmd.Process.Kill()
		cmd.Wait()
	}()

	// Send a prompt that should trigger AskUserQuestion
	userMsg := `{"type":"user","message":{"role":"user","content":"Please use the AskUserQuestion tool to ask me: What is your favorite color? Give me options: Red, Blue, Green"},"session_id":"test"}` + "\n"
	t.Logf("Sending: %s", userMsg)
	stdin.Write([]byte(userMsg))

	// Read and log all messages for 30 seconds
	scanner := bufio.NewScanner(stdout)

	// Track what we see
	var sawToolUse bool
	var sawToolResult bool
	var toolUseTime time.Time
	var toolResultTime time.Time
	var toolUseID string

	timeout := time.After(30 * time.Second)
	msgChan := make(chan string, 100)

	// Read messages in goroutine
	go func() {
		for scanner.Scan() {
			msgChan <- scanner.Text()
		}
		close(msgChan)
	}()

readLoop:
	for {
		select {
		case line, ok := <-msgChan:
			if !ok {
				t.Log("Scanner closed")
				break readLoop
			}

			var msg map[string]any
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				t.Logf("Non-JSON line: %s", line)
				continue
			}

			msgType, _ := msg["type"].(string)
			t.Logf("Message type: %s", msgType)

			// Pretty print the message
			pretty, _ := json.MarshalIndent(msg, "", "  ")
			t.Logf("Full message:\n%s", string(pretty))

			// Check for AskUserQuestion tool_use
			if msgType == "assistant" {
				if message, ok := msg["message"].(map[string]any); ok {
					if content, ok := message["content"].([]any); ok {
						for _, block := range content {
							if blockMap, ok := block.(map[string]any); ok {
								if blockMap["type"] == "tool_use" && blockMap["name"] == "AskUserQuestion" {
									sawToolUse = true
									toolUseTime = time.Now()
									toolUseID, _ = blockMap["id"].(string)
									t.Logf(">>> SAW AskUserQuestion tool_use at %v, ID: %s", toolUseTime, toolUseID)
								}
							}
						}
					}
				}
			}

			// Check for tool_result (user message with tool_result block)
			if msgType == "user" {
				if message, ok := msg["message"].(map[string]any); ok {
					if content, ok := message["content"].([]any); ok {
						for _, block := range content {
							if blockMap, ok := block.(map[string]any); ok {
								if blockMap["type"] == "tool_result" {
									sawToolResult = true
									toolResultTime = time.Now()
									resultToolUseID, _ := blockMap["tool_use_id"].(string)
									t.Logf(">>> SAW tool_result at %v, tool_use_id: %s", toolResultTime, resultToolUseID)

									if sawToolUse {
										t.Logf(">>> Time between tool_use and tool_result: %v", toolResultTime.Sub(toolUseTime))
									}
								}
							}
						}
					}
				}

				// Also check for tool_use_result field (AskUserQuestion specific)
				if toolUseResult, ok := msg["tool_use_result"].(map[string]any); ok {
					t.Logf(">>> tool_use_result field found: %v", toolUseResult)
					if answers, ok := toolUseResult["answers"].(map[string]any); ok {
						t.Logf(">>> answers: %v (empty: %v)", answers, len(answers) == 0)
					}
				}
			}

			// Check for result (end of turn)
			if msgType == "result" {
				t.Log(">>> Got result message - turn ended")
				break readLoop
			}

		case <-timeout:
			t.Log("Timeout reached")
			break readLoop
		}
	}

	// Summary
	t.Log("\n=== SUMMARY ===")
	t.Logf("Saw AskUserQuestion tool_use: %v", sawToolUse)
	t.Logf("Saw tool_result: %v", sawToolResult)

	if sawToolUse && sawToolResult {
		t.Logf("Time between tool_use and tool_result: %v", toolResultTime.Sub(toolUseTime))
		t.Log("CONCLUSION: Claude Code auto-generated the tool_result")
	} else if sawToolUse && !sawToolResult {
		t.Log("CONCLUSION: Claude Code is waiting for external tool_result")
	} else {
		t.Log("CONCLUSION: AskUserQuestion was not used or test needs adjustment")
	}
}
