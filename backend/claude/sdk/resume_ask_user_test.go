package sdk_test

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"
)

// TestResumeWithPendingAskUserQuestion tests what happens when Claude resumes
// a session that has an unfinished AskUserQuestion tool_use (no tool_result).
//
// This answers the key question: Does Claude re-emit a control_request for the
// pending AskUserQuestion, or does it do something else?
//
// Run with: go test -v -run TestResumeWithPendingAskUserQuestion ./claude/sdk/
func TestResumeWithPendingAskUserQuestion(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment")
	}

	// Use the existing session that has a pending AskUserQuestion
	// This session was created manually and has:
	// - User message asking to use AskUserQuestion
	// - Assistant message with tool_use block (id: toolu_01NyupBwmaL7NNg2P34S49CW)
	// - No tool_result
	sessionID := "c55e997d-9725-493d-845d-44c66aab231b"

	ctx := context.Background()

	t.Log("=== RESUMING SESSION WITH PENDING AskUserQuestion ===")
	t.Logf("Session ID: %s", sessionID)

	cmd := exec.CommandContext(ctx, "claude",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--permission-prompt-tool", "stdio", // Use permission protocol
		"--verbose",
		"--max-turns", "3",
		"--resume", sessionID,              // Resume existing session
		"--continue",                       // Continue where left off
	)
	cmd.Dir = "/Users/iloahz/projects/my-life-db/data"

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

	t.Log("Starting claude process with --resume...")
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

	// Track what we see
	var sawControlRequest bool
	var sawToolUse bool
	var sawToolResult bool
	var controlRequestToolName string
	var controlRequestID string

	scanner := bufio.NewScanner(stdout)
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

			// Check for control_request (permission request for AskUserQuestion)
			if msgType == "control_request" {
				sawControlRequest = true
				if request, ok := msg["request"].(map[string]any); ok {
					controlRequestToolName, _ = request["tool_name"].(string)
				}
				controlRequestID, _ = msg["request_id"].(string)
				t.Logf(">>> SAW control_request! tool_name: %s, request_id: %s", controlRequestToolName, controlRequestID)
			}

			// Check for AskUserQuestion tool_use (new one, not from history)
			if msgType == "assistant" {
				if message, ok := msg["message"].(map[string]any); ok {
					if content, ok := message["content"].([]any); ok {
						for _, block := range content {
							if blockMap, ok := block.(map[string]any); ok {
								if blockMap["type"] == "tool_use" && blockMap["name"] == "AskUserQuestion" {
									sawToolUse = true
									toolID, _ := blockMap["id"].(string)
									t.Logf(">>> SAW AskUserQuestion tool_use, ID: %s", toolID)
								}
							}
						}
					}
				}
			}

			// Check for tool_result
			if msgType == "user" {
				if message, ok := msg["message"].(map[string]any); ok {
					if content, ok := message["content"].([]any); ok {
						for _, block := range content {
							if blockMap, ok := block.(map[string]any); ok {
								if blockMap["type"] == "tool_result" {
									sawToolResult = true
									t.Logf(">>> SAW tool_result")
								}
							}
						}
					}
				}
			}

			// Check for result (end of turn)
			if msgType == "result" {
				t.Log(">>> Got result message - turn ended")
				break readLoop
			}

		case <-timeout:
			t.Log("Timeout reached (30s)")
			break readLoop
		}
	}

	// Summary
	t.Log("\n=== SUMMARY ===")
	t.Logf("Saw control_request: %v (tool: %s, id: %s)", sawControlRequest, controlRequestToolName, controlRequestID)
	t.Logf("Saw new tool_use: %v", sawToolUse)
	t.Logf("Saw tool_result: %v", sawToolResult)

	if sawControlRequest && controlRequestToolName == "AskUserQuestion" {
		t.Log("\n=== CONCLUSION ===")
		t.Log("Claude DOES re-emit control_request for pending AskUserQuestion on resume!")
		t.Log("The request_id format is: " + controlRequestID)
	} else if sawToolResult {
		t.Log("\n=== CONCLUSION ===")
		t.Log("Claude auto-generated a tool_result without re-asking")
	} else {
		t.Log("\n=== CONCLUSION ===")
		t.Log("Claude did something else - check the logs above")
	}
}
