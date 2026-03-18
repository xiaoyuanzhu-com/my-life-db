//go:build acptest

package acptest

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// TestACPBasicPrompt verifies the simplest flow: send a prompt, get a response.
// Documents: what events fire, what stop reason is returned, streaming granularity.
func TestACPBasicPrompt(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	stopReason, events := h.Prompt(ctx, "Reply with exactly: hello world")

	// Document stop reason
	t.Logf("Stop reason: %s", stopReason)
	if stopReason != acp.StopReasonEndTurn {
		t.Errorf("expected stop_reason=end_turn, got %s", stopReason)
	}

	// Document event types received
	typeCounts := map[string]int{}
	for _, e := range events {
		typeCounts[e.Type]++
	}
	t.Logf("Event type counts:")
	for typ, count := range typeCounts {
		t.Logf("  %s: %d", typ, count)
	}

	// Verify we got agent message chunks
	if !HasEvent(events, "agent_message") {
		t.Error("expected at least one agent_message event")
	}

	// Document full agent text
	text := AgentText(events)
	t.Logf("Full agent text: %q", text)
	if !strings.Contains(strings.ToLower(text), "hello world") {
		t.Errorf("expected agent text to contain 'hello world', got %q", text)
	}
}

// TestACPThinkingBlocks verifies that thinking/thought content is streamed.
// Documents: whether thoughts come as AgentThoughtChunk, their format.
func TestACPThinkingBlocks(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Ask something that should trigger thinking
	_, events := h.Prompt(ctx, "What is 127 * 389? Think step by step before answering.")

	// Document whether thinking blocks appeared
	thoughts := Events(events, "agent_thought")
	t.Logf("Thought chunks received: %d", len(thoughts))

	if len(thoughts) > 0 {
		thoughtText := ThoughtText(events)
		t.Logf("Full thought text (%d chars): %q", len(thoughtText), truncate(thoughtText, 500))
		t.Logf("FINDING: Thinking blocks ARE streamed as AgentThoughtChunk")
	} else {
		t.Logf("FINDING: No AgentThoughtChunk received — thinking may not be supported or model didn't think")
	}

	// Also check if agent message contains the answer
	text := AgentText(events)
	t.Logf("Agent response: %q", truncate(text, 300))
}

// TestACPToolCallBash verifies tool call flow for bash commands.
// Documents: tool call structure, content format, permission behavior.
func TestACPToolCallBash(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	_, events := h.Prompt(ctx, "Run the command: echo 'acp-test-output'")

	// Document tool calls
	toolCalls := ToolCalls(events)
	t.Logf("Tool calls: %d", len(toolCalls))
	for i, tc := range toolCalls {
		t.Logf("Tool call %d:", i)
		t.Logf("  ID: %s", tc.ToolCall.ToolCallId)
		t.Logf("  Title: %s", tc.ToolCall.Title)
		t.Logf("  Kind: %s", tc.ToolCall.Kind)
		t.Logf("  Status: %s", tc.ToolCall.Status)
		if tc.ToolCall.RawInput != nil {
			t.Logf("  RawInput: %v", tc.ToolCall.RawInput)
		}
		if len(tc.ToolCall.Content) > 0 {
			for j, c := range tc.ToolCall.Content {
				raw, _ := json.Marshal(c)
				t.Logf("  Content[%d]: %s", j, truncate(string(raw), 200))
			}
		}
	}

	// Document tool call updates
	updates := Events(events, "tool_call_update")
	t.Logf("Tool call updates: %d", len(updates))
	for i, u := range updates {
		status := ""
		if u.ToolCallUpdate.Status != nil {
			status = string(*u.ToolCallUpdate.Status)
		}
		t.Logf("Update %d: id=%s status=%s", i, u.ToolCallUpdate.ToolCallId, status)
		if len(u.ToolCallUpdate.Content) > 0 {
			for j, c := range u.ToolCallUpdate.Content {
				raw, _ := json.Marshal(c)
				t.Logf("  Content[%d]: %s", j, truncate(string(raw), 200))
			}
		}
	}

	// Document permissions
	perms := Permissions(events)
	t.Logf("Permission requests: %d", len(perms))
	for i, p := range perms {
		t.Logf("Permission %d:", i)
		if p.Permission.ToolCall.Title != nil {
			t.Logf("  Title: %s", *p.Permission.ToolCall.Title)
		}
		if p.Permission.ToolCall.Kind != nil {
			t.Logf("  Kind: %s", *p.Permission.ToolCall.Kind)
		}
		for j, opt := range p.Permission.Options {
			t.Logf("  Option[%d]: kind=%s name=%q id=%s", j, opt.Kind, opt.Name, opt.OptionId)
		}
	}

	if len(toolCalls) == 0 {
		t.Error("expected at least one tool call for bash command")
	}
}

// TestACPToolCallFileRead verifies the file read callback flow.
// Documents: whether ReadTextFile is called, path format, line/limit params.
func TestACPToolCallFileRead(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	// Create a test file
	testFile := filepath.Join(h.Client().t.TempDir(), "test-read.txt")
	// Use the session's CWD for the file
	dir := t.TempDir()
	testFile = filepath.Join(dir, "test-read.txt")
	os.WriteFile(testFile, []byte("line1\nline2\nline3\n"), 0644)

	h2 := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute), WithCwd(dir))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	_ = h // unused, use h2 with correct cwd
	_, events := h2.Prompt(ctx, "Read the file test-read.txt and tell me what's in it.")

	// Document file read callbacks
	reads := Events(events, "read_file")
	t.Logf("ReadTextFile callbacks: %d", len(reads))
	for i, r := range reads {
		t.Logf("Read %d: path=%s line=%v limit=%v", i, r.ReadFile.Path, r.ReadFile.Line, r.ReadFile.Limit)
	}

	// Check agent response mentions the file content
	text := AgentText(events)
	t.Logf("Agent response: %q", truncate(text, 300))
}

// TestACPToolCallFileWrite verifies the file write callback flow.
// Documents: whether WriteTextFile is called, path format.
func TestACPToolCallFileWrite(t *testing.T) {
	dir := t.TempDir()
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute), WithCwd(dir))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	_, events := h.Prompt(ctx, "Create a file called hello.txt with the content 'hello from acp test'")

	// Document file write callbacks
	writes := Events(events, "write_file")
	t.Logf("WriteTextFile callbacks: %d", len(writes))
	for i, w := range writes {
		t.Logf("Write %d: path=%s content_len=%d", i, w.WriteFile.Path, len(w.WriteFile.Content))
		t.Logf("  Content: %q", truncate(w.WriteFile.Content, 200))
	}

	// Verify file was actually created
	expectedPath := filepath.Join(dir, "hello.txt")
	if content, err := os.ReadFile(expectedPath); err == nil {
		t.Logf("File created at %s: %q", expectedPath, string(content))
	} else {
		t.Logf("File NOT found at %s: %v", expectedPath, err)
		// Check if it was written elsewhere
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			t.Logf("  dir entry: %s", e.Name())
		}
	}
}

// TestACPPermissionOptions verifies the permission option structure.
// Documents: what kinds are offered, option IDs, names.
func TestACPPermissionOptions(t *testing.T) {
	// Don't auto-approve — we want to inspect permission options
	dir := t.TempDir()
	h := NewHarness(t, WithTimeout(3*time.Minute), WithCwd(dir))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Set auto-approve so we don't hang, but record first
	h.Client().autoApprove = true

	_, events := h.Prompt(ctx, "Run: echo 'permission-test'")

	perms := Permissions(events)
	if len(perms) == 0 {
		t.Log("FINDING: No permission requests received — agent may auto-approve in this mode")
		return
	}

	for i, p := range perms {
		t.Logf("Permission request %d:", i)
		t.Logf("  ToolCallId: %s", p.Permission.ToolCall.ToolCallId)
		if p.Permission.ToolCall.Title != nil {
			t.Logf("  Title: %s", *p.Permission.ToolCall.Title)
		}
		if p.Permission.ToolCall.Kind != nil {
			t.Logf("  Kind: %s", *p.Permission.ToolCall.Kind)
		}
		t.Logf("  Options (%d):", len(p.Permission.Options))
		for j, opt := range p.Permission.Options {
			t.Logf("    [%d] kind=%s name=%q id=%s",
				j, opt.Kind, opt.Name, opt.OptionId)
		}

		// Document which kinds are available
		kinds := map[acp.PermissionOptionKind]bool{}
		for _, opt := range p.Permission.Options {
			kinds[opt.Kind] = true
		}
		t.Logf("  Available kinds: %v", kinds)
		t.Logf("  Has allow_once: %v", kinds[acp.PermissionOptionKindAllowOnce])
		t.Logf("  Has allow_always: %v", kinds[acp.PermissionOptionKindAllowAlways])
		t.Logf("  Has reject_once: %v", kinds[acp.PermissionOptionKindRejectOnce])
		t.Logf("  Has reject_always: %v", kinds[acp.PermissionOptionKindRejectAlways])
	}
}

// TestACPSessionModes verifies what session modes are available.
// Documents: available modes, their IDs and names.
func TestACPSessionModes(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	// Modes are returned in NewSession response — already logged by harness
	// Also test SetSessionMode if modes are available

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Try a simple prompt to ensure the session works
	stopReason, _ := h.Prompt(ctx, "Say 'mode test ok'")
	t.Logf("Prompt completed with stop_reason=%s", stopReason)

	// The harness already logs modes in NewHarness. This test exists to
	// make the mode information easily findable in test output.
}

// TestACPStreamingGranularity verifies how granular the streaming updates are.
// Documents: chunk sizes, frequency, whether per-token or batched.
func TestACPStreamingGranularity(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	_, events := h.Prompt(ctx, "Write a haiku about programming. Just the haiku, nothing else.")

	chunks := Events(events, "agent_message")
	t.Logf("Total agent_message chunks: %d", len(chunks))

	if len(chunks) > 0 {
		// Analyze chunk sizes
		var sizes []int
		for _, c := range chunks {
			if c.AgentMessageChunk != nil && c.AgentMessageChunk.Content.Text != nil {
				size := len(c.AgentMessageChunk.Content.Text.Text)
				sizes = append(sizes, size)
			}
		}

		t.Logf("Chunk sizes: %v", sizes)

		total := 0
		for _, s := range sizes {
			total += s
		}
		if len(sizes) > 0 {
			avg := total / len(sizes)
			t.Logf("Average chunk size: %d bytes", avg)
			t.Logf("Total text: %d bytes across %d chunks", total, len(sizes))

			if avg <= 10 {
				t.Logf("FINDING: Streaming is per-token (very granular)")
			} else if avg <= 100 {
				t.Logf("FINDING: Streaming is batched (moderate granularity)")
			} else {
				t.Logf("FINDING: Streaming is coarse (large chunks)")
			}
		}
	}
}

// TestACPMultiTurnConversation verifies that multiple prompts maintain context.
// Documents: whether conversation history is preserved across turns.
func TestACPMultiTurnConversation(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// First turn: establish context
	h.Prompt(ctx, "Remember this number: 42. Just acknowledge.")

	// Second turn: verify context
	_, events := h.Prompt(ctx, "What number did I ask you to remember?")

	text := AgentText(events)
	t.Logf("Agent response: %q", truncate(text, 300))

	if strings.Contains(text, "42") {
		t.Logf("FINDING: Multi-turn context IS preserved")
	} else {
		t.Logf("FINDING: Multi-turn context may NOT be preserved")
	}
}

// TestACPCancelDuringPrompt verifies cancellation behavior.
// Documents: how cancel works, what stop reason is returned.
func TestACPCancelDuringPrompt(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Start a prompt that will take a while
	h.client.resetEvents()

	promptCtx, promptCancel := context.WithCancel(ctx)

	var stopReason acp.StopReason
	var promptErr error
	done := make(chan struct{})

	go func() {
		defer close(done)
		var resp acp.PromptResponse
		resp, promptErr = h.conn.Prompt(promptCtx, acp.PromptRequest{
			SessionId: h.sessionID,
			Prompt:    []acp.ContentBlock{acp.TextBlock("Write a very long essay about the history of computing. Make it at least 2000 words.")},
		})
		if promptErr == nil {
			stopReason = resp.StopReason
		}
	}()

	// Wait a bit then cancel
	time.Sleep(3 * time.Second)
	t.Logf("Cancelling prompt...")
	promptCancel()

	<-done

	t.Logf("Prompt result: stopReason=%s err=%v", stopReason, promptErr)

	events := h.client.getEvents()
	t.Logf("Events before cancel: %d", len(events))

	if stopReason == acp.StopReasonCancelled {
		t.Logf("FINDING: Cancel returns StopReason=cancelled")
	} else if promptErr != nil {
		t.Logf("FINDING: Cancel returns error: %v", promptErr)
	} else {
		t.Logf("FINDING: Cancel returned stopReason=%s (prompt may have finished before cancel)", stopReason)
	}
}

// TestACPProcessExit verifies behavior when the agent process exits.
// Documents: what happens to conn.Done(), pending calls, etc.
func TestACPProcessExit(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	// Kill the process
	t.Logf("Killing agent process...")
	h.cmd.Process.Kill()

	// Wait for Done channel
	select {
	case <-h.conn.Done():
		t.Logf("FINDING: conn.Done() closed after process exit")
	case <-time.After(5 * time.Second):
		t.Logf("FINDING: conn.Done() did NOT close within 5s")
	}
}

// TestACPEventOrder verifies the ordering of events during a prompt.
// Documents: do tool_call events always come before agent_message? etc.
func TestACPEventOrder(t *testing.T) {
	h := NewHarness(t, WithAutoApprove(), WithTimeout(3*time.Minute))

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// A prompt that should cause tool use then a response
	_, events := h.Prompt(ctx, "What files are in the current directory? List them.")

	t.Logf("Event order:")
	for i, e := range events {
		detail := ""
		switch e.Type {
		case "agent_message":
			if e.AgentMessageChunk != nil && e.AgentMessageChunk.Content.Text != nil {
				detail = truncate(e.AgentMessageChunk.Content.Text.Text, 50)
			}
		case "tool_call":
			if e.ToolCall != nil {
				detail = e.ToolCall.Title
			}
		case "tool_call_update":
			if e.ToolCallUpdate != nil {
				status := ""
				if e.ToolCallUpdate.Status != nil {
					status = string(*e.ToolCallUpdate.Status)
				}
				detail = string(e.ToolCallUpdate.ToolCallId) + " status=" + status
			}
		}
		t.Logf("  [%d] %s: %s", i, e.Type, detail)
	}
}
