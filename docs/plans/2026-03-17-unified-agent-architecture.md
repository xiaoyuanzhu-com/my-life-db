# Unified Agent Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace fragmented AI integrations (Claude Code WebSocket wrapper, Inbox Agent agentic loop, OpenAI Summarize) with a three-layer architecture: LLM proxy, Unified Agent SDK, and agent-agnostic features.

**Architecture:** Three layers — (1) LLM Layer: reverse-proxy routes on the Gin server that inject credentials and forward to upstream providers, speaking both Anthropic and OpenAI protocols natively; (2) Unified Agent SDK: a Go `agent.Client` with per-CLI adapters (Claude Code first, Codex later) that spawn and manage CLI processes; (3) Features that consume the SDK without knowing which agent runs underneath.

**Tech Stack:** Go 1.25, Gin, SQLite (mattn/go-sqlite3), React 19, TypeScript, TanStack Query, WebSocket

**Design Docs:**
- [agent-interface-design.md](2026-03-17-agent-interface-design.md) — SDK interface spec
- [unified-agent-architecture-design.md](2026-03-17-unified-agent-architecture-design.md) — Architecture design

---

## Phase Overview

| Phase | What | Shippable? |
|-------|------|------------|
| 1 | LLM Layer (proxy routes) | Yes — existing features still work, proxy is additive |
| 2 | Agent SDK core types + Claude Code adapter | Yes — internal library, no external changes |
| 3 | Session storage migration | Yes — DB migration, backward compatible |
| 4 | Backend API migration (`/api/agent/*`) | Yes — new routes alongside old ones |
| 5 | Frontend migration | Yes — switch to new routes + agent selector |
| 6 | Inbox migration | Yes — rewrite to use agent SDK |
| 7 | Summarize migration | Yes — use LLM proxy directly |
| 8 | Cleanup | Yes — remove deprecated code/routes/env vars |

Each phase is independently deployable. Phases 1-3 can run in parallel. Phases 4-5 depend on 2-3. Phase 6-7 depend on 2. Phase 8 is last.

---

## Phase 1: LLM Layer (Proxy Routes)

### Task 1.1: LLM Config Types

**Files:**
- Create: `backend/llm/config.go`
- Test: `backend/llm/config_test.go`

**Context:** The LLM layer needs configuration for upstream providers. Cloud mode uses managed keys; self-hosted mode uses user-provided keys or skips the proxy entirely.

**Step 1: Write the failing test**

```go
// backend/llm/config_test.go
package llm

import "testing"

func TestNewConfig_FromEnv(t *testing.T) {
	t.Setenv("MLD_LLM_ANTHROPIC_KEY", "sk-ant-test")
	t.Setenv("MLD_LLM_ANTHROPIC_URL", "https://api.anthropic.com")
	t.Setenv("MLD_LLM_OPENAI_KEY", "sk-openai-test")
	t.Setenv("MLD_LLM_OPENAI_URL", "https://api.openai.com")

	cfg := NewConfigFromEnv()

	if cfg.Anthropic.APIKey != "sk-ant-test" {
		t.Errorf("expected anthropic key 'sk-ant-test', got %q", cfg.Anthropic.APIKey)
	}
	if cfg.Anthropic.BaseURL != "https://api.anthropic.com" {
		t.Errorf("expected anthropic URL, got %q", cfg.Anthropic.BaseURL)
	}
	if cfg.OpenAI.APIKey != "sk-openai-test" {
		t.Errorf("expected openai key, got %q", cfg.OpenAI.APIKey)
	}
	if !cfg.HasAnthropic() {
		t.Error("expected HasAnthropic() = true")
	}
	if !cfg.HasOpenAI() {
		t.Error("expected HasOpenAI() = true")
	}
}

func TestNewConfig_Empty(t *testing.T) {
	cfg := NewConfigFromEnv()

	if cfg.HasAnthropic() {
		t.Error("expected HasAnthropic() = false with no env")
	}
	if cfg.HasOpenAI() {
		t.Error("expected HasOpenAI() = false with no env")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test -v ./llm/ -run TestNewConfig`
Expected: FAIL — package does not exist

**Step 3: Write minimal implementation**

```go
// backend/llm/config.go
package llm

import "os"

// ProviderConfig holds credentials for a single LLM provider.
type ProviderConfig struct {
	APIKey  string
	BaseURL string
}

// Config holds LLM proxy configuration for all providers.
type Config struct {
	Anthropic ProviderConfig
	OpenAI    ProviderConfig
}

// NewConfigFromEnv loads LLM config from environment variables.
func NewConfigFromEnv() Config {
	return Config{
		Anthropic: ProviderConfig{
			APIKey:  os.Getenv("MLD_LLM_ANTHROPIC_KEY"),
			BaseURL: getEnvDefault("MLD_LLM_ANTHROPIC_URL", "https://api.anthropic.com"),
		},
		OpenAI: ProviderConfig{
			APIKey:  os.Getenv("MLD_LLM_OPENAI_KEY"),
			BaseURL: getEnvDefault("MLD_LLM_OPENAI_URL", "https://api.openai.com"),
		},
	}
}

func (c Config) HasAnthropic() bool { return c.Anthropic.APIKey != "" }
func (c Config) HasOpenAI() bool    { return c.OpenAI.APIKey != "" }

func getEnvDefault(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && go test -v ./llm/ -run TestNewConfig`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/llm/
git commit -m "feat(llm): add LLM proxy config types"
```

---

### Task 1.2: Anthropic Proxy Route

**Files:**
- Create: `backend/llm/proxy.go`
- Create: `backend/llm/proxy_test.go`

**Context:** The proxy must forward Anthropic API requests as-is, injecting the real API key. Claude Code sets `ANTHROPIC_BASE_URL` to point here. The proxy is a transparent reverse proxy — no format translation.

**Step 1: Write the failing test**

```go
// backend/llm/proxy_test.go
package llm

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnthropicProxy_InjectsAPIKey(t *testing.T) {
	// Mock upstream Anthropic API
	var receivedAuthHeader string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuthHeader = r.Header.Get("x-api-key")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"msg_123","type":"message","content":[{"type":"text","text":"hello"}]}`))
	}))
	defer upstream.Close()

	cfg := Config{
		Anthropic: ProviderConfig{
			APIKey:  "sk-ant-real-key",
			BaseURL: upstream.URL,
		},
	}

	proxy := NewProxy(cfg)
	handler := proxy.AnthropicHandler()

	// Simulate agent request (with dummy key)
	body := `{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", "dummy")
	req.Header.Set("anthropic-version", "2023-06-01")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if receivedAuthHeader != "sk-ant-real-key" {
		t.Errorf("expected upstream to receive real key, got %q", receivedAuthHeader)
	}

	respBody, _ := io.ReadAll(rec.Body)
	if !strings.Contains(string(respBody), "msg_123") {
		t.Errorf("expected response to be forwarded, got %q", string(respBody))
	}
}

func TestAnthropicProxy_NoKey_Returns503(t *testing.T) {
	cfg := Config{} // no anthropic key
	proxy := NewProxy(cfg)
	handler := proxy.AnthropicHandler()

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", rec.Code)
	}
}

func TestAnthropicProxy_Upstream429_ForwardsError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"type":"rate_limit_error","message":"quota exceeded"}}`))
	}))
	defer upstream.Close()

	cfg := Config{
		Anthropic: ProviderConfig{APIKey: "sk-ant-key", BaseURL: upstream.URL},
	}
	proxy := NewProxy(cfg)
	handler := proxy.AnthropicHandler()

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", rec.Code)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test -v ./llm/ -run TestAnthropicProxy`
Expected: FAIL — `NewProxy` and `AnthropicHandler` not defined

**Step 3: Write minimal implementation**

```go
// backend/llm/proxy.go
package llm

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/user/mylifedb/log"
)

// Proxy is a reverse proxy that injects LLM provider credentials.
type Proxy struct {
	cfg Config
}

// NewProxy creates a new LLM proxy with the given config.
func NewProxy(cfg Config) *Proxy {
	return &Proxy{cfg: cfg}
}

// AnthropicHandler returns an http.Handler that proxies Anthropic API requests.
// It strips the /api/anthropic prefix and forwards to the configured upstream URL.
// The real API key is injected into the x-api-key header.
func (p *Proxy) AnthropicHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !p.cfg.HasAnthropic() {
			http.Error(w, `{"error":{"type":"configuration_error","message":"Anthropic API key not configured"}}`, http.StatusServiceUnavailable)
			return
		}

		upstream, err := url.Parse(p.cfg.Anthropic.BaseURL)
		if err != nil {
			http.Error(w, `{"error":{"type":"proxy_error","message":"invalid upstream URL"}}`, http.StatusInternalServerError)
			return
		}

		proxy := &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL.Scheme = upstream.Scheme
				req.URL.Host = upstream.Host
				// Strip /api/anthropic prefix: /api/anthropic/v1/messages → /v1/messages
				req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api/anthropic")
				req.Host = upstream.Host

				// Inject real API key
				req.Header.Set("x-api-key", p.cfg.Anthropic.APIKey)

				log.Info().
					Str("method", req.Method).
					Str("path", req.URL.Path).
					Str("upstream", upstream.Host).
					Msg("llm proxy: anthropic request")
			},
		}

		proxy.ServeHTTP(w, r)
	})
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && go test -v ./llm/ -run TestAnthropicProxy`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/llm/proxy.go backend/llm/proxy_test.go
git commit -m "feat(llm): add Anthropic reverse proxy with credential injection"
```

---

### Task 1.3: OpenAI Proxy Route

**Files:**
- Modify: `backend/llm/proxy.go`
- Modify: `backend/llm/proxy_test.go`

**Context:** Same pattern as Anthropic, but for OpenAI format. Codex sets `OPENAI_BASE_URL` to point here. Injects `Authorization: Bearer <key>`.

**Step 1: Write the failing test**

```go
// Add to backend/llm/proxy_test.go

func TestOpenAIProxy_InjectsBearer(t *testing.T) {
	var receivedAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"chatcmpl-123","choices":[{"message":{"content":"hello"}}]}`))
	}))
	defer upstream.Close()

	cfg := Config{
		OpenAI: ProviderConfig{APIKey: "sk-openai-real", BaseURL: upstream.URL},
	}
	proxy := NewProxy(cfg)
	handler := proxy.OpenAIHandler()

	body := `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest("POST", "/api/openai/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer dummy")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if receivedAuth != "Bearer sk-openai-real" {
		t.Errorf("expected Bearer with real key, got %q", receivedAuth)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test -v ./llm/ -run TestOpenAIProxy`
Expected: FAIL — `OpenAIHandler` not defined

**Step 3: Write minimal implementation**

Add to `backend/llm/proxy.go`:

```go
// OpenAIHandler returns an http.Handler that proxies OpenAI API requests.
// It strips the /api/openai prefix and forwards to the configured upstream URL.
// The real API key is injected into the Authorization header.
func (p *Proxy) OpenAIHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !p.cfg.HasOpenAI() {
			http.Error(w, `{"error":{"message":"OpenAI API key not configured","type":"configuration_error"}}`, http.StatusServiceUnavailable)
			return
		}

		upstream, err := url.Parse(p.cfg.OpenAI.BaseURL)
		if err != nil {
			http.Error(w, `{"error":{"message":"invalid upstream URL","type":"proxy_error"}}`, http.StatusInternalServerError)
			return
		}

		proxy := &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL.Scheme = upstream.Scheme
				req.URL.Host = upstream.Host
				// Strip /api/openai prefix: /api/openai/v1/chat/completions → /v1/chat/completions
				req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api/openai")
				req.Host = upstream.Host

				// Inject real API key
				req.Header.Set("Authorization", "Bearer "+p.cfg.OpenAI.APIKey)

				log.Info().
					Str("method", req.Method).
					Str("path", req.URL.Path).
					Str("upstream", upstream.Host).
					Msg("llm proxy: openai request")
			},
		}

		proxy.ServeHTTP(w, r)
	})
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && go test -v ./llm/ -run TestOpenAIProxy`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/llm/proxy.go backend/llm/proxy_test.go
git commit -m "feat(llm): add OpenAI reverse proxy with credential injection"
```

---

### Task 1.4: Models Endpoint

**Files:**
- Modify: `backend/llm/proxy.go`
- Modify: `backend/llm/proxy_test.go`

**Context:** A unified `/api/llm/v1/models` endpoint that returns available models from configured providers.

**Step 1: Write the failing test**

```go
// Add to backend/llm/proxy_test.go

func TestModelsEndpoint_ListsProviders(t *testing.T) {
	cfg := Config{
		Anthropic: ProviderConfig{APIKey: "sk-ant"},
		OpenAI:    ProviderConfig{APIKey: "sk-oai"},
	}
	proxy := NewProxy(cfg)
	handler := proxy.ModelsHandler()

	req := httptest.NewRequest("GET", "/api/llm/v1/models", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "anthropic") {
		t.Error("expected anthropic in models response")
	}
	if !strings.Contains(body, "openai") {
		t.Error("expected openai in models response")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test -v ./llm/ -run TestModelsEndpoint`
Expected: FAIL — `ModelsHandler` not defined

**Step 3: Write minimal implementation**

```go
// Add to backend/llm/proxy.go
import "encoding/json"

type modelInfo struct {
	ID       string `json:"id"`
	Provider string `json:"provider"`
}

type modelsResponse struct {
	Data []modelInfo `json:"data"`
}

// ModelsHandler returns an http.Handler that lists available LLM providers.
func (p *Proxy) ModelsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var models []modelInfo
		if p.cfg.HasAnthropic() {
			models = append(models, modelInfo{ID: "anthropic", Provider: "anthropic"})
		}
		if p.cfg.HasOpenAI() {
			models = append(models, modelInfo{ID: "openai", Provider: "openai"})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(modelsResponse{Data: models})
	})
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && go test -v ./llm/ -run TestModelsEndpoint`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/llm/
git commit -m "feat(llm): add models endpoint listing configured providers"
```

---

### Task 1.5: Register Proxy Routes on Gin Server

**Files:**
- Modify: `backend/server/server.go` — add `llmProxy *llm.Proxy` field
- Modify: `backend/server/config.go` — add LLM config
- Modify: `backend/api/routes.go` — register proxy routes

**Context:** Wire the proxy into the existing server. The proxy routes are registered as catch-all routes on the Gin server. They skip authentication middleware (they're localhost-only, called by agent CLI processes).

**Step 1: Add LLM config to server config**

In `backend/server/config.go`, add:
```go
import "github.com/user/mylifedb/llm"

// Add to Config struct:
LLM llm.Config
```

**Step 2: Initialize proxy in server.New()**

In `backend/server/server.go`, add field `llmProxy *llm.Proxy` and initialize it:
```go
s.llmProxy = llm.NewProxy(cfg.LLM)
```

Add accessor:
```go
func (s *Server) LLMProxy() *llm.Proxy { return s.llmProxy }
```

**Step 3: Register routes in api/routes.go**

```go
// LLM Proxy routes (no auth — internal use by agent CLIs on localhost)
router.Any("/api/anthropic/*path", gin.WrapH(handlers.server.LLMProxy().AnthropicHandler()))
router.Any("/api/openai/*path", gin.WrapH(handlers.server.LLMProxy().OpenAIHandler()))
router.GET("/api/llm/v1/models", gin.WrapH(handlers.server.LLMProxy().ModelsHandler()))
```

**Step 4: Update config loading in main.go or config.Get()**

Load `MLD_LLM_*` env vars into the server config:
```go
cfg.LLM = llm.NewConfigFromEnv()
```

**Step 5: Test manually**

Run: `cd backend && go build .`
Expected: compiles successfully

**Step 6: Commit**

```bash
git add backend/server/ backend/api/routes.go backend/main.go
git commit -m "feat(llm): register LLM proxy routes on Gin server"
```

---

## Phase 2: Agent SDK Core Types + Claude Code Adapter

### Task 2.1: Agent SDK Core Types

**Files:**
- Create: `backend/agentsdk/types.go`
- Create: `backend/agentsdk/errors.go`

**Context:** Define the core types from the agent interface design doc. These are the foundation everything else builds on. Using `agentsdk` package name to avoid collision with existing `backend/agent/` package.

**Step 1: Write types**

```go
// backend/agentsdk/types.go
package agentsdk

import (
	"context"
	"encoding/json"
	"time"
)

// AgentType identifies which agent CLI to use.
type AgentType string

const (
	AgentClaudeCode AgentType = "claude_code"
	AgentCodex      AgentType = "codex"
)

// PermissionMode controls how the agent handles tool approvals.
type PermissionMode string

const (
	PermissionAuto PermissionMode = "auto"
	PermissionAsk  PermissionMode = "ask"
	PermissionDeny PermissionMode = "deny"
)

// SessionConfig configures an interactive agent session.
type SessionConfig struct {
	Agent        AgentType
	Model        string
	SystemPrompt string
	Tools        []ToolConfig
	Permissions  PermissionMode
	WorkingDir   string
	MaxTurns     int
	Env          map[string]string
	Extra        map[string]string
}

// TaskConfig configures a one-off agent task.
type TaskConfig struct {
	SessionConfig
	Prompt  string
	Timeout time.Duration
}

// TaskResult is the output of a completed task.
type TaskResult struct {
	SessionID string
	Messages  []Message
	Usage     Usage
	ExitCode  int
}

// ToolConfig describes a custom MCP tool.
type ToolConfig struct {
	ServerCommand string
	ServerArgs    []string
	Name          string
	Description   string
	InputSchema   json.RawMessage
}

// Event represents a streaming event from the agent.
type Event struct {
	Type              EventType
	Delta             string
	Message           *Message
	PermissionRequest *PermissionRequest
	Usage             *Usage
	Error             error
}

// EventType identifies the kind of streaming event.
type EventType string

const (
	EventDelta             EventType = "delta"
	EventMessage           EventType = "message"
	EventPermissionRequest EventType = "permission_request"
	EventComplete          EventType = "complete"
	EventError             EventType = "error"
)

// PermissionRequest is emitted when the agent needs user approval.
type PermissionRequest struct {
	ID       string
	Tool     string
	Input    json.RawMessage
	FilePath string
}

// Usage tracks token consumption.
type Usage struct {
	InputTokens  int
	OutputTokens int
}

// Message is the common message format across all agents.
type Message struct {
	Role    Role
	Content []Block
}

// Role identifies the message author.
type Role string

const (
	RoleAssistant Role = "assistant"
	RoleUser      Role = "user"
	RoleSystem    Role = "system"
)

// Block represents a piece of content within a message.
type Block struct {
	Type       BlockType
	Text       string
	Language   string
	ToolName   string
	ToolInput  json.RawMessage
	ToolOutput string
}

// BlockType identifies the kind of content block.
type BlockType string

const (
	BlockText       BlockType = "text"
	BlockCode       BlockType = "code"
	BlockToolUse    BlockType = "tool_use"
	BlockToolResult BlockType = "tool_result"
)

// AgentInfo describes an available agent.
type AgentInfo struct {
	Type    AgentType
	Name    string
	Version string
}

// Adapter is the internal interface each agent CLI implements.
type Adapter interface {
	StartSession(ctx context.Context, config SessionConfig) (Process, error)
	RunTask(ctx context.Context, config TaskConfig) (TaskResult, error)
	ResumeSession(ctx context.Context, sessionID string, config SessionConfig) (Process, error)
	Info() AgentInfo
	AgentType() AgentType
}

// Process represents a running agent CLI process.
type Process interface {
	Send(ctx context.Context, input string) (<-chan Event, error)
	Stop() error
	Close() error
	SessionID() string
}

// Session wraps a Process with metadata for the public API.
type Session interface {
	Send(ctx context.Context, prompt string) (<-chan Event, error)
	Stop() error
	Close() error
	ID() string
	Agent() AgentType
}
```

```go
// backend/agentsdk/errors.go
package agentsdk

import "fmt"

// ErrorType categorizes agent errors.
type ErrorType string

const (
	ErrQuotaExceeded ErrorType = "quota_exceeded"
	ErrAgentCrash    ErrorType = "agent_crash"
	ErrTimeout       ErrorType = "timeout"
	ErrNotFound      ErrorType = "not_found"
)

// AgentError wraps errors with agent context.
type AgentError struct {
	Type    ErrorType
	Agent   AgentType
	Message string
	Cause   error
}

func (e *AgentError) Error() string {
	return fmt.Sprintf("agent %s: %s: %s", e.Agent, e.Type, e.Message)
}

func (e *AgentError) Unwrap() error {
	return e.Cause
}
```

**Step 2: Verify it compiles**

Run: `cd backend && go build ./agentsdk/`
Expected: compiles with no errors

**Step 3: Commit**

```bash
git add backend/agentsdk/
git commit -m "feat(agentsdk): add core types, interfaces, and error types"
```

---

### Task 2.2: Agent Client

**Files:**
- Create: `backend/agentsdk/client.go`
- Create: `backend/agentsdk/client_test.go`

**Context:** The `Client` dispatches to per-agent adapters. It holds default env vars (LLM proxy URL) and merges them with per-call config.

**Step 1: Write the failing test**

```go
// backend/agentsdk/client_test.go
package agentsdk

import (
	"context"
	"testing"
)

// mockAdapter is a minimal test adapter.
type mockAdapter struct {
	agentType AgentType
}

func (m *mockAdapter) StartSession(ctx context.Context, config SessionConfig) (Process, error) {
	return nil, nil
}
func (m *mockAdapter) RunTask(ctx context.Context, config TaskConfig) (TaskResult, error) {
	return TaskResult{}, nil
}
func (m *mockAdapter) ResumeSession(ctx context.Context, sessionID string, config SessionConfig) (Process, error) {
	return nil, nil
}
func (m *mockAdapter) Info() AgentInfo {
	return AgentInfo{Type: m.agentType, Name: "Mock"}
}
func (m *mockAdapter) AgentType() AgentType { return m.agentType }

func TestClient_AvailableAgents(t *testing.T) {
	client := NewClient(
		SessionConfig{},
		&mockAdapter{agentType: AgentClaudeCode},
		&mockAdapter{agentType: AgentCodex},
	)

	agents := client.AvailableAgents()
	if len(agents) != 2 {
		t.Fatalf("expected 2 agents, got %d", len(agents))
	}
}

func TestClient_MergesDefaultEnv(t *testing.T) {
	defaults := SessionConfig{
		Env: map[string]string{
			"ANTHROPIC_BASE_URL": "http://localhost:8080/api/anthropic",
			"ANTHROPIC_API_KEY":  "dummy",
		},
	}

	client := NewClient(defaults, &mockAdapter{agentType: AgentClaudeCode})

	merged := client.mergeConfig(SessionConfig{
		Agent: AgentClaudeCode,
		Env: map[string]string{
			"EXTRA_VAR": "value",
		},
	})

	if merged.Env["ANTHROPIC_BASE_URL"] != "http://localhost:8080/api/anthropic" {
		t.Error("expected default env to be present")
	}
	if merged.Env["EXTRA_VAR"] != "value" {
		t.Error("expected per-call env to be present")
	}
}

func TestClient_PerCallEnvOverridesDefault(t *testing.T) {
	defaults := SessionConfig{
		Env: map[string]string{"KEY": "default"},
	}
	client := NewClient(defaults, &mockAdapter{agentType: AgentClaudeCode})

	merged := client.mergeConfig(SessionConfig{
		Agent: AgentClaudeCode,
		Env:   map[string]string{"KEY": "override"},
	})

	if merged.Env["KEY"] != "override" {
		t.Errorf("expected override, got %q", merged.Env["KEY"])
	}
}

func TestClient_UnknownAgent_ReturnsError(t *testing.T) {
	client := NewClient(SessionConfig{}, &mockAdapter{agentType: AgentClaudeCode})

	_, err := client.CreateSession(context.Background(), SessionConfig{Agent: AgentCodex})
	if err == nil {
		t.Fatal("expected error for unknown agent")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test -v ./agentsdk/ -run TestClient`
Expected: FAIL — `NewClient`, `mergeConfig` not defined

**Step 3: Write minimal implementation**

```go
// backend/agentsdk/client.go
package agentsdk

import (
	"context"
	"fmt"
	"sync"
)

// Client is the entry point for all agent interactions.
type Client struct {
	adapters   map[AgentType]Adapter
	defaults   SessionConfig
	maxSessions int
	mu         sync.Mutex
	active     int
}

// NewClient creates a Client with registered adapters and default config.
func NewClient(defaults SessionConfig, adapters ...Adapter) *Client {
	m := make(map[AgentType]Adapter, len(adapters))
	for _, a := range adapters {
		m[a.AgentType()] = a
	}
	return &Client{
		adapters:    m,
		defaults:    defaults,
		maxSessions: 5,
	}
}

// SetMaxSessions sets the maximum number of concurrent agent processes.
func (c *Client) SetMaxSessions(n int) {
	c.maxSessions = n
}

// AvailableAgents returns metadata about all registered agents.
func (c *Client) AvailableAgents() []AgentInfo {
	infos := make([]AgentInfo, 0, len(c.adapters))
	for _, a := range c.adapters {
		infos = append(infos, a.Info())
	}
	return infos
}

// CreateSession starts an interactive agent session.
func (c *Client) CreateSession(ctx context.Context, config SessionConfig) (Session, error) {
	adapter, err := c.getAdapter(config.Agent)
	if err != nil {
		return nil, err
	}

	merged := c.mergeConfig(config)

	proc, err := adapter.StartSession(ctx, merged)
	if err != nil {
		return nil, err
	}

	return &session{
		process:   proc,
		agentType: config.Agent,
	}, nil
}

// ResumeSession resumes an existing session by ID.
func (c *Client) ResumeSession(ctx context.Context, sessionID string, config SessionConfig) (Session, error) {
	adapter, err := c.getAdapter(config.Agent)
	if err != nil {
		return nil, err
	}

	merged := c.mergeConfig(config)

	proc, err := adapter.ResumeSession(ctx, sessionID, merged)
	if err != nil {
		return nil, err
	}

	return &session{
		process:   proc,
		agentType: config.Agent,
	}, nil
}

// RunTask runs a one-off agent task to completion.
func (c *Client) RunTask(ctx context.Context, config TaskConfig) (TaskResult, error) {
	adapter, err := c.getAdapter(config.Agent)
	if err != nil {
		return TaskResult{}, err
	}

	config.SessionConfig = c.mergeConfig(config.SessionConfig)
	return adapter.RunTask(ctx, config)
}

func (c *Client) getAdapter(agent AgentType) (Adapter, error) {
	a, ok := c.adapters[agent]
	if !ok {
		return nil, &AgentError{
			Type:    ErrNotFound,
			Agent:   agent,
			Message: fmt.Sprintf("no adapter registered for agent %q", agent),
		}
	}
	return a, nil
}

// mergeConfig merges per-call config with defaults. Per-call values take precedence.
func (c *Client) mergeConfig(config SessionConfig) SessionConfig {
	if config.Env == nil {
		config.Env = make(map[string]string)
	}
	// Defaults first, then per-call overrides
	merged := make(map[string]string, len(c.defaults.Env)+len(config.Env))
	for k, v := range c.defaults.Env {
		merged[k] = v
	}
	for k, v := range config.Env {
		merged[k] = v
	}
	config.Env = merged
	return config
}

// session wraps a Process for the public Session interface.
type session struct {
	process   Process
	agentType AgentType
}

func (s *session) Send(ctx context.Context, prompt string) (<-chan Event, error) {
	return s.process.Send(ctx, prompt)
}

func (s *session) Stop() error  { return s.process.Stop() }
func (s *session) Close() error { return s.process.Close() }
func (s *session) ID() string   { return s.process.SessionID() }
func (s *session) Agent() AgentType { return s.agentType }
```

**Step 4: Run test to verify it passes**

Run: `cd backend && go test -v ./agentsdk/ -run TestClient`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/agentsdk/
git commit -m "feat(agentsdk): add Client with adapter dispatch and env merging"
```

---

### Task 2.3: Claude Code Adapter — Foundation

**Files:**
- Create: `backend/agentsdk/claudecode/adapter.go`
- Create: `backend/agentsdk/claudecode/adapter_test.go`

**Context:** This adapter wraps the existing `backend/claude/sdk/` package. The existing SDK already knows how to spawn the CLI, parse messages, handle permissions, and stream output. The adapter translates between the existing SDK types and the new `agentsdk` types.

This is the most complex adapter. For the initial implementation, focus on `RunTask` (one-off mode using `sdk.Query`). Interactive sessions will be wired in a later task since they need the existing `SessionManager` machinery.

**Step 1: Write the failing test**

```go
// backend/agentsdk/claudecode/adapter_test.go
package claudecode

import (
	"testing"

	"github.com/user/mylifedb/agentsdk"
)

func TestAdapter_Info(t *testing.T) {
	adapter := New()

	info := adapter.Info()
	if info.Type != agentsdk.AgentClaudeCode {
		t.Errorf("expected agent type claude_code, got %q", info.Type)
	}
	if info.Name != "Claude Code" {
		t.Errorf("expected name 'Claude Code', got %q", info.Name)
	}
}

func TestAdapter_AgentType(t *testing.T) {
	adapter := New()
	if adapter.AgentType() != agentsdk.AgentClaudeCode {
		t.Error("expected claude_code agent type")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test -v ./agentsdk/claudecode/ -run TestAdapter`
Expected: FAIL — package does not exist

**Step 3: Write minimal implementation**

```go
// backend/agentsdk/claudecode/adapter.go
package claudecode

import (
	"context"

	"github.com/user/mylifedb/agentsdk"
)

// Adapter wraps Claude Code CLI as an agentsdk.Adapter.
type Adapter struct{}

// New creates a new Claude Code adapter.
func New() *Adapter {
	return &Adapter{}
}

func (a *Adapter) AgentType() agentsdk.AgentType {
	return agentsdk.AgentClaudeCode
}

func (a *Adapter) Info() agentsdk.AgentInfo {
	return agentsdk.AgentInfo{
		Type: agentsdk.AgentClaudeCode,
		Name: "Claude Code",
	}
}

func (a *Adapter) StartSession(ctx context.Context, config agentsdk.SessionConfig) (agentsdk.Process, error) {
	// TODO: Wire to existing SessionManager for interactive mode
	return nil, &agentsdk.AgentError{
		Type:    agentsdk.ErrNotFound,
		Agent:   agentsdk.AgentClaudeCode,
		Message: "interactive sessions not yet implemented in adapter",
	}
}

func (a *Adapter) RunTask(ctx context.Context, config agentsdk.TaskConfig) (agentsdk.TaskResult, error) {
	// TODO: Wire to sdk.Query for one-off tasks
	return agentsdk.TaskResult{}, &agentsdk.AgentError{
		Type:    agentsdk.ErrNotFound,
		Agent:   agentsdk.AgentClaudeCode,
		Message: "RunTask not yet implemented",
	}
}

func (a *Adapter) ResumeSession(ctx context.Context, sessionID string, config agentsdk.SessionConfig) (agentsdk.Process, error) {
	// TODO: Wire to existing SessionManager for resume
	return nil, &agentsdk.AgentError{
		Type:    agentsdk.ErrNotFound,
		Agent:   agentsdk.AgentClaudeCode,
		Message: "ResumeSession not yet implemented in adapter",
	}
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && go test -v ./agentsdk/claudecode/ -run TestAdapter`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/agentsdk/claudecode/
git commit -m "feat(agentsdk): add Claude Code adapter skeleton"
```

---

### Task 2.4: Claude Code Adapter — RunTask via sdk.Query

**Files:**
- Modify: `backend/agentsdk/claudecode/adapter.go`

**Context:** Wire `RunTask` to the existing `sdk.Query()` function in `backend/claude/sdk/query.go`. The existing function spawns `claude --print`, sends a prompt, and returns the result. We need to translate `TaskConfig` → `sdk.QueryOptions` and `sdk.QueryResult` → `TaskResult`.

**Step 1: Read the existing sdk.Query interface**

Check `backend/claude/sdk/query.go` for the `QueryOptions` and `QueryResult` types. Understand what fields map to `TaskConfig` and `TaskResult`.

**Step 2: Implement RunTask**

```go
// In backend/agentsdk/claudecode/adapter.go, replace the RunTask stub:

import (
	"github.com/user/mylifedb/claude/sdk"
)

func (a *Adapter) RunTask(ctx context.Context, config agentsdk.TaskConfig) (agentsdk.TaskResult, error) {
	opts := sdk.QueryOptions{
		Prompt:         config.Prompt,
		SystemPrompt:   config.SystemPrompt,
		WorkingDir:     config.WorkingDir,
		MaxTurns:       config.MaxTurns,
		Model:          config.Model,
		Env:            config.Env,
	}

	// Map permission mode
	switch config.Permissions {
	case agentsdk.PermissionAuto:
		opts.PermissionMode = sdk.PermissionBypassPermissions
	case agentsdk.PermissionDeny:
		opts.PermissionMode = sdk.PermissionPlan
	default:
		opts.PermissionMode = sdk.PermissionDefault
	}

	if config.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, config.Timeout)
		defer cancel()
	}

	result, err := sdk.Query(ctx, opts)
	if err != nil {
		return agentsdk.TaskResult{}, &agentsdk.AgentError{
			Type:    agentsdk.ErrAgentCrash,
			Agent:   agentsdk.AgentClaudeCode,
			Message: "query failed",
			Cause:   err,
		}
	}

	// Convert result to TaskResult
	return agentsdk.TaskResult{
		SessionID: result.SessionID,
		Messages:  convertMessages(result.Messages),
		Usage: agentsdk.Usage{
			InputTokens:  result.InputTokens,
			OutputTokens: result.OutputTokens,
		},
		ExitCode: result.ExitCode,
	}, nil
}

// convertMessages translates sdk messages to agentsdk messages.
// The exact mapping depends on the sdk.Message type structure.
func convertMessages(msgs []sdk.Message) []agentsdk.Message {
	var result []agentsdk.Message
	for _, m := range msgs {
		result = append(result, agentsdk.Message{
			Role: agentsdk.Role(m.Role),
			Content: []agentsdk.Block{{
				Type: agentsdk.BlockText,
				Text: m.Content,
			}},
		})
	}
	return result
}
```

**Note:** The exact field mappings will depend on the actual `sdk.QueryOptions` and `sdk.QueryResult` types. Read `backend/claude/sdk/query.go` first and adjust accordingly. The key insight is that this is a thin translation layer, not new functionality.

**Step 3: Verify it compiles**

Run: `cd backend && go build ./agentsdk/claudecode/`
Expected: compiles (may need import path adjustments)

**Step 4: Commit**

```bash
git add backend/agentsdk/claudecode/
git commit -m "feat(agentsdk): wire Claude Code RunTask to sdk.Query"
```

---

### Task 2.5: Wire Agent Client to Server

**Files:**
- Modify: `backend/server/server.go` — add `agentClient *agentsdk.Client` field
- Modify: `backend/server/server.go` — initialize in `New()`

**Context:** Register the agent client as a server component alongside (not replacing) the existing `claudeManager`. Both coexist during the migration. The agent client is used by new features; the existing `claudeManager` continues to serve the current Claude page until the frontend is migrated.

**Step 1: Add field and accessor**

```go
// In server.go
import "github.com/user/mylifedb/agentsdk"
import "github.com/user/mylifedb/agentsdk/claudecode"

// Add to Server struct:
agentClient *agentsdk.Client

// Add accessor:
func (s *Server) AgentClient() *agentsdk.Client { return s.agentClient }
```

**Step 2: Initialize in New()**

After the existing `claudeManager` initialization:

```go
// Agent SDK
claudeAdapter := claudecode.New()
agentDefaults := agentsdk.SessionConfig{}
if cfg.LLM.HasAnthropic() {
	agentDefaults.Env = map[string]string{
		"ANTHROPIC_BASE_URL": fmt.Sprintf("http://localhost:%d/api/anthropic", cfg.Port),
		"ANTHROPIC_API_KEY":  "dummy",
	}
}
s.agentClient = agentsdk.NewClient(agentDefaults, claudeAdapter)
if maxSessions := os.Getenv("MLD_AGENT_MAX_SESSIONS"); maxSessions != "" {
	if n, err := strconv.Atoi(maxSessions); err == nil {
		s.agentClient.SetMaxSessions(n)
	}
}
```

**Step 3: Verify it compiles and server starts**

Run: `cd backend && go build . && ./my-life-db`
Expected: server starts without errors, existing Claude page still works

**Step 4: Commit**

```bash
git add backend/server/
git commit -m "feat(server): initialize Agent SDK client alongside existing claudeManager"
```

---

## Phase 3: Session Storage Migration

### Task 3.1: Create agent_sessions Migration

**Files:**
- Create: `backend/db/migration_NNN_agent_sessions.go` (use next migration number)

**Context:** Create `agent_sessions` table, migrate data from `claude_sessions`, drop old table. Check `backend/db/migrations.go` for the migration pattern and the next number.

**Step 1: Read existing migration pattern**

Read `backend/db/migrations.go` to understand how migrations are registered and numbered. Read `backend/db/migration_012_claude_sessions.go` to understand the existing schema.

**Step 2: Write the migration**

```go
// backend/db/migration_NNN_agent_sessions.go
package db

func init() {
	registerMigration(NNN, "agent_sessions", func(db *DB) error {
		// Create new table
		_, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS agent_sessions (
				id              TEXT PRIMARY KEY,
				user_id         TEXT NOT NULL DEFAULT '',
				agent_type      TEXT NOT NULL DEFAULT 'claude_code',
				model           TEXT,
				title           TEXT,
				status          TEXT NOT NULL DEFAULT 'active',
				archived_at     INTEGER,
				message_count   INTEGER NOT NULL DEFAULT 0,
				token_usage     INTEGER NOT NULL DEFAULT 0,
				permission_mode TEXT,
				always_allowed_tools TEXT,
				last_read_count INTEGER NOT NULL DEFAULT 0,
				created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at      INTEGER,
				raw             TEXT
			)
		`)
		if err != nil {
			return err
		}

		// Migrate existing data from claude_sessions
		_, err = db.Exec(`
			INSERT OR IGNORE INTO agent_sessions (
				id, agent_type, archived_at, permission_mode,
				always_allowed_tools, last_read_count, updated_at
			)
			SELECT
				session_id, 'claude_code', archived_at, permission_mode,
				always_allowed_tools, COALESCE(last_read_count, 0), updated_at
			FROM claude_sessions
		`)
		if err != nil {
			return err
		}

		// Create indexes
		_, err = db.Exec(`
			CREATE INDEX IF NOT EXISTS idx_agent_sessions_type ON agent_sessions(agent_type);
			CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);
			CREATE INDEX IF NOT EXISTS idx_agent_sessions_archived ON agent_sessions(archived_at);
		`)
		if err != nil {
			return err
		}

		// Drop old table
		_, err = db.Exec(`DROP TABLE IF EXISTS claude_sessions`)
		return err
	})
}
```

**Note:** The exact column set must match what the existing `claude/session_manager.go` queries expect. Read the current queries in `session_manager.go` that touch `claude_sessions` to ensure column compatibility.

**Step 3: Update all queries that reference `claude_sessions`**

Search for all SQL queries referencing `claude_sessions` in `backend/claude/session_manager.go` and update them to use `agent_sessions`. The column names should stay compatible where possible, or add aliases.

Key queries to update:
- `SELECT ... FROM claude_sessions` → `SELECT ... FROM agent_sessions`
- `INSERT INTO claude_sessions` → `INSERT INTO agent_sessions`
- `UPDATE claude_sessions` → `UPDATE agent_sessions`
- `DELETE FROM claude_sessions` → `DELETE FROM agent_sessions`
- Column `session_id` → `id` (or keep as alias in queries)

**Step 4: Test with fresh database**

Run: `cd backend && rm -rf .my-life-db/ && go run .`
Expected: server starts, migrations run, agent_sessions table created

**Step 5: Commit**

```bash
git add backend/db/
git commit -m "feat(db): migrate claude_sessions to agent_sessions table"
```

---

### Task 3.2: Update SessionManager to Use agent_sessions

**Files:**
- Modify: `backend/claude/session_manager.go` — update all SQL queries

**Context:** The existing `SessionManager` continues to work but now reads/writes `agent_sessions` instead of `claude_sessions`. This is a find-and-replace of table names plus any column renames.

**Step 1: Find all claude_sessions references**

Search: `grep -n "claude_sessions" backend/claude/session_manager.go`

**Step 2: Update each query**

Replace `claude_sessions` → `agent_sessions` and `session_id` → `id` (if the column was renamed) in every SQL query. Verify each query's column list matches the new schema.

**Step 3: Test**

Run: `cd backend && go test -v ./claude/ -run TestSession`
Expected: existing tests pass with new table name

Run: `cd backend && rm -rf .my-life-db/ && go run .`
Expected: server starts, Claude page works as before

**Step 4: Commit**

```bash
git add backend/claude/
git commit -m "refactor(claude): update SessionManager to use agent_sessions table"
```

---

## Phase 4: Backend API Migration

### Task 4.1: Agent Info Endpoint

**Files:**
- Modify: `backend/api/routes.go`
- Create: `backend/api/agent.go` (new file for agent endpoints)

**Context:** Add a new `/api/agent/info` endpoint that returns available agents. This is the first new agent API endpoint.

**Step 1: Write the handler**

```go
// backend/api/agent.go
package api

import (
	"net/http"
	"github.com/gin-gonic/gin"
)

// GetAgentInfo returns available agents.
func (h *Handlers) GetAgentInfo(c *gin.Context) {
	agents := h.server.AgentClient().AvailableAgents()

	type agentResponse struct {
		Type    string `json:"type"`
		Name    string `json:"name"`
		Version string `json:"version,omitempty"`
	}

	var resp []agentResponse
	for _, a := range agents {
		resp = append(resp, agentResponse{
			Type:    string(a.Type),
			Name:    a.Name,
			Version: a.Version,
		})
	}

	c.JSON(http.StatusOK, gin.H{"agents": resp})
}
```

**Step 2: Register route**

In `backend/api/routes.go`:
```go
// Agent routes
agent := router.Group("/api/agent")
{
	agent.GET("/info", handlers.GetAgentInfo)
}
```

**Step 3: Test manually**

Run: `cd backend && go run .`
Then: `curl http://localhost:12345/api/agent/info`
Expected: `{"agents":[{"type":"claude_code","name":"Claude Code"}]}`

**Step 4: Commit**

```bash
git add backend/api/agent.go backend/api/routes.go
git commit -m "feat(api): add /api/agent/info endpoint"
```

---

### Task 4.2: Agent Session CRUD Endpoints

**Files:**
- Modify: `backend/api/agent.go`
- Modify: `backend/api/routes.go`

**Context:** Mirror the existing `/api/claude/sessions/*` endpoints under `/api/agent/sessions/*`. These initially delegate to the existing `SessionManager` (which now uses `agent_sessions` table). The key addition is `agent_type` awareness.

**Step 1: Add session endpoints**

These handlers largely wrap the existing `SessionManager` methods but add `agent_type` to requests/responses:

```go
// GET /api/agent/sessions — list sessions with optional agent_type filter
func (h *Handlers) GetAgentSessions(c *gin.Context) {
	agentType := c.Query("agent_type") // optional filter
	// Delegate to existing SessionManager.GetSessions()
	// Add agent_type to response objects
	// ...
}

// POST /api/agent/sessions — create session
func (h *Handlers) CreateAgentSession(c *gin.Context) {
	// Accept agent_type in request body (default: "claude_code")
	// Delegate to existing SessionManager.CreateSession()
	// ...
}

// GET /api/agent/sessions/:id — get session
// DELETE /api/agent/sessions/:id — delete session
// PATCH /api/agent/sessions/:id — update title
// POST /api/agent/sessions/:id/archive — archive
// POST /api/agent/sessions/:id/unarchive — unarchive
```

**Step 2: Register routes**

```go
agent := router.Group("/api/agent")
{
	agent.GET("/info", handlers.GetAgentInfo)
	agent.GET("/sessions", handlers.GetAgentSessions)
	agent.POST("/sessions", handlers.CreateAgentSession)
	agent.GET("/sessions/:id", handlers.GetAgentSession)
	agent.PATCH("/sessions/:id", handlers.UpdateAgentSession)
	agent.DELETE("/sessions/:id", handlers.DeleteAgentSession)
	agent.GET("/sessions/:id/messages", handlers.GetAgentSessionMessages)
	agent.POST("/sessions/:id/archive", handlers.ArchiveAgentSession)
	agent.POST("/sessions/:id/unarchive", handlers.UnarchiveAgentSession)
	agent.POST("/sessions/:id/share", handlers.ShareAgentSession)
	agent.DELETE("/sessions/:id/share", handlers.UnshareAgentSession)
}
```

**Note:** For the initial migration, these handlers can directly delegate to the existing Claude Code handlers with minimal changes. The important thing is getting the new routes registered. The handlers will evolve as the frontend migrates.

**Step 3: Verify routes compile**

Run: `cd backend && go build .`
Expected: compiles

**Step 4: Commit**

```bash
git add backend/api/
git commit -m "feat(api): add /api/agent/sessions/* CRUD endpoints"
```

---

### Task 4.3: Agent WebSocket Endpoint

**Files:**
- Modify: `backend/api/agent.go`
- Modify: `backend/api/routes.go`

**Context:** The WebSocket endpoint is the heart of the interactive experience. For the initial migration, the `/api/agent/sessions/:id/ws` endpoint delegates to the existing `ClaudeSubscribeWebSocket` handler. The WebSocket message format stays the same for now — the frontend migration (Phase 5) will update it to include the new event types.

**Step 1: Add WebSocket route**

```go
// In routes.go, add to agent group:
agent.GET("/sessions/:id/ws", handlers.AgentSessionWebSocket)
agent.GET("/sessions/:id/subscribe", handlers.AgentSessionSubscribe)
```

**Step 2: Write thin wrapper handlers**

```go
// In agent.go:
func (h *Handlers) AgentSessionWebSocket(c *gin.Context) {
	// For now, delegate directly to existing Claude WebSocket handler
	h.ClaudeSubscribeWebSocket(c)
}

func (h *Handlers) AgentSessionSubscribe(c *gin.Context) {
	h.ClaudeSubscribeWebSocket(c)
}
```

**Step 3: Test**

Run: `cd backend && go build .`
Expected: compiles

**Step 4: Commit**

```bash
git add backend/api/
git commit -m "feat(api): add /api/agent/sessions/:id/ws WebSocket endpoint"
```

---

## Phase 5: Frontend Migration

### Task 5.1: Update API Client

**Files:**
- Modify frontend API calls from `/api/claude/*` → `/api/agent/*`
- Key files: `frontend/app/routes/claude.tsx`, `frontend/app/components/claude/chat/hooks/use-session-websocket.ts`

**Context:** This is a systematic find-and-replace of API URLs. The response format stays the same (backend handlers delegate to existing code). Search for all occurrences of `/api/claude/` in the frontend code.

**Step 1: Find all API references**

Run: `grep -rn "/api/claude" frontend/app/`

**Step 2: Replace each occurrence**

Replace `/api/claude/sessions` → `/api/agent/sessions` across all frontend files.

**Step 3: Test**

Run: `cd frontend && npm run typecheck && npm run lint`
Expected: no errors

**Step 4: Test manually**

Open the app, verify Claude page loads sessions, can create new sessions, WebSocket connects.

**Step 5: Commit**

```bash
git add frontend/
git commit -m "refactor(frontend): update API calls from /api/claude to /api/agent"
```

---

### Task 5.2: Add Agent Selector to Chat Page

**Files:**
- Modify: `frontend/app/routes/claude.tsx` — add agent type dropdown
- Modify: `frontend/app/components/claude/chat/chat-input.tsx` — add agent selector

**Context:** Add a dropdown to select the agent type when creating a new session. For now, only "Claude Code" is available. The selector stores the choice in localStorage (like permission mode) and sends it with the create session request.

**Step 1: Add agent type state**

In the route component, add state for selected agent:
```tsx
const [agentType, setAgentType] = useState<string>(
  localStorage.getItem('mld-agent-type') || 'claude_code'
)
```

**Step 2: Add selector UI**

Add a select/dropdown near the permission mode selector:
```tsx
<select value={agentType} onChange={e => {
  setAgentType(e.target.value)
  localStorage.setItem('mld-agent-type', e.target.value)
}}>
  <option value="claude_code">Claude Code</option>
  {/* Future: <option value="codex">Codex</option> */}
</select>
```

**Step 3: Pass agent_type in session creation**

When creating a session, include agent_type in the request body.

**Step 4: Show agent type in session list**

Add a small badge or label showing which agent a session used.

**Step 5: Test**

Run: `cd frontend && npm run typecheck`
Manually verify the selector appears and sessions can be created.

**Step 6: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): add agent type selector to chat page"
```

---

### Task 5.3: Rename Route and Components

**Files:**
- Rename: `frontend/app/routes/claude.tsx` → `frontend/app/routes/agent.tsx` (or keep as alias)
- Update route config if file-based routing requires it

**Context:** The URL can stay as `/claude` for backward compatibility, or change to `/agent`. This is a cosmetic change — decide based on whether existing bookmarks/links matter.

**Note:** This task is optional and can be deferred. The important thing is the API migration (Task 5.1) and the agent selector (Task 5.2).

---

## Phase 6: Inbox Migration

### Task 6.1: Rewrite Inbox to Use Agent SDK

**Files:**
- Modify: `backend/agent/agent.go` — replace custom agentic loop with `agentClient.RunTask()`

**Context:** The current inbox agent in `backend/agent/agent.go` has its own agentic loop that calls OpenAI directly. Replace it with a call to `agentClient.RunTask()` which delegates to Claude Code (or whichever agent is configured).

**Step 1: Read the existing agent.go**

Understand the current `Agent.AnalyzeFile()` flow:
1. Build system prompt from guidelines
2. Define tools (file reader, folder suggester)
3. Run agentic loop (max 5 turns) calling OpenAI
4. Parse response into `FileIntention`

**Step 2: Rewrite using agent SDK**

```go
func (a *Agent) AnalyzeFile(ctx context.Context, filePath string) (*FileIntention, error) {
	prompt := fmt.Sprintf("Analyze the file at %q and determine where it should be filed...", filePath)

	result, err := a.agentClient.RunTask(ctx, agentsdk.TaskConfig{
		SessionConfig: agentsdk.SessionConfig{
			Agent:        agentsdk.AgentClaudeCode,
			SystemPrompt: a.buildSystemPrompt(),
			Permissions:  agentsdk.PermissionAuto,
			WorkingDir:   a.dataDir,
		},
		Prompt:  prompt,
		Timeout: 60 * time.Second,
	})
	if err != nil {
		return nil, err
	}

	// Parse the last assistant message for the intention
	return a.parseIntention(result.Messages)
}
```

**Step 3: Update Agent constructor to accept agentClient**

```go
func New(agentClient *agentsdk.Client, dataDir string, db *db.DB) *Agent {
	return &Agent{
		agentClient: agentClient,
		dataDir:     dataDir,
		db:          db,
	}
}
```

**Step 4: Update server.go to pass agentClient to Agent**

**Step 5: Test**

Run: `cd backend && go build .`
Test with an actual inbox file if possible.

**Step 6: Commit**

```bash
git add backend/agent/ backend/server/
git commit -m "refactor(agent): rewrite inbox to use Agent SDK instead of direct OpenAI"
```

---

## Phase 7: Summarize Migration

### Task 7.1: Migrate AI Summarize to LLM Proxy

**Files:**
- Modify: `backend/api/ai.go`

**Context:** The current `ai.go` uses the `vendors/openai.go` client directly. Migrate to use the LLM proxy endpoint instead. This can be a direct HTTP call to `localhost:{PORT}/api/openai/v1/chat/completions` or a simple helper.

**Step 1: Read current ai.go implementation**

Understand the current flow and what it returns.

**Step 2: Replace OpenAI vendor call with LLM proxy call**

Instead of calling `vendors.GetOpenAIClient()`, make an HTTP request to the local LLM proxy:

```go
func (h *Handlers) Summarize(c *gin.Context) {
	// ... parse request ...

	// Call LLM proxy directly
	resp, err := http.Post(
		fmt.Sprintf("http://localhost:%d/api/openai/v1/chat/completions", h.server.Port()),
		"application/json",
		bytes.NewReader(requestBody),
	)
	// ... handle response ...
}
```

Or add a convenience method to the LLM proxy package.

**Step 3: Test**

Test summarize endpoint still works.

**Step 4: Commit**

```bash
git add backend/api/ai.go
git commit -m "refactor(ai): migrate summarize to use LLM proxy"
```

---

## Phase 8: Cleanup

### Task 8.1: Remove Deprecated Code

**Files:**
- Remove or deprecate: old `/api/claude/*` route registrations (keep as aliases initially if needed)
- Remove: `backend/vendors/openai.go` (if nothing else uses it)
- Remove: direct OpenAI imports from `backend/agent/`
- Update: `backend/server/server.go` to remove `claudeManager` once fully migrated

**Note:** This phase should be done carefully. Each removal should be verified:
1. Search for all references to the removed code
2. Ensure no feature depends on it
3. Remove and verify tests pass

**Step 1: Remove old Claude routes**

Once frontend is fully migrated to `/api/agent/*`, remove the old `/api/claude/*` routes from `routes.go`.

**Step 2: Remove OpenAI vendor (if unused)**

Check: `grep -rn "vendors.GetOpenAI\|vendors.OpenAI" backend/`
If no references remain, remove `backend/vendors/openai.go`.

**Step 3: Clean up environment variables**

Update documentation and Docker configs:
- Remove `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`
- Remove `MLD_INBOX_AGENT` (agents are always available)
- Document new `MLD_LLM_*` and `MLD_AGENT_*` vars

**Step 4: Update CLAUDE.md**

Update the project's `CLAUDE.md` to reflect the new architecture:
- New package: `backend/agentsdk/`
- New package: `backend/llm/`
- Updated routes
- Updated env vars

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove deprecated Claude/OpenAI vendor code and old routes"
```

---

## Implementation Notes

### What NOT to Change

The current Claude Code integration is very sophisticated. These subsystems should be preserved as-is and wrapped, not rewritten:

1. **Page model** (session.go) — message pagination with page breaks, deduplication, and streaming awareness
2. **Permission protocol** — control_request/control_response flow through WebSocket
3. **Session file watching** — JSONL file watching for historical sessions
4. **Message type hierarchy** (models/) — 15+ message types with parsing
5. **WebSocket protocol** — bidirectional communication, reconnection, burst pages
6. **SDK transport layer** — subprocess management, stdin/stdout streaming

The adapter pattern explicitly wraps these rather than replacing them.

### Risk Areas

1. **Session migration** — The `claude_sessions` → `agent_sessions` rename touches every SQL query in `session_manager.go`. Test thoroughly with a fresh database AND with an existing database that has sessions.

2. **Import paths** — The existing `backend/agent/` package name collides with the new `backend/agentsdk/` package. Keep them separate. The old `agent/` package is the inbox feature; the new `agentsdk/` package is the SDK.

3. **Concurrent migration** — During the transition, both old and new routes exist. The frontend should be migrated atomically (one commit switches all API calls). Don't leave the app in a state where some calls go to old routes and some to new.

4. **LLM proxy and agent on same port** — The proxy routes are on the same Gin server. Agent CLIs will set `ANTHROPIC_BASE_URL=http://localhost:{PORT}/api/anthropic`. Make sure the port in the env var matches the actual server port (from config, not hardcoded).
