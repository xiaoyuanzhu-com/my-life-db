//go:build acptest

package acptest

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
)

// TestClientCreateSession tests the full agentsdk.Client → ACP flow.
// This verifies our wrapper works end-to-end.
func TestClientCreateSession(t *testing.T) {
	skipIfNoPrereqs(t)

	client := agentsdk.NewClient(
		agentsdk.SessionConfig{},
		agentsdk.AgentConfig{
			Type:    agentsdk.AgentClaudeCode,
			Name:    "Claude Code",
			Command: "claude-agent-acp",
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	session, err := client.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:       agentsdk.AgentClaudeCode,
		Permissions: agentsdk.PermissionAuto,
		WorkingDir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	defer session.Close()

	t.Logf("Session created: id=%s agent=%s", session.ID(), session.AgentType())

	if session.ID() == "" {
		t.Error("session ID is empty")
	}
	if session.AgentType() != agentsdk.AgentClaudeCode {
		t.Errorf("agent type = %s, want claude_code", session.AgentType())
	}
}

// TestClientSendPrompt tests sending a prompt through the full stack.
func TestClientSendPrompt(t *testing.T) {
	skipIfNoPrereqs(t)

	client := agentsdk.NewClient(
		agentsdk.SessionConfig{},
		agentsdk.AgentConfig{
			Type:    agentsdk.AgentClaudeCode,
			Name:    "Claude Code",
			Command: "claude-agent-acp",
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	session, err := client.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:       agentsdk.AgentClaudeCode,
		Permissions: agentsdk.PermissionAuto,
		WorkingDir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	defer session.Close()

	// Send a prompt
	events, err := session.Send(ctx, "Reply with exactly: integration test ok")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	// Collect raw frames — parse each to inspect
	var allFrames [][]byte
	var fullText string
	for frame := range events {
		allFrames = append(allFrames, frame)
		var msg map[string]any
		if err := json.Unmarshal(frame, &msg); err != nil {
			t.Logf("[frame] unparseable: %s", truncateStr(string(frame), 200))
			continue
		}

		switch {
		case msg["sessionUpdate"] == "agent_message_chunk":
			// Extract text from content.text.text
			if content, ok := msg["content"].(map[string]any); ok {
				if textObj, ok := content["text"].(map[string]any); ok {
					if text, ok := textObj["text"].(string); ok {
						fullText += text
						t.Logf("[agent_message_chunk] %q", truncateStr(text, 100))
					}
				}
			}
		case msg["type"] == "turn.complete":
			t.Logf("[turn.complete] stopReason=%v", msg["stopReason"])
		case msg["type"] == "error":
			t.Fatalf("[error] %v: %v", msg["code"], msg["message"])
		case msg["type"] == "permission.request":
			t.Logf("[permission.request]")
		default:
			t.Logf("[frame] %s", truncateStr(string(frame), 200))
		}
	}

	t.Logf("Full text: %q", fullText)
	t.Logf("Total frames: %d", len(allFrames))

	if !strings.Contains(strings.ToLower(fullText), "integration test ok") {
		t.Errorf("expected response to contain 'integration test ok', got %q", fullText)
	}

	// Verify we got a turn.complete frame
	hasComplete := false
	for _, frame := range allFrames {
		var msg map[string]any
		if json.Unmarshal(frame, &msg) == nil && msg["type"] == "turn.complete" {
			hasComplete = true
			break
		}
	}
	if !hasComplete {
		t.Error("expected turn.complete frame")
	}
}

// TestClientRunTask tests the one-off task flow.
func TestClientRunTask(t *testing.T) {
	skipIfNoPrereqs(t)

	client := agentsdk.NewClient(
		agentsdk.SessionConfig{},
		agentsdk.AgentConfig{
			Type:    agentsdk.AgentClaudeCode,
			Name:    "Claude Code",
			Command: "claude-agent-acp",
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	result, err := client.RunTask(ctx, agentsdk.TaskConfig{
		SessionConfig: agentsdk.SessionConfig{
			Agent:       agentsdk.AgentClaudeCode,
			Permissions: agentsdk.PermissionAuto,
			WorkingDir:  t.TempDir(),
		},
		Prompt:  "Reply with exactly: task complete",
		Timeout: 90 * time.Second,
	})
	if err != nil {
		t.Fatalf("RunTask: %v", err)
	}

	t.Logf("Task result: sessionID=%s messages=%d", result.SessionID, len(result.Messages))

	if result.SessionID == "" {
		t.Error("session ID is empty")
	}
}

// TestClientMultiTurn tests multi-turn conversation through our wrapper.
func TestClientMultiTurn(t *testing.T) {
	skipIfNoPrereqs(t)

	client := agentsdk.NewClient(
		agentsdk.SessionConfig{},
		agentsdk.AgentConfig{
			Type:    agentsdk.AgentClaudeCode,
			Name:    "Claude Code",
			Command: "claude-agent-acp",
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	session, err := client.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:       agentsdk.AgentClaudeCode,
		Permissions: agentsdk.PermissionAuto,
		WorkingDir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	defer session.Close()

	// Turn 1
	events1, _ := session.Send(ctx, "Remember: the code is 7734. Just acknowledge.")
	for range events1 {
	} // drain

	// Turn 2
	events2, _ := session.Send(ctx, "What code did I tell you?")
	var text string
	for frame := range events2 {
		var msg map[string]any
		if json.Unmarshal(frame, &msg) == nil && msg["sessionUpdate"] == "agent_message_chunk" {
			if content, ok := msg["content"].(map[string]any); ok {
				if textObj, ok := content["text"].(map[string]any); ok {
					if t2, ok := textObj["text"].(string); ok {
						text += t2
					}
				}
			}
		}
	}

	t.Logf("Turn 2 response: %q", text)
	if strings.Contains(text, "7734") {
		t.Log("PASS: Multi-turn context preserved through our wrapper")
	} else {
		t.Error("Multi-turn context lost")
	}
}

// TestClientShutdown tests graceful shutdown.
func TestClientShutdown(t *testing.T) {
	skipIfNoPrereqs(t)

	client := agentsdk.NewClient(
		agentsdk.SessionConfig{},
		agentsdk.AgentConfig{
			Type:    agentsdk.AgentClaudeCode,
			Name:    "Claude Code",
			Command: "claude-agent-acp",
		},
	)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	session, err := client.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:       agentsdk.AgentClaudeCode,
		Permissions: agentsdk.PermissionAuto,
		WorkingDir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	t.Logf("Session active: %s", session.ID())

	// Shutdown should close all sessions
	shutdownCtx, shutdownCancel := context.WithTimeout(ctx, 10*time.Second)
	defer shutdownCancel()

	err = client.Shutdown(shutdownCtx)
	if err != nil {
		t.Errorf("Shutdown error: %v", err)
	}

	t.Log("Shutdown completed")
}

func skipIfNoPrereqs(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("claude-agent-acp"); err != nil {
		t.Skip("claude-agent-acp not found in PATH")
	}

	authCmd := exec.Command("claude", "auth", "status")
	if authOut, err := authCmd.Output(); err != nil || !strings.Contains(string(authOut), `"loggedIn": true`) {
		t.Skip("Claude CLI not authenticated")
	}
}

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
