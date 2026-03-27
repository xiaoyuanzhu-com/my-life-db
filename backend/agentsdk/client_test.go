package agentsdk

import (
	"context"
	"errors"
	"testing"
)

func TestClient_AvailableAgents(t *testing.T) {
	client := NewClient(
		SessionConfig{},
		AgentConfig{Type: AgentClaudeCode, Name: "Claude Code", Command: "claude-agent-acp"},
		AgentConfig{Type: AgentCodex, Name: "Codex", Command: "codex"},
	)

	agents := client.AvailableAgents()
	if len(agents) != 2 {
		t.Fatalf("AvailableAgents() returned %d agents, want 2", len(agents))
	}

	names := map[string]bool{}
	for _, a := range agents {
		names[a.Name] = true
	}
	if !names["Claude Code"] {
		t.Error("missing Claude Code agent")
	}
	if !names["Codex"] {
		t.Error("missing Codex agent")
	}
}

func TestClient_MergeEnv(t *testing.T) {
	defaults := SessionConfig{
		Env: map[string]string{
			"ANTHROPIC_BASE_URL": "http://localhost:8080/api/anthropic",
			"MLD_PROXY_TOKEN":    "token123",
		},
	}
	client := NewClient(defaults,
		AgentConfig{Type: AgentClaudeCode, Name: "Claude Code", Command: "claude-agent-acp"},
	)

	merged := client.MergeEnv(SessionConfig{
		Agent: AgentClaudeCode,
		Env:   map[string]string{"EXTRA": "value"},
	})

	if merged["ANTHROPIC_BASE_URL"] != "http://localhost:8080/api/anthropic" {
		t.Errorf("missing default ANTHROPIC_BASE_URL, got %q", merged["ANTHROPIC_BASE_URL"])
	}
	if merged["MLD_PROXY_TOKEN"] != "token123" {
		t.Errorf("missing default MLD_PROXY_TOKEN, got %q", merged["MLD_PROXY_TOKEN"])
	}
	if merged["EXTRA"] != "value" {
		t.Errorf("missing per-call EXTRA, got %q", merged["EXTRA"])
	}
}

func TestClient_MergeEnv_PerCallOverrides(t *testing.T) {
	defaults := SessionConfig{Env: map[string]string{"KEY": "default"}}
	client := NewClient(defaults,
		AgentConfig{Type: AgentClaudeCode, Name: "Claude Code", Command: "claude-agent-acp"},
	)

	merged := client.MergeEnv(SessionConfig{
		Agent: AgentClaudeCode,
		Env:   map[string]string{"KEY": "override"},
	})

	if merged["KEY"] != "override" {
		t.Errorf("KEY = %q, want %q", merged["KEY"], "override")
	}
}

func TestClient_MergeEnv_NilEnvs(t *testing.T) {
	client := NewClient(SessionConfig{})

	merged := client.MergeEnv(SessionConfig{})
	if len(merged) != 0 {
		t.Errorf("expected empty map, got %d entries", len(merged))
	}
}

func TestClient_UnknownAgent_ReturnsError(t *testing.T) {
	client := NewClient(SessionConfig{},
		AgentConfig{Type: AgentClaudeCode, Name: "Claude Code", Command: "claude-agent-acp"},
	)

	_, err := client.CreateSession(context.Background(), SessionConfig{Agent: AgentCodex})
	if err == nil {
		t.Fatal("expected error for unknown agent, got nil")
	}

	var agentErr *AgentError
	if !errors.As(err, &agentErr) {
		t.Fatalf("expected *AgentError, got %T", err)
	}
	if agentErr.Type != ErrNotFound {
		t.Errorf("error type = %q, want %q", agentErr.Type, ErrNotFound)
	}
}

func TestClient_SetProxyBaseURL(t *testing.T) {
	client := NewClient(SessionConfig{})
	client.SetProxyBaseURL("http://localhost:8080")
	if client.proxyBaseURL != "http://localhost:8080" {
		t.Errorf("proxyBaseURL = %q, want http://localhost:8080", client.proxyBaseURL)
	}
}

func TestAgentError_Format(t *testing.T) {
	err := &AgentError{
		Type:    ErrAgentCrash,
		Agent:   AgentClaudeCode,
		Message: "process exited",
	}

	want := "agent claude_code: agent_crash: process exited"
	if err.Error() != want {
		t.Errorf("Error() = %q, want %q", err.Error(), want)
	}
}

func TestAgentError_Unwrap(t *testing.T) {
	cause := errors.New("underlying error")
	err := &AgentError{
		Type:  ErrAgentCrash,
		Cause: cause,
	}

	if !errors.Is(err, cause) {
		t.Error("Unwrap() did not return cause")
	}
}
