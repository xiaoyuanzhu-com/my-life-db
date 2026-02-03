// Package sdk provides tests for Claude CLI streaming behavior.
//
// These tests verify:
// 1. How progressive updates (stream_event) work with --include-partial-messages
// 2. Whether different modes support multi-turn conversations
//
// Run with: go test -v -run TestStreaming ./claude/sdk/
// Note: These are integration tests that require the Claude CLI to be installed.
package sdk

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"
)

// StreamEvent represents a stream_event message from Claude CLI
type TestStreamEvent struct {
	Type            string         `json:"type"`
	Event           map[string]any `json:"event"`
	SessionID       string         `json:"session_id"`
	ParentToolUseID *string        `json:"parent_tool_use_id"`
	UUID            string         `json:"uuid"`
}

// TestMessage represents any message from Claude CLI
type TestMessage struct {
	Type    string         `json:"type"`
	Subtype string         `json:"subtype,omitempty"`
	Event   map[string]any `json:"event,omitempty"`
}

// skipIfNoCLI skips the test if Claude CLI is not available
func skipIfNoCLI(t *testing.T) {
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("Claude CLI not found, skipping integration test")
	}
}

// TestStreamingProgressUpdates verifies that --include-partial-messages produces
// stream_event messages with incremental text deltas.
//
// Expected behavior:
// - stream_event with type "message_start" at the beginning
// - stream_event with type "content_block_start" for each content block
// - stream_event with type "content_block_delta" for incremental text (multiple)
// - stream_event with type "content_block_stop" when block completes
// - stream_event with type "message_delta" with stop_reason
// - stream_event with type "message_stop" at the end
// - Full "assistant" message with complete content
// - "result" message at the very end
func TestStreamingProgressUpdates(t *testing.T) {
	skipIfNoCLI(t)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Use --print mode with --include-partial-messages
	cmd := exec.CommandContext(ctx, "claude",
		"--print",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--max-turns", "1",
		"Say hello in exactly 5 words",
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("Failed to get stdout pipe: %v", err)
	}

	if err := cmd.Start(); err != nil {
		t.Fatalf("Failed to start command: %v", err)
	}

	// Collect all messages
	var messages []map[string]any
	var streamEvents []TestStreamEvent
	var textDeltas []string
	var eventTypes []string

	scanner := bufio.NewScanner(stdout)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var msg map[string]any
		if err := json.Unmarshal(line, &msg); err != nil {
			t.Logf("Failed to parse JSON: %v", err)
			continue
		}

		messages = append(messages, msg)
		msgType, _ := msg["type"].(string)

		if msgType == "stream_event" {
			var se TestStreamEvent
			if err := json.Unmarshal(line, &se); err == nil {
				streamEvents = append(streamEvents, se)

				eventType, _ := se.Event["type"].(string)
				eventTypes = append(eventTypes, eventType)

				// Extract text deltas
				if eventType == "content_block_delta" {
					if delta, ok := se.Event["delta"].(map[string]any); ok {
						if deltaType, _ := delta["type"].(string); deltaType == "text_delta" {
							if text, _ := delta["text"].(string); text != "" {
								textDeltas = append(textDeltas, text)
							}
						}
					}
				}
			}
		}
	}

	if err := cmd.Wait(); err != nil {
		// Non-zero exit is OK if we got output
		if len(messages) == 0 {
			t.Fatalf("Command failed with no output: %v", err)
		}
	}

	// Verify we got stream events
	if len(streamEvents) == 0 {
		t.Fatal("No stream_event messages received")
	}

	t.Logf("Received %d total messages, %d stream_events", len(messages), len(streamEvents))
	t.Logf("Event types in order: %v", eventTypes)
	t.Logf("Text deltas received: %v", textDeltas)

	// Verify expected event sequence
	expectedEventTypes := []string{
		"message_start",
		"content_block_start",
		"content_block_delta", // At least one
		"content_block_stop",
		"message_delta",
		"message_stop",
	}

	for _, expected := range expectedEventTypes {
		if !slices.Contains(eventTypes, expected) {
			t.Errorf("Expected event type %q not found in: %v", expected, eventTypes)
		}
	}

	// Verify we got multiple text deltas (progressive updates)
	if len(textDeltas) < 2 {
		t.Errorf("Expected multiple text deltas for progressive updates, got %d", len(textDeltas))
	}

	// Verify we got an assistant message with full content
	var assistantMsg map[string]any
	for _, msg := range messages {
		if msg["type"] == "assistant" {
			assistantMsg = msg
			break
		}
	}
	if assistantMsg == nil {
		t.Error("No assistant message found")
	} else {
		t.Logf("Assistant message: %v", assistantMsg)
	}

	// Verify we got a result message
	var resultMsg map[string]any
	for _, msg := range messages {
		if msg["type"] == "result" {
			resultMsg = msg
			break
		}
	}
	if resultMsg == nil {
		t.Error("No result message found")
	}

	// Log timing information
	t.Logf("Total stream events: %d", len(streamEvents))
	t.Logf("Total text deltas: %d", len(textDeltas))
	combinedText := strings.Join(textDeltas, "")
	t.Logf("Combined delta text: %q", combinedText)
}

// TestPrintModeMultiTurn tests whether --print mode can support multiple rounds
// of conversation by sending multiple user messages via stdin.
//
// This is critical for understanding if we can use --print mode for interactive
// sessions or if we MUST use --input-format stream-json for multi-turn.
func TestPrintModeMultiTurn(t *testing.T) {
	skipIfNoCLI(t)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// Try --print mode with stdin input (not passing prompt as argument)
	cmd := exec.CommandContext(ctx, "claude",
		"--print",
		"--output-format", "stream-json",
		"--verbose",
		"--max-turns", "2",
		"--input-format", "stream-json", // Try combining with stream-json input
	)

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

	if err := cmd.Start(); err != nil {
		t.Fatalf("Failed to start command: %v", err)
	}

	// Capture stderr in background
	var stderrOutput strings.Builder
	go func() {
		io.Copy(&stderrOutput, stderr)
	}()

	// Send first message
	firstMsg := `{"type":"user","message":{"role":"user","content":"Remember the number 42. Just say OK."}}`
	t.Logf("Sending first message: %s", firstMsg)
	if _, err := fmt.Fprintln(stdin, firstMsg); err != nil {
		t.Fatalf("Failed to write first message: %v", err)
	}

	// Collect messages
	var messages []map[string]any
	var gotFirstResult bool

	scanner := bufio.NewScanner(stdout)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 1024*1024)

	// Read until we get the first result
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var msg map[string]any
		if err := json.Unmarshal(line, &msg); err != nil {
			continue
		}

		messages = append(messages, msg)
		msgType, _ := msg["type"].(string)
		t.Logf("Received message type: %s", msgType)

		if msgType == "result" {
			gotFirstResult = true
			break
		}
	}

	if !gotFirstResult {
		t.Logf("Stderr: %s", stderrOutput.String())
		t.Fatal("Did not receive first result message")
	}

	t.Logf("Got first result, sending second message...")

	// Send second message
	secondMsg := `{"type":"user","message":{"role":"user","content":"What number did I ask you to remember?"}}`
	t.Logf("Sending second message: %s", secondMsg)
	if _, err := fmt.Fprintln(stdin, secondMsg); err != nil {
		t.Logf("Failed to write second message (may be expected): %v", err)
		t.Logf("Stderr: %s", stderrOutput.String())
		t.Skip("--print mode with --input-format stream-json may not support multi-turn")
		return
	}

	// Try to read second response
	var gotSecondResult bool
	var secondAssistantContent string

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var msg map[string]any
		if err := json.Unmarshal(line, &msg); err != nil {
			continue
		}

		messages = append(messages, msg)
		msgType, _ := msg["type"].(string)
		t.Logf("Received message type: %s", msgType)

		if msgType == "assistant" {
			if message, ok := msg["message"].(map[string]any); ok {
				if content, ok := message["content"].([]any); ok {
					for _, block := range content {
						if b, ok := block.(map[string]any); ok {
							if text, ok := b["text"].(string); ok {
								secondAssistantContent = text
							}
						}
					}
				}
			}
		}

		if msgType == "result" {
			gotSecondResult = true
			break
		}
	}

	stdin.Close()
	cmd.Wait()

	t.Logf("Stderr: %s", stderrOutput.String())
	t.Logf("Total messages received: %d", len(messages))

	if gotSecondResult {
		t.Logf("SUCCESS: --print mode with --input-format stream-json supports multi-turn!")
		t.Logf("Second assistant response: %s", secondAssistantContent)
		if strings.Contains(strings.ToLower(secondAssistantContent), "42") {
			t.Log("Claude remembered the number 42!")
		}
	} else {
		t.Log("--print mode with --input-format stream-json does NOT support multi-turn")
		t.Log("This means we need to use bidirectional streaming mode (without --print) for interactive sessions")
	}
}

// TestBidirectionalStreamingMultiTurn tests multi-turn conversation using
// bidirectional streaming mode (--input-format stream-json without --print).
// This is the mode currently used in our SDK for interactive sessions.
func TestBidirectionalStreamingMultiTurn(t *testing.T) {
	skipIfNoCLI(t)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// Bidirectional streaming mode (no --print)
	cmd := exec.CommandContext(ctx, "claude",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--max-turns", "3",
	)

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

	if err := cmd.Start(); err != nil {
		t.Fatalf("Failed to start command: %v", err)
	}

	// Capture stderr in background
	var stderrOutput strings.Builder
	go func() {
		io.Copy(&stderrOutput, stderr)
	}()

	scanner := bufio.NewScanner(stdout)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 1024*1024)

	// Helper to read until result
	readUntilResult := func() ([]map[string]any, error) {
		var msgs []map[string]any
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}

			var msg map[string]any
			if err := json.Unmarshal(line, &msg); err != nil {
				continue
			}

			msgs = append(msgs, msg)
			msgType, _ := msg["type"].(string)

			if msgType == "result" {
				return msgs, nil
			}
		}
		return msgs, fmt.Errorf("no result message received")
	}

	// === Turn 1: Ask Claude to remember a number ===
	firstMsg := `{"type":"user","message":{"role":"user","content":"Remember: the secret number is 42. Just say OK."}}`
	t.Logf("Turn 1: %s", firstMsg)
	if _, err := fmt.Fprintln(stdin, firstMsg); err != nil {
		t.Fatalf("Failed to write first message: %v", err)
	}

	turn1Msgs, err := readUntilResult()
	if err != nil {
		t.Fatalf("Turn 1 failed: %v\nStderr: %s", err, stderrOutput.String())
	}
	t.Logf("Turn 1 received %d messages", len(turn1Msgs))

	// Count stream events in turn 1
	var turn1StreamEvents int
	for _, msg := range turn1Msgs {
		if msg["type"] == "stream_event" {
			turn1StreamEvents++
		}
	}
	t.Logf("Turn 1 stream events: %d", turn1StreamEvents)

	// === Turn 2: Ask Claude what number it remembers ===
	secondMsg := `{"type":"user","message":{"role":"user","content":"What secret number did I tell you?"}}`
	t.Logf("Turn 2: %s", secondMsg)
	if _, err := fmt.Fprintln(stdin, secondMsg); err != nil {
		t.Fatalf("Failed to write second message: %v", err)
	}

	turn2Msgs, err := readUntilResult()
	if err != nil {
		t.Fatalf("Turn 2 failed: %v\nStderr: %s", err, stderrOutput.String())
	}
	t.Logf("Turn 2 received %d messages", len(turn2Msgs))

	// Find assistant response in turn 2
	var turn2Response string
	for _, msg := range turn2Msgs {
		if msg["type"] == "assistant" {
			if message, ok := msg["message"].(map[string]any); ok {
				if content, ok := message["content"].([]any); ok {
					for _, block := range content {
						if b, ok := block.(map[string]any); ok {
							if text, ok := b["text"].(string); ok {
								turn2Response += text
							}
						}
					}
				}
			}
		}
	}

	t.Logf("Turn 2 response: %s", turn2Response)

	// Verify Claude remembered the number
	if strings.Contains(turn2Response, "42") {
		t.Log("SUCCESS: Claude remembered the number 42!")
	} else {
		t.Errorf("Claude did not mention 42 in response: %s", turn2Response)
	}

	// Count stream events in turn 2
	var turn2StreamEvents int
	for _, msg := range turn2Msgs {
		if msg["type"] == "stream_event" {
			turn2StreamEvents++
		}
	}
	t.Logf("Turn 2 stream events: %d", turn2StreamEvents)

	// Verify we got stream events in both turns
	if turn1StreamEvents == 0 {
		t.Error("No stream events in turn 1")
	}
	if turn2StreamEvents == 0 {
		t.Error("No stream events in turn 2")
	}

	stdin.Close()
	cmd.Wait()

	t.Logf("Stderr: %s", stderrOutput.String())
	t.Log("Bidirectional streaming mode supports multi-turn with progressive updates!")
}

// TestStreamEventTiming measures the timing/frequency of stream events
// to understand the granularity of progressive updates.
func TestStreamEventTiming(t *testing.T) {
	skipIfNoCLI(t)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "claude",
		"--print",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--max-turns", "1",
		"Write a haiku about coding",
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("Failed to get stdout pipe: %v", err)
	}

	startTime := time.Now()
	if err := cmd.Start(); err != nil {
		t.Fatalf("Failed to start command: %v", err)
	}

	type timedEvent struct {
		elapsed   time.Duration
		eventType string
		text      string
	}

	var events []timedEvent

	scanner := bufio.NewScanner(stdout)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 1024*1024)

	for scanner.Scan() {
		elapsed := time.Since(startTime)
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var msg map[string]any
		if err := json.Unmarshal(line, &msg); err != nil {
			continue
		}

		msgType, _ := msg["type"].(string)
		if msgType != "stream_event" {
			continue
		}

		event, _ := msg["event"].(map[string]any)
		eventType, _ := event["type"].(string)

		var text string
		if eventType == "content_block_delta" {
			if delta, ok := event["delta"].(map[string]any); ok {
				text, _ = delta["text"].(string)
			}
		}

		events = append(events, timedEvent{
			elapsed:   elapsed,
			eventType: eventType,
			text:      text,
		})
	}

	cmd.Wait()

	t.Logf("Total stream events: %d", len(events))

	// Calculate intervals between deltas
	var deltaEvents []timedEvent
	for _, e := range events {
		if e.eventType == "content_block_delta" {
			deltaEvents = append(deltaEvents, e)
		}
	}

	t.Logf("Text delta events: %d", len(deltaEvents))

	if len(deltaEvents) > 1 {
		var intervals []time.Duration
		for i := 1; i < len(deltaEvents); i++ {
			interval := deltaEvents[i].elapsed - deltaEvents[i-1].elapsed
			intervals = append(intervals, interval)
		}

		var totalInterval time.Duration
		var minInterval, maxInterval time.Duration = intervals[0], intervals[0]
		for _, interval := range intervals {
			totalInterval += interval
			if interval < minInterval {
				minInterval = interval
			}
			if interval > maxInterval {
				maxInterval = interval
			}
		}

		avgInterval := totalInterval / time.Duration(len(intervals))

		t.Logf("Delta timing statistics:")
		t.Logf("  Min interval: %v", minInterval)
		t.Logf("  Max interval: %v", maxInterval)
		t.Logf("  Avg interval: %v", avgInterval)

		// Log first few deltas with timing
		t.Log("First 10 deltas:")
		for i, e := range deltaEvents {
			if i >= 10 {
				break
			}
			t.Logf("  [%v] %q", e.elapsed, e.text)
		}
	}

	// Log all event types in sequence
	t.Log("Event sequence:")
	for _, e := range events {
		if e.text != "" {
			t.Logf("  [%v] %s: %q", e.elapsed, e.eventType, e.text)
		} else {
			t.Logf("  [%v] %s", e.elapsed, e.eventType)
		}
	}
}

// TestMain provides setup for the test suite
func TestMain(m *testing.M) {
	// Check if we should skip all tests
	if os.Getenv("SKIP_INTEGRATION_TESTS") == "1" {
		fmt.Println("Skipping integration tests (SKIP_INTEGRATION_TESTS=1)")
		os.Exit(0)
	}

	os.Exit(m.Run())
}
