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

// TestResumeAndSendToolResult tests sending a tool_result when resuming
// a session with a pending AskUserQuestion.
//
// Run with: go test -v -run TestResumeAndSendToolResult ./claude/sdk/
func TestResumeAndSendToolResult(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment")
	}

	// Use the existing session that has a pending AskUserQuestion
	// tool_use ID: toolu_01NyupBwmaL7NNg2P34S49CW
	sessionID := "c55e997d-9725-493d-845d-44c66aab231b"
	toolUseID := "toolu_01NyupBwmaL7NNg2P34S49CW"

	ctx := context.Background()

	t.Log("=== RESUMING SESSION AND SENDING tool_result ===")
	t.Logf("Session ID: %s", sessionID)
	t.Logf("Tool Use ID: %s", toolUseID)

	cmd := exec.CommandContext(ctx, "claude",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
		"--max-turns", "3",
		"--resume", sessionID,
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

	// Wait a bit for Claude to be ready
	time.Sleep(2 * time.Second)

	// Send tool_result with user's answers
	// Content must be a STRING (JSON stringified), not an object
	contentData := map[string]any{
		"questions": []map[string]any{
			{"question": "What is your favorite color?", "header": "Color"},
			{"question": "What is your preferred season?", "header": "Season"},
			{"question": "What type of music do you enjoy most?", "header": "Music"},
		},
		"answers": map[string]any{
			"q0": []string{"Blue", "Green"},
			"q1": "Autumn",
			"q2": "Rock",
		},
	}
	contentJSON, _ := json.Marshal(contentData)

	toolResult := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role": "user",
			"content": []map[string]any{
				{
					"type":        "tool_result",
					"tool_use_id": toolUseID,
					"content":     string(contentJSON), // Must be a string!
				},
			},
		},
		"session_id": sessionID,
	}
	toolResultJSON, _ := json.Marshal(toolResult)
	t.Logf("Sending tool_result: %s", string(toolResultJSON))
	stdin.Write(append(toolResultJSON, '\n'))

	// Track what we see
	var sawAssistantResponse bool
	var sawResult bool

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

			if msgType == "assistant" {
				sawAssistantResponse = true
				t.Log(">>> SAW assistant response!")
			}

			if msgType == "result" {
				sawResult = true
				t.Log(">>> Got result - turn ended")
				break readLoop
			}

		case <-timeout:
			t.Log("Timeout reached (30s)")
			break readLoop
		}
	}

	// Summary
	t.Log("\n=== SUMMARY ===")
	t.Logf("Saw assistant response: %v", sawAssistantResponse)
	t.Logf("Saw result: %v", sawResult)

	if sawAssistantResponse && sawResult {
		t.Log("\n=== CONCLUSION ===")
		t.Log("SUCCESS! Sending tool_result on resume works!")
	} else {
		t.Log("\n=== CONCLUSION ===")
		t.Log("FAILED - Claude did not respond to tool_result")
	}
}
