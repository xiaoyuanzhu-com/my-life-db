package sdk_test

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestInitMessagePerUserInput verifies when init messages are sent.
// Question 1: Is it 1 init message per session OR 1 per user input?
// Question 2: Are init messages saved to JSONL files?
//
// Run with: go test -v -run TestInitMessagePerUserInput ./claude/sdk/
func TestInitMessagePerUserInput(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment")
	}

	ctx := context.Background()

	cmd := exec.CommandContext(ctx, "claude",
		"--output-format", "stream-json",
		"--verbose",
		"--max-turns", "5",
		"--input-format", "stream-json",
		"--system-prompt", "Be extremely brief. One word answers only.",
	)
	cmd.Dir = "/tmp"

	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()

	t.Log("Starting claude process...")
	if err := cmd.Start(); err != nil {
		t.Fatalf("Failed to start: %v", err)
	}
	t.Logf("PID: %d", cmd.Process.Pid)
	defer cmd.Process.Kill()

	// Track init messages
	initMessages := []map[string]any{}
	allMessages := []map[string]any{}

	scanner := bufio.NewScanner(stdout)
	resultCount := 0

	// Send first user message
	t.Log("=== Sending FIRST user message ===")
	userMsg1 := `{"type":"user","message":{"role":"user","content":"Say hi"},"session_id":"test-init-1"}` + "\n"
	stdin.Write([]byte(userMsg1))

	// Read messages until first result
	timeout := time.After(60 * time.Second)
readLoop1:
	for {
		select {
		case <-timeout:
			t.Fatal("Timeout waiting for first result")
		default:
			if !scanner.Scan() {
				break readLoop1
			}
			line := scanner.Text()
			var msg map[string]any
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				continue
			}
			allMessages = append(allMessages, msg)

			msgType, _ := msg["type"].(string)
			subtype, _ := msg["subtype"].(string)

			if msgType == "system" && subtype == "init" {
				initMessages = append(initMessages, msg)
				t.Logf("Got INIT message #%d", len(initMessages))
			}

			if msgType == "result" {
				resultCount++
				t.Logf("Got result #%d", resultCount)
				break readLoop1
			}
		}
	}

	t.Logf("After first message: init_count=%d, total_messages=%d", len(initMessages), len(allMessages))

	// Wait a bit, then send second message
	time.Sleep(1 * time.Second)

	t.Log("=== Sending SECOND user message ===")
	userMsg2 := `{"type":"user","message":{"role":"user","content":"Say bye"},"session_id":"test-init-1"}` + "\n"
	stdin.Write([]byte(userMsg2))

	// Read messages until second result
	timeout = time.After(60 * time.Second)
readLoop2:
	for {
		select {
		case <-timeout:
			t.Fatal("Timeout waiting for second result")
		default:
			if !scanner.Scan() {
				break readLoop2
			}
			line := scanner.Text()
			var msg map[string]any
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				continue
			}
			allMessages = append(allMessages, msg)

			msgType, _ := msg["type"].(string)
			subtype, _ := msg["subtype"].(string)

			if msgType == "system" && subtype == "init" {
				initMessages = append(initMessages, msg)
				t.Logf("Got INIT message #%d (during second input!)", len(initMessages))
			}

			if msgType == "result" {
				resultCount++
				t.Logf("Got result #%d", resultCount)
				break readLoop2
			}
		}
	}

	// Close stdin to signal end
	stdin.Close()

	t.Log("=== RESULTS ===")
	t.Logf("Total init messages: %d", len(initMessages))
	t.Logf("Total result messages: %d", resultCount)
	t.Logf("Total messages: %d", len(allMessages))

	// Analysis
	if len(initMessages) == 1 {
		t.Log("✓ CONFIRMED: Only 1 init message per session (not per user input)")
	} else if len(initMessages) > 1 {
		t.Logf("⚠ UNEXPECTED: Got %d init messages! May be 1 per user input", len(initMessages))
	} else {
		t.Log("⚠ No init messages received (maybe --skip-initialization?)")
	}

	// Wait for process to finish
	cmd.Wait()
}

// TestInitMessageInJSONL verifies init messages are persisted to JSONL files.
// Run with: go test -v -run TestInitMessageInJSONL ./claude/sdk/
func TestInitMessageInJSONL(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment")
	}

	ctx := context.Background()

	// Use a unique session ID so we can find the file
	sessionID := "test-init-jsonl-" + time.Now().Format("20060102-150405")

	cmd := exec.CommandContext(ctx, "claude",
		"--output-format", "stream-json",
		"--verbose",
		"--max-turns", "1",
		"--input-format", "stream-json",
		"--system-prompt", "Say OK only.",
	)
	cmd.Dir = "/tmp"

	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()

	t.Log("Starting claude process...")
	if err := cmd.Start(); err != nil {
		t.Fatalf("Failed to start: %v", err)
	}
	defer cmd.Process.Kill()

	// Send a message
	userMsg := `{"type":"user","message":{"role":"user","content":"Test"},"session_id":"` + sessionID + `"}` + "\n"
	stdin.Write([]byte(userMsg))

	// Read until result
	scanner := bufio.NewScanner(stdout)
	timeout := time.After(60 * time.Second)
readLoop:
	for {
		select {
		case <-timeout:
			t.Fatal("Timeout")
		default:
			if !scanner.Scan() {
				break readLoop
			}
			line := scanner.Text()
			var msg map[string]any
			json.Unmarshal([]byte(line), &msg)
			if msg["type"] == "result" {
				t.Log("Got result")
				break readLoop
			}
		}
	}

	stdin.Close()
	cmd.Wait()

	// Now check the JSONL file
	t.Log("=== Checking JSONL persistence ===")

	// Claude stores sessions in ~/.claude/projects/{project-path}/{session-id}.jsonl
	// For /tmp, it would be something like ~/.claude/projects/-tmp/
	homeDir, _ := os.UserHomeDir()
	claudeProjectsDir := filepath.Join(homeDir, ".claude", "projects")

	// Find JSONL files that might contain our session
	var foundFile string
	filepath.Walk(claudeProjectsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".jsonl") {
			// Check if this file was recently modified
			if time.Since(info.ModTime()) < 5*time.Minute {
				t.Logf("Found recent JSONL: %s", path)
				foundFile = path
			}
		}
		return nil
	})

	if foundFile == "" {
		t.Log("Could not find recent JSONL file - checking manually may be needed")
		t.Logf("Look in: %s", claudeProjectsDir)
		return
	}

	// Read the JSONL file
	data, err := os.ReadFile(foundFile)
	if err != nil {
		t.Fatalf("Failed to read JSONL: %v", err)
	}

	lines := strings.Split(string(data), "\n")
	initCount := 0
	for i, line := range lines {
		if line == "" {
			continue
		}
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		msgType, _ := msg["type"].(string)
		subtype, _ := msg["subtype"].(string)
		if msgType == "system" && subtype == "init" {
			initCount++
			t.Logf("Line %d: Found INIT message in JSONL", i+1)
			// Print some fields
			if model, ok := msg["model"].(string); ok {
				t.Logf("  model: %s", model)
			}
			if tools, ok := msg["tools"].([]any); ok {
				t.Logf("  tools count: %d", len(tools))
			}
		}
	}

	t.Log("=== JSONL RESULTS ===")
	if initCount > 0 {
		t.Logf("✓ CONFIRMED: Init messages ARE saved to JSONL (found %d)", initCount)
	} else {
		t.Log("⚠ No init messages found in JSONL file")
	}
}

// TestMultipleSessionsInitMessages tests if each NEW session gets its own init message.
// Run with: go test -v -run TestMultipleSessionsInitMessages ./claude/sdk/
func TestMultipleSessionsInitMessages(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("Skipping in CI environment")
	}

	t.Log("Testing: Does each session get exactly 1 init message?")

	runSession := func(name string) int {
		ctx := context.Background()
		cmd := exec.CommandContext(ctx, "claude",
			"--output-format", "stream-json",
			"--max-turns", "1",
			"--input-format", "stream-json",
			"--system-prompt", "Say OK.",
		)
		cmd.Dir = "/tmp"

		stdin, _ := cmd.StdinPipe()
		stdout, _ := cmd.StdoutPipe()

		if err := cmd.Start(); err != nil {
			t.Fatalf("Failed to start %s: %v", name, err)
		}
		defer cmd.Process.Kill()

		// Send message
		userMsg := `{"type":"user","message":{"role":"user","content":"Hi"},"session_id":"` + name + `"}` + "\n"
		stdin.Write([]byte(userMsg))

		initCount := 0
		scanner := bufio.NewScanner(stdout)
		timeout := time.After(60 * time.Second)
	loop:
		for {
			select {
			case <-timeout:
				t.Fatalf("Timeout in %s", name)
			default:
				if !scanner.Scan() {
					break loop
				}
				var msg map[string]any
				json.Unmarshal([]byte(scanner.Text()), &msg)
				if msg["type"] == "system" && msg["subtype"] == "init" {
					initCount++
				}
				if msg["type"] == "result" {
					break loop
				}
			}
		}

		stdin.Close()
		cmd.Wait()
		return initCount
	}

	// Run 3 separate sessions
	session1Init := runSession("session-1")
	t.Logf("Session 1: %d init messages", session1Init)

	time.Sleep(500 * time.Millisecond)

	session2Init := runSession("session-2")
	t.Logf("Session 2: %d init messages", session2Init)

	time.Sleep(500 * time.Millisecond)

	session3Init := runSession("session-3")
	t.Logf("Session 3: %d init messages", session3Init)

	t.Log("=== MULTI-SESSION RESULTS ===")
	if session1Init == 1 && session2Init == 1 && session3Init == 1 {
		t.Log("✓ CONFIRMED: Each new session gets exactly 1 init message")
	} else {
		t.Logf("Results: session1=%d, session2=%d, session3=%d", session1Init, session2Init, session3Init)
	}
}
