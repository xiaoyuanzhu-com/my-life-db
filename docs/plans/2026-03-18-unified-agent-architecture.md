# Unified Agent Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace fragmented AI integrations (Claude Code WebSocket wrapper, Inbox Agent agentic loop, OpenAI Summarize) with a three-layer architecture: LLM proxy, ACP-based agent wrapper, and agent-agnostic features.

**Architecture:** Three layers — (1) LLM Layer: reverse-proxy routes on the Gin server that inject credentials and forward to upstream providers; (2) Agent wrapper: thin Go layer over ACP (`coder/acp-go-sdk`) that manages lifecycle and injects LLM proxy config; (3) Features that consume the wrapper without knowing which agent runs underneath.

**Tech Stack:** Go 1.25, Gin, SQLite (mattn/go-sqlite3), ACP (coder/acp-go-sdk), Node.js, React 19, TypeScript, TanStack Query, WebSocket

**Design Docs:**
- [agent-interface-design.md](2026-03-17-agent-interface-design.md) — SDK interface spec (ACP-based)
- [unified-agent-architecture-design.md](2026-03-17-unified-agent-architecture-design.md) — Architecture design

---

## Phase Overview

| Phase | What | Shippable? |
|-------|------|------------|
| 0 | Dependencies (Node.js, ACP SDK, agent binaries) | Yes — additive, no behavior change |
| 1 | LLM Layer (proxy routes + proxy auth token) | Yes — additive, existing features still work |
| 2 | Agent wrapper (thin Go layer over ACP) | Yes — internal library, no external changes |
| 3 | Session storage migration | Yes — DB migration |
| 4 | Backend API migration (`/api/agent/*`) | Yes — new routes |
| 5 | Frontend migration | Yes — switch to new routes + agent selector |
| 6 | Inbox migration | Yes — rewrite to use agent wrapper |
| 7 | Summarize migration | Yes — use LLM proxy directly |
| 8 | Cleanup | Yes — remove deprecated code/routes/env vars |

Phases 0-2 can run in parallel. Phase 3 depends on nothing. Phases 4-5 depend on 2-3. Phases 6-7 depend on 2. Phase 8 is last.

---

## Phase 0: Dependencies

### Task 0.1: Add Node.js and Agent Binaries to Docker Image

**Files:**
- Modify: `Dockerfile`

**Context:** Node.js is required for agent ACP binaries. Most agents are distributed via npm. `claude-agent-acp` uses Claude Agent SDK → `claude` CLI under the hood, so `claude` CLI must also be present.

**Step 1: Read current Dockerfile**

Read `Dockerfile` to understand the current build stages, base image, and how `claude` CLI is currently installed.

**Step 2: Add Node.js and npm install**

Add to the Dockerfile (in the runtime stage, after existing dependencies):

```dockerfile
# Node.js runtime (required for ACP agent binaries)
RUN apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/*

# ACP agent binaries
RUN npm install -g @zed-industries/claude-agent-acp
```

**Step 3: Verify build**

Run: `docker build -t mylifedb-test .`
Expected: builds successfully, `claude-agent-acp` is in PATH

**Step 4: Verify agent binary works**

Run: `docker run --rm mylifedb-test claude-agent-acp --version`
Expected: prints version

**Step 5: Commit**

```bash
git add Dockerfile
git commit -m "feat: add Node.js and claude-agent-acp to Docker image"
```

---

### Task 0.2: Add acp-go-sdk Dependency

**Files:**
- Modify: `backend/go.mod`

**Step 1: Add dependency**

Run: `cd backend && go get github.com/coder/acp-go-sdk`

**Step 2: Verify**

Run: `cd backend && go build .`
Expected: compiles

**Step 3: Commit**

```bash
git add backend/go.mod backend/go.sum
git commit -m "feat: add coder/acp-go-sdk dependency"
```

---

## Phase 1: LLM Layer (Proxy Routes)

### Task 1.1: LLM Config + Proxy Token

**Files:**
- Create: `backend/llm/config.go`
- Create: `backend/llm/config_test.go`

**Context:** Config for upstream LLM providers + an ephemeral proxy token for auth.

**Step 1: Write the failing test**

```go
// backend/llm/config_test.go
package llm

import (
	"testing"
)

func TestNewConfig_FromEnv(t *testing.T) {
	t.Setenv("MLD_LLM_ANTHROPIC_KEY", "sk-ant-test")
	t.Setenv("MLD_LLM_ANTHROPIC_URL", "https://api.anthropic.com")
	t.Setenv("MLD_LLM_OPENAI_KEY", "sk-openai-test")

	cfg := NewConfigFromEnv()

	if cfg.Anthropic.APIKey != "sk-ant-test" {
		t.Errorf("expected sk-ant-test, got %q", cfg.Anthropic.APIKey)
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
		t.Error("expected HasAnthropic() = false")
	}
}

func TestProxyToken_Generated(t *testing.T) {
	cfg := NewConfigFromEnv()
	if cfg.ProxyToken == "" {
		t.Error("expected non-empty proxy token")
	}
	if len(cfg.ProxyToken) < 32 {
		t.Errorf("expected token >= 32 chars, got %d", len(cfg.ProxyToken))
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

import (
	"crypto/rand"
	"encoding/hex"
	"os"
)

type ProviderConfig struct {
	APIKey  string
	BaseURL string
}

type Config struct {
	Anthropic  ProviderConfig
	OpenAI     ProviderConfig
	ProxyToken string // ephemeral token for proxy auth, generated at startup
}

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
		ProxyToken: generateToken(),
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

func generateToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && go test -v ./llm/ -run Test`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/llm/
git commit -m "feat(llm): add LLM proxy config with ephemeral auth token"
```

---

### Task 1.2: Reverse Proxy with Token Validation

**Files:**
- Create: `backend/llm/proxy.go`
- Create: `backend/llm/proxy_test.go`

**Context:** Reverse proxy that validates the ephemeral token, injects real API keys, and forwards to upstream providers. Supports both Anthropic (`x-api-key` header) and OpenAI (`Authorization: Bearer` header) formats.

**Step 1: Write the failing tests**

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

func TestAnthropicProxy_InjectsKey(t *testing.T) {
	var receivedKey string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedKey = r.Header.Get("x-api-key")
		w.Write([]byte(`{"id":"msg_123"}`))
	}))
	defer upstream.Close()

	cfg := Config{
		Anthropic:  ProviderConfig{APIKey: "sk-ant-real", BaseURL: upstream.URL},
		ProxyToken: "test-token",
	}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if receivedKey != "sk-ant-real" {
		t.Errorf("expected real key, got %q", receivedKey)
	}
}

func TestProxy_InvalidToken_Returns401(t *testing.T) {
	cfg := Config{
		Anthropic:  ProviderConfig{APIKey: "sk-ant-real"},
		ProxyToken: "correct-token",
	}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer wrong-token")
	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != 401 {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestProxy_NoToken_Returns401(t *testing.T) {
	cfg := Config{
		Anthropic:  ProviderConfig{APIKey: "sk-ant-real"},
		ProxyToken: "correct-token",
	}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader("{}"))
	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != 401 {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAnthropicProxy_NoKey_Returns503(t *testing.T) {
	cfg := Config{ProxyToken: "token"}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != 503 {
		t.Errorf("expected 503, got %d", rec.Code)
	}
}

func TestOpenAIProxy_InjectsBearer(t *testing.T) {
	var receivedAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		w.Write([]byte(`{"id":"chatcmpl-123"}`))
	}))
	defer upstream.Close()

	cfg := Config{
		OpenAI:     ProviderConfig{APIKey: "sk-oai-real", BaseURL: upstream.URL},
		ProxyToken: "test-token",
	}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/openai/v1/chat/completions", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	proxy.OpenAIHandler().ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Errorf("expected 200, got %d", rec.Code)
	}
	if receivedAuth != "Bearer sk-oai-real" {
		t.Errorf("expected Bearer with real key, got %q", receivedAuth)
	}
}

func TestProxy_Upstream429_ForwardsError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(429)
		w.Write([]byte(`{"error":{"type":"rate_limit_error","message":"quota exceeded"}}`))
	}))
	defer upstream.Close()

	cfg := Config{
		Anthropic:  ProviderConfig{APIKey: "sk-ant", BaseURL: upstream.URL},
		ProxyToken: "token",
	}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != 429 {
		t.Errorf("expected 429, got %d", rec.Code)
	}

	body, _ := io.ReadAll(rec.Body)
	if !strings.Contains(string(body), "quota exceeded") {
		t.Error("expected error to be forwarded")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test -v ./llm/ -run TestProxy`
Expected: FAIL — `NewProxy` not defined

**Step 3: Write implementation**

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

type Proxy struct {
	cfg Config
}

func NewProxy(cfg Config) *Proxy {
	return &Proxy{cfg: cfg}
}

// Token returns the proxy token for passing to agent processes.
func (p *Proxy) Token() string { return p.cfg.ProxyToken }

// validateToken checks the Authorization header for the proxy token.
func (p *Proxy) validateToken(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	return auth == "Bearer "+p.cfg.ProxyToken
}

func (p *Proxy) AnthropicHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !p.validateToken(r) {
			http.Error(w, `{"error":{"type":"auth_error","message":"invalid proxy token"}}`, http.StatusUnauthorized)
			return
		}
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
				req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api/anthropic")
				req.Host = upstream.Host
				req.Header.Set("x-api-key", p.cfg.Anthropic.APIKey)
				req.Header.Del("Authorization") // remove proxy token

				log.Info().Str("path", req.URL.Path).Str("upstream", upstream.Host).Msg("llm proxy: anthropic")
			},
		}
		proxy.ServeHTTP(w, r)
	})
}

func (p *Proxy) OpenAIHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !p.validateToken(r) {
			http.Error(w, `{"error":{"message":"invalid proxy token","type":"auth_error"}}`, http.StatusUnauthorized)
			return
		}
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
				req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api/openai")
				req.Host = upstream.Host
				req.Header.Set("Authorization", "Bearer "+p.cfg.OpenAI.APIKey)

				log.Info().Str("path", req.URL.Path).Str("upstream", upstream.Host).Msg("llm proxy: openai")
			},
		}
		proxy.ServeHTTP(w, r)
	})
}

func (p *Proxy) ModelsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Models endpoint doesn't need token auth (informational only)
		w.Header().Set("Content-Type", "application/json")
		providers := []string{}
		if p.cfg.HasAnthropic() {
			providers = append(providers, `{"id":"anthropic","provider":"anthropic"}`)
		}
		if p.cfg.HasOpenAI() {
			providers = append(providers, `{"id":"openai","provider":"openai"}`)
		}
		w.Write([]byte(`{"data":[` + strings.Join(providers, ",") + `]}`))
	})
}
```

**Step 4: Run tests to verify they pass**

Run: `cd backend && go test -v ./llm/`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/llm/
git commit -m "feat(llm): add reverse proxy with token auth, Anthropic + OpenAI support"
```

---

### Task 1.3: Register Proxy Routes on Gin Server

**Files:**
- Modify: `backend/server/server.go` — add `llmProxy *llm.Proxy`
- Modify: `backend/server/config.go` — add LLM config
- Modify: `backend/api/routes.go` — register proxy routes

**Step 1: Read current server.go and config.go**

Understand how the server is structured and where to add the new field.

**Step 2: Add LLM config to server config**

In `backend/server/config.go`:
```go
import "github.com/user/mylifedb/llm"

// Add to Config struct:
LLM llm.Config
```

**Step 3: Initialize proxy in server.New()**

In `backend/server/server.go`:
```go
// Add field to Server struct:
llmProxy *llm.Proxy

// In New(), after database init:
s.llmProxy = llm.NewProxy(cfg.LLM)

// Add accessor:
func (s *Server) LLMProxy() *llm.Proxy { return s.llmProxy }
```

**Step 4: Register routes in api/routes.go**

```go
// LLM Proxy routes
router.Any("/api/anthropic/*path", gin.WrapH(handlers.server.LLMProxy().AnthropicHandler()))
router.Any("/api/openai/*path", gin.WrapH(handlers.server.LLMProxy().OpenAIHandler()))
router.GET("/api/llm/v1/models", gin.WrapH(handlers.server.LLMProxy().ModelsHandler()))
```

**Step 5: Load config in main.go**

```go
cfg.LLM = llm.NewConfigFromEnv()
```

**Step 6: Verify it compiles and starts**

Run: `cd backend && go build . && ./my-life-db`
Expected: server starts, existing features work, proxy routes respond

**Step 7: Commit**

```bash
git add backend/server/ backend/api/routes.go backend/main.go
git commit -m "feat(llm): register LLM proxy routes on Gin server"
```

---

## Phase 2: Agent Wrapper (Thin Layer over ACP)

### Task 2.1: Core Types

**Files:**
- Create: `backend/agentsdk/types.go`
- Create: `backend/agentsdk/errors.go`

**Context:** Define types from the agent interface design doc. These are the public API that features use. Under the hood, they translate to/from ACP types.

**Step 1: Write types**

```go
// backend/agentsdk/types.go
package agentsdk

import (
	"context"
	"encoding/json"
	"time"
)

type AgentType string

const (
	AgentClaudeCode AgentType = "claude_code"
	AgentCodex      AgentType = "codex"
)

type PermissionMode string

const (
	PermissionAuto PermissionMode = "auto"
	PermissionAsk  PermissionMode = "ask"
	PermissionDeny PermissionMode = "deny"
)

// AgentConfig registers an agent binary with the client.
type AgentConfig struct {
	Type    AgentType
	Name    string   // display name
	Command string   // binary: "claude-agent-acp"
	Args    []string // default args
}

// SessionConfig configures an interactive agent session.
type SessionConfig struct {
	Agent        AgentType
	Model        string
	SystemPrompt string
	Permissions  PermissionMode
	WorkingDir   string
	MaxTurns     int
	Env          map[string]string
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

// Event represents a streaming event from the agent.
type Event struct {
	Type              EventType
	Delta             string
	Message           *Message
	PermissionRequest *PermissionRequest
	Usage             *Usage
	Error             error
}

type EventType string

const (
	EventDelta             EventType = "delta"
	EventMessage           EventType = "message"
	EventPermissionRequest EventType = "permission_request"
	EventComplete          EventType = "complete"
	EventError             EventType = "error"
)

type PermissionRequest struct {
	ID       string
	Tool     string
	Input    json.RawMessage
	FilePath string
}

type Usage struct {
	InputTokens  int
	OutputTokens int
}

type Message struct {
	Role    Role
	Content []Block
}

type Role string

const (
	RoleAssistant Role = "assistant"
	RoleUser      Role = "user"
	RoleSystem    Role = "system"
)

type Block struct {
	Type       BlockType
	Text       string
	Language   string
	ToolName   string
	ToolInput  json.RawMessage
	ToolOutput string
}

type BlockType string

const (
	BlockText       BlockType = "text"
	BlockCode       BlockType = "code"
	BlockToolUse    BlockType = "tool_use"
	BlockToolResult BlockType = "tool_result"
)

type AgentInfo struct {
	Type    AgentType
	Name    string
	Version string
}

// Session represents an interactive agent conversation.
type Session interface {
	Send(ctx context.Context, prompt string) (<-chan Event, error)
	RespondToPermission(ctx context.Context, requestID string, allowed bool) error
	Stop() error
	Close() error
	ID() string
	AgentType() AgentType
}
```

```go
// backend/agentsdk/errors.go
package agentsdk

import "fmt"

type ErrorType string

const (
	ErrQuotaExceeded   ErrorType = "quota_exceeded"
	ErrNoCredentials   ErrorType = "no_credentials"
	ErrTooManySessions ErrorType = "too_many_sessions"
	ErrAgentCrash      ErrorType = "agent_crash"
	ErrTimeout         ErrorType = "timeout"
	ErrNotFound        ErrorType = "not_found"
)

type AgentError struct {
	Type    ErrorType
	Agent   AgentType
	Message string
	Cause   error
}

func (e *AgentError) Error() string {
	return fmt.Sprintf("agent %s: %s: %s", e.Agent, e.Type, e.Message)
}

func (e *AgentError) Unwrap() error { return e.Cause }
```

**Step 2: Verify it compiles**

Run: `cd backend && go build ./agentsdk/`
Expected: compiles

**Step 3: Commit**

```bash
git add backend/agentsdk/
git commit -m "feat(agentsdk): add core types, events, and error types"
```

---

### Task 2.2: ACP Session Implementation

**Files:**
- Create: `backend/agentsdk/acpsession.go`

**Context:** This is the core piece — an `acpSession` struct that implements `Session` by wrapping an ACP `ClientSideConnection`. It spawns the agent binary, establishes the ACP connection, and translates ACP callbacks into our `Event` channel.

**Step 1: Read the acp-go-sdk API**

Read `coder/acp-go-sdk` source to understand:
- `acp.NewClientSideConnection(client, stdin, stdout)` — how to create a connection
- The `Client` interface — what callbacks to implement (SessionUpdate, RequestPermission, ReadTextFile, WriteTextFile, CreateTerminal, etc.)
- `acp.Prompt()` — how to send a prompt
- `acp.Initialize()` — handshake
- `acp.NewSession()` — create session

**Step 2: Implement acpSession**

```go
// backend/agentsdk/acpsession.go
package agentsdk

import (
	"context"
	"os"
	"os/exec"
	"sync"

	acp "github.com/coder/acp-go-sdk"
)

// acpSession wraps an ACP ClientSideConnection as a Session.
type acpSession struct {
	cmd       *exec.Cmd
	conn      *acp.ClientSideConnection
	sessionID string
	agentType AgentType

	permMu       sync.Mutex
	permChannels map[string]chan bool // requestID → response channel

	mu     sync.Mutex
	closed bool
}

// acpClient implements the acp.Client interface, translating
// ACP callbacks into our Event stream.
type acpClient struct {
	events       chan<- Event
	permChannels map[string]chan bool
	permMu       *sync.Mutex
	workingDir   string
}

// ACP callback: agent sends a message update
func (c *acpClient) SessionUpdate(update acp.SessionUpdate) {
	// Translate update into EventDelta or EventMessage
	// Send to events channel
	// Implementation depends on acp.SessionUpdate structure
}

// ACP callback: agent requests permission
func (c *acpClient) RequestPermission(req acp.PermissionRequest) (acp.PermissionResponse, error) {
	// Create response channel
	respCh := make(chan bool, 1)

	c.permMu.Lock()
	requestID := req.ID // or generate one
	c.permChannels[requestID] = respCh
	c.permMu.Unlock()

	// Emit permission request event
	c.events <- Event{
		Type: EventPermissionRequest,
		PermissionRequest: &PermissionRequest{
			ID:   requestID,
			Tool: req.Tool,
			// Map other fields from ACP request
		},
	}

	// Block until RespondToPermission is called
	allowed := <-respCh

	c.permMu.Lock()
	delete(c.permChannels, requestID)
	c.permMu.Unlock()

	return acp.PermissionResponse{Allowed: allowed}, nil
}

// ACP callback: agent wants to read a file
func (c *acpClient) ReadTextFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ACP callback: agent wants to write a file
func (c *acpClient) WriteTextFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0644)
}

// ... implement other acp.Client methods (CreateTerminal, etc.)
```

**Note:** The exact ACP callback signatures depend on `coder/acp-go-sdk` types. Read the SDK source first and adjust accordingly. The pattern is:
- ACP callback → translate → send to events channel
- For permission requests: block the callback goroutine until `RespondToPermission` is called

**Step 3: Implement Send and RespondToPermission**

```go
func (s *acpSession) Send(ctx context.Context, prompt string) (<-chan Event, error) {
	events := make(chan Event, 64)

	go func() {
		defer close(events)
		// Call ACP Prompt with the acpClient wired to this events channel
		// When ACP completes, send EventComplete
		// On error, send EventError
	}()

	return events, nil
}

func (s *acpSession) RespondToPermission(ctx context.Context, requestID string, allowed bool) error {
	s.permMu.Lock()
	ch, ok := s.permChannels[requestID]
	s.permMu.Unlock()

	if !ok {
		return &AgentError{
			Type:    ErrNotFound,
			Agent:   s.agentType,
			Message: "no pending permission request with ID " + requestID,
		}
	}

	ch <- allowed
	return nil
}

func (s *acpSession) Stop() error {
	if s.cmd != nil && s.cmd.Process != nil {
		return s.cmd.Process.Signal(os.Interrupt)
	}
	return nil
}

func (s *acpSession) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true

	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Signal(os.Kill)
		s.cmd.Wait()
	}
	return nil
}

func (s *acpSession) ID() string          { return s.sessionID }
func (s *acpSession) AgentType() AgentType { return s.agentType }
```

**Step 4: Verify it compiles**

Run: `cd backend && go build ./agentsdk/`
Expected: compiles (may need adjustments for exact ACP SDK types)

**Step 5: Commit**

```bash
git add backend/agentsdk/
git commit -m "feat(agentsdk): add ACP session implementation"
```

---

### Task 2.3: Agent Client

**Files:**
- Create: `backend/agentsdk/client.go`
- Create: `backend/agentsdk/client_test.go`

**Context:** The `Client` manages agent configs, spawns ACP sessions, enforces limits, and provides `Complete()` for direct LLM calls.

**Step 1: Write the failing test**

```go
// backend/agentsdk/client_test.go
package agentsdk

import "testing"

func TestClient_AvailableAgents(t *testing.T) {
	client := NewClient(
		SessionConfig{},
		AgentConfig{Type: AgentClaudeCode, Name: "Claude Code", Command: "claude-agent-acp"},
		AgentConfig{Type: AgentCodex, Name: "Codex", Command: "codex"},
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
			"MLD_PROXY_TOKEN":    "token123",
		},
	}
	client := NewClient(defaults,
		AgentConfig{Type: AgentClaudeCode, Name: "Claude Code", Command: "claude-agent-acp"},
	)

	merged := client.mergeEnv(SessionConfig{
		Agent: AgentClaudeCode,
		Env:   map[string]string{"EXTRA": "value"},
	})

	if merged["ANTHROPIC_BASE_URL"] != "http://localhost:8080/api/anthropic" {
		t.Error("expected default env")
	}
	if merged["EXTRA"] != "value" {
		t.Error("expected per-call env")
	}
	if merged["MLD_PROXY_TOKEN"] != "token123" {
		t.Error("expected proxy token")
	}
}

func TestClient_PerCallOverridesDefault(t *testing.T) {
	defaults := SessionConfig{Env: map[string]string{"KEY": "default"}}
	client := NewClient(defaults,
		AgentConfig{Type: AgentClaudeCode, Name: "Claude Code", Command: "claude-agent-acp"},
	)

	merged := client.mergeEnv(SessionConfig{
		Agent: AgentClaudeCode,
		Env:   map[string]string{"KEY": "override"},
	})

	if merged["KEY"] != "override" {
		t.Errorf("expected override, got %q", merged["KEY"])
	}
}

func TestClient_UnknownAgent_ReturnsError(t *testing.T) {
	client := NewClient(SessionConfig{},
		AgentConfig{Type: AgentClaudeCode, Name: "Claude Code", Command: "claude-agent-acp"},
	)

	_, err := client.CreateSession(nil, SessionConfig{Agent: AgentCodex})
	if err == nil {
		t.Fatal("expected error for unknown agent")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test -v ./agentsdk/ -run TestClient`
Expected: FAIL — `NewClient` not defined

**Step 3: Write implementation**

```go
// backend/agentsdk/client.go
package agentsdk

import (
	"context"
	"fmt"
	"os/exec"
	"sync"
)

type Client struct {
	agents       map[AgentType]AgentConfig
	defaults     SessionConfig
	maxSessions  int
	proxyBaseURL string

	mu      sync.Mutex
	active  map[string]Session // sessionID → Session
}

func NewClient(defaults SessionConfig, agents ...AgentConfig) *Client {
	m := make(map[AgentType]AgentConfig, len(agents))
	for _, a := range agents {
		m[a.Type] = a
	}
	return &Client{
		agents:      m,
		defaults:    defaults,
		maxSessions: 5,
		active:      make(map[string]Session),
	}
}

func (c *Client) SetMaxSessions(n int)          { c.maxSessions = n }
func (c *Client) SetProxyBaseURL(url string)     { c.proxyBaseURL = url }

func (c *Client) AvailableAgents() []AgentInfo {
	infos := make([]AgentInfo, 0, len(c.agents))
	for _, a := range c.agents {
		infos = append(infos, AgentInfo{Type: a.Type, Name: a.Name})
	}
	return infos
}

func (c *Client) CreateSession(ctx context.Context, config SessionConfig) (Session, error) {
	agentCfg, err := c.getAgent(config.Agent)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	if len(c.active) >= c.maxSessions {
		c.mu.Unlock()
		return nil, &AgentError{
			Type:    ErrTooManySessions,
			Agent:   config.Agent,
			Message: fmt.Sprintf("limit is %d concurrent sessions", c.maxSessions),
		}
	}
	c.mu.Unlock()

	env := c.mergeEnv(config)

	// Spawn the agent binary
	cmd := exec.CommandContext(ctx, agentCfg.Command, agentCfg.Args...)
	cmd.Env = append(cmd.Environ(), mapToEnvSlice(env)...)
	if config.WorkingDir != "" {
		cmd.Dir = config.WorkingDir
	}

	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()

	if err := cmd.Start(); err != nil {
		return nil, &AgentError{
			Type:    ErrAgentCrash,
			Agent:   config.Agent,
			Message: "failed to start agent binary",
			Cause:   err,
		}
	}

	// Create ACP connection
	// conn := acp.NewClientSideConnection(acpClient, stdin, stdout)
	// Initialize + NewSession
	// Return acpSession wrapping the connection

	session := &acpSession{
		cmd:          cmd,
		agentType:    config.Agent,
		permChannels: make(map[string]chan bool),
	}

	c.mu.Lock()
	c.active[session.ID()] = session
	c.mu.Unlock()

	_ = stdin
	_ = stdout

	return session, nil
}

func (c *Client) ResumeSession(ctx context.Context, sessionID string, config SessionConfig) (Session, error) {
	// Similar to CreateSession but passes sessionID to ACP
	return nil, &AgentError{Type: ErrNotFound, Agent: config.Agent, Message: "not yet implemented"}
}

func (c *Client) RunTask(ctx context.Context, config TaskConfig) (TaskResult, error) {
	if config.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, config.Timeout)
		defer cancel()
	}

	session, err := c.CreateSession(ctx, config.SessionConfig)
	if err != nil {
		return TaskResult{}, err
	}
	defer session.Close()

	events, err := session.Send(ctx, config.Prompt)
	if err != nil {
		return TaskResult{}, err
	}

	var messages []Message
	var usage Usage
	for event := range events {
		switch event.Type {
		case EventMessage:
			if event.Message != nil {
				messages = append(messages, *event.Message)
			}
		case EventComplete:
			if event.Usage != nil {
				usage = *event.Usage
			}
		case EventError:
			return TaskResult{}, event.Error
		}
	}

	return TaskResult{
		SessionID: session.ID(),
		Messages:  messages,
		Usage:     usage,
	}, nil
}

func (c *Client) Complete(ctx context.Context, provider string, prompt string, model string) (string, Usage, error) {
	// Direct HTTP call to LLM proxy — no agent
	// POST to c.proxyBaseURL + /api/{provider}/v1/...
	// Parse response, return text + usage
	return "", Usage{}, fmt.Errorf("Complete() not yet implemented")
}

func (c *Client) Shutdown(ctx context.Context) error {
	c.mu.Lock()
	sessions := make([]Session, 0, len(c.active))
	for _, s := range c.active {
		sessions = append(sessions, s)
	}
	c.mu.Unlock()

	for _, s := range sessions {
		s.Close()
	}
	return nil
}

func (c *Client) getAgent(agent AgentType) (AgentConfig, error) {
	cfg, ok := c.agents[agent]
	if !ok {
		return AgentConfig{}, &AgentError{
			Type:    ErrNotFound,
			Agent:   agent,
			Message: fmt.Sprintf("no agent registered for %q", agent),
		}
	}
	return cfg, nil
}

func (c *Client) mergeEnv(config SessionConfig) map[string]string {
	merged := make(map[string]string)
	for k, v := range c.defaults.Env {
		merged[k] = v
	}
	for k, v := range config.Env {
		merged[k] = v
	}
	return merged
}

func mapToEnvSlice(m map[string]string) []string {
	s := make([]string, 0, len(m))
	for k, v := range m {
		s = append(s, k+"="+v)
	}
	return s
}
```

**Step 4: Run tests**

Run: `cd backend && go test -v ./agentsdk/ -run TestClient`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/agentsdk/
git commit -m "feat(agentsdk): add Client with ACP session spawning and env merging"
```

---

### Task 2.4: Wire Agent Client to Server

**Files:**
- Modify: `backend/server/server.go` — add `agentClient *agentsdk.Client`
- Modify: `backend/server/server.go` — initialize in `New()`

**Step 1: Add field and accessor**

```go
import "github.com/user/mylifedb/agentsdk"

// Add to Server struct:
agentClient *agentsdk.Client

// Add accessor:
func (s *Server) AgentClient() *agentsdk.Client { return s.agentClient }
```

**Step 2: Initialize in New()**

After LLM proxy initialization:

```go
// Agent Client (ACP-based)
claudeAgent := agentsdk.AgentConfig{
	Type:    agentsdk.AgentClaudeCode,
	Name:    "Claude Code",
	Command: "claude-agent-acp",
}

agentDefaults := agentsdk.SessionConfig{}
if cfg.LLM.HasAnthropic() {
	agentDefaults.Env = map[string]string{
		"ANTHROPIC_BASE_URL": fmt.Sprintf("http://localhost:%d/api/anthropic", cfg.Port),
		"ANTHROPIC_API_KEY":  "dummy",
		"MLD_PROXY_TOKEN":    s.llmProxy.Token(),
	}
}

s.agentClient = agentsdk.NewClient(agentDefaults, claudeAgent)
s.agentClient.SetProxyBaseURL(fmt.Sprintf("http://localhost:%d", cfg.Port))
```

**Step 3: Add shutdown hook**

In the server's shutdown sequence:
```go
if s.agentClient != nil {
	s.agentClient.Shutdown(ctx)
}
```

**Step 4: Verify it compiles and starts**

Run: `cd backend && go build . && ./my-life-db`
Expected: server starts, existing features work

**Step 5: Commit**

```bash
git add backend/server/
git commit -m "feat(server): initialize Agent Client with ACP and LLM proxy config"
```

---

## Phase 3: Session Storage Migration

### Task 3.1: Create agent_sessions Table

**Files:**
- Create: `backend/db/migration_NNN_agent_sessions.go`

**Context:** Create `agent_sessions`, migrate data from `claude_sessions`, drop old table. Check `backend/db/migrations.go` for the next migration number and pattern.

**Step 1: Read existing migration pattern and current schema**

Read `backend/db/migrations.go` and `backend/db/migration_012_claude_sessions.go`.

**Step 2: Write migration**

```go
func init() {
	registerMigration(NNN, "agent_sessions", func(db *DB) error {
		_, err := db.Exec(`
			CREATE TABLE IF NOT EXISTS agent_sessions (
				id                   TEXT PRIMARY KEY,
				user_id              TEXT NOT NULL DEFAULT '',
				agent_type           TEXT NOT NULL DEFAULT 'claude_code',
				model                TEXT,
				title                TEXT,
				status               TEXT NOT NULL DEFAULT 'active',
				archived_at          INTEGER,
				permission_mode      TEXT,
				always_allowed_tools TEXT,
				last_read_count      INTEGER NOT NULL DEFAULT 0,
				message_count        INTEGER NOT NULL DEFAULT 0,
				token_usage          INTEGER NOT NULL DEFAULT 0,
				created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at           INTEGER,
				raw                  TEXT
			)
		`)
		if err != nil {
			return err
		}

		// Migrate existing data
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

		_, err = db.Exec(`
			CREATE INDEX IF NOT EXISTS idx_agent_sessions_type ON agent_sessions(agent_type);
			CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);
			CREATE INDEX IF NOT EXISTS idx_agent_sessions_archived ON agent_sessions(archived_at);
		`)
		if err != nil {
			return err
		}

		_, err = db.Exec(`DROP TABLE IF EXISTS claude_sessions`)
		return err
	})
}
```

**Step 3: Update all queries referencing `claude_sessions`**

Search: `grep -rn "claude_sessions" backend/`
Update each SQL query to use `agent_sessions` and map column names (e.g., `session_id` → `id`).

**Step 4: Test with fresh database**

Run: `cd backend && rm -rf .my-life-db/ && go run .`
Expected: server starts, migrations run

**Step 5: Commit**

```bash
git add backend/db/
git commit -m "feat(db): migrate claude_sessions to agent_sessions"
```

---

### Task 3.2: Update SessionManager Queries

**Files:**
- Modify: `backend/claude/session_manager.go`

**Step 1: Find all references**

Search: `grep -n "claude_sessions" backend/claude/session_manager.go`

**Step 2: Replace table and column names**

Replace `claude_sessions` → `agent_sessions` and `session_id` → `id` in every SQL query.

**Step 3: Test**

Run: `cd backend && go test -v ./claude/`
Run: `cd backend && rm -rf .my-life-db/ && go run .`
Expected: existing Claude page works

**Step 4: Commit**

```bash
git add backend/claude/
git commit -m "refactor(claude): update SessionManager to use agent_sessions table"
```

---

## Phase 4: Backend API Migration

### Task 4.1: Agent Info + Session Endpoints

**Files:**
- Create: `backend/api/agent_api.go`
- Modify: `backend/api/routes.go`

**Context:** New `/api/agent/*` routes. Initially thin wrappers around existing SessionManager handlers, adding `agent_type` awareness.

**Step 1: Write handlers**

```go
// backend/api/agent_api.go
package api

import (
	"net/http"
	"github.com/gin-gonic/gin"
)

func (h *Handlers) GetAgentInfo(c *gin.Context) {
	agents := h.server.AgentClient().AvailableAgents()
	type resp struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	var out []resp
	for _, a := range agents {
		out = append(out, resp{Type: string(a.Type), Name: a.Name})
	}
	c.JSON(http.StatusOK, gin.H{"agents": out})
}

// Session CRUD handlers — delegate to existing SessionManager
// but add agent_type to responses

func (h *Handlers) GetAgentSessions(c *gin.Context)     { h.ClaudeGetSessions(c) }
func (h *Handlers) CreateAgentSession(c *gin.Context)    { h.ClaudeCreateSession(c) }
func (h *Handlers) GetAgentSession(c *gin.Context)       { h.ClaudeGetSession(c) }
func (h *Handlers) UpdateAgentSession(c *gin.Context)    { h.ClaudeUpdateSession(c) }
func (h *Handlers) DeleteAgentSession(c *gin.Context)    { h.ClaudeDeleteSession(c) }
func (h *Handlers) GetAgentMessages(c *gin.Context)      { h.ClaudeGetMessages(c) }
func (h *Handlers) ArchiveAgentSession(c *gin.Context)   { h.ClaudeArchiveSession(c) }
func (h *Handlers) UnarchiveAgentSession(c *gin.Context) { h.ClaudeUnarchiveSession(c) }
func (h *Handlers) ShareAgentSession(c *gin.Context)     { h.ClaudeShareSession(c) }
func (h *Handlers) UnshareAgentSession(c *gin.Context)   { h.ClaudeUnshareSession(c) }
func (h *Handlers) AgentSessionWS(c *gin.Context)        { h.ClaudeSubscribeWebSocket(c) }
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
	agent.GET("/sessions/:id/messages", handlers.GetAgentMessages)
	agent.POST("/sessions/:id/archive", handlers.ArchiveAgentSession)
	agent.POST("/sessions/:id/unarchive", handlers.UnarchiveAgentSession)
	agent.POST("/sessions/:id/share", handlers.ShareAgentSession)
	agent.DELETE("/sessions/:id/share", handlers.UnshareAgentSession)
	agent.GET("/sessions/:id/ws", handlers.AgentSessionWS)
	agent.GET("/sessions/:id/subscribe", handlers.AgentSessionWS)
}
```

**Step 3: Verify**

Run: `cd backend && go build .`
Test: `curl http://localhost:12345/api/agent/info`

**Step 4: Commit**

```bash
git add backend/api/
git commit -m "feat(api): add /api/agent/* endpoints (delegating to existing handlers)"
```

---

## Phase 5: Frontend Migration

### Task 5.1: Switch API Calls

**Files:**
- All frontend files referencing `/api/claude/`

**Step 1: Find all references**

Search: `grep -rn "/api/claude" frontend/app/`

**Step 2: Replace all occurrences**

Replace `/api/claude/sessions` → `/api/agent/sessions` across all frontend files.

**Step 3: Verify**

Run: `cd frontend && npm run typecheck && npm run lint`
Manually test: sessions load, WebSocket connects, chat works.

**Step 4: Commit**

```bash
git add frontend/
git commit -m "refactor(frontend): switch API calls from /api/claude to /api/agent"
```

---

### Task 5.2: Add Agent Selector

**Files:**
- Modify: `frontend/app/routes/claude.tsx`
- Modify: `frontend/app/components/claude/chat/chat-input.tsx`

**Step 1: Add agent type state**

```tsx
const [agentType, setAgentType] = useState<string>(
  localStorage.getItem('mld-agent-type') || 'claude_code'
)
```

**Step 2: Add selector UI**

Add a dropdown near the permission mode selector. For now only "Claude Code" is available.

**Step 3: Pass agent_type in session creation**

Include `agent_type` in the POST body when creating sessions.

**Step 4: Verify**

Run: `cd frontend && npm run typecheck`
Manually test.

**Step 5: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): add agent type selector to chat page"
```

---

## Phase 6: Inbox Migration

### Task 6.1: Rewrite Inbox to Use Agent Client

**Files:**
- Modify: `backend/agent/agent.go`
- Modify: `backend/server/server.go`

**Step 1: Read current agent.go**

Understand the current `AnalyzeFile` flow and what it returns.

**Step 2: Rewrite using agent client**

Replace the custom agentic loop with `agentClient.RunTask()`:

```go
func (a *Agent) AnalyzeFile(ctx context.Context, filePath string) (*FileIntention, error) {
	result, err := a.agentClient.RunTask(ctx, agentsdk.TaskConfig{
		SessionConfig: agentsdk.SessionConfig{
			Agent:        agentsdk.AgentClaudeCode,
			SystemPrompt: a.buildSystemPrompt(),
			Permissions:  agentsdk.PermissionAuto,
			WorkingDir:   a.dataDir,
		},
		Prompt:  fmt.Sprintf("Analyze the file at %q...", filePath),
		Timeout: 60 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	return a.parseIntention(result.Messages)
}
```

**Step 3: Update constructor**

```go
func New(agentClient *agentsdk.Client, dataDir string, db *db.DB) *Agent
```

**Step 4: Update server.go**

Pass `agentClient` to `agent.New()`.

**Step 5: Test**

Run: `cd backend && go build .`

**Step 6: Commit**

```bash
git add backend/agent/ backend/server/
git commit -m "refactor(agent): rewrite inbox to use Agent Client"
```

---

## Phase 7: Summarize Migration

### Task 7.1: Use LLM Proxy for Summarize

**Files:**
- Modify: `backend/api/ai.go`

**Step 1: Read current ai.go**

Understand the current flow.

**Step 2: Replace with agentClient.Complete()**

```go
func (h *Handlers) Summarize(c *gin.Context) {
	// ... parse request ...

	result, _, err := h.server.AgentClient().Complete(
		c.Request.Context(), "openai", prompt, "gpt-4o-mini",
	)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{"summary": result})
}
```

**Step 3: Test**

Test summarize endpoint.

**Step 4: Commit**

```bash
git add backend/api/ai.go
git commit -m "refactor(ai): migrate summarize to use LLM proxy via Agent Client"
```

---

## Phase 8: Cleanup

### Task 8.1: Remove Deprecated Code

**Files:**
- Remove old `/api/claude/*` route registrations from `routes.go`
- Remove `backend/vendors/openai.go` (if unused)
- Remove direct OpenAI imports from `backend/agent/`
- Update env var documentation
- Rename `MLD_INBOX_AGENT` → `MLD_INBOX_AI`

**Step 1: Search for remaining references**

```bash
grep -rn "vendors.GetOpenAI\|vendors.OpenAI" backend/
grep -rn "/api/claude" backend/api/routes.go
grep -rn "MLD_INBOX_AGENT" backend/
```

**Step 2: Remove each, verify nothing breaks**

Run: `cd backend && go build . && go test ./...`

**Step 3: Update CLAUDE.md**

Update the project's CLAUDE.md to document:
- New package: `backend/agentsdk/`
- New package: `backend/llm/`
- ACP dependency
- Node.js dependency
- Updated routes
- Updated env vars

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove deprecated Claude/OpenAI code, update docs"
```

---

## Implementation Notes

### Key Risk Areas

1. **ACP SDK integration** — The `coder/acp-go-sdk` is pre-1.0. Read the SDK source carefully in Task 2.2. The exact callback signatures, connection setup, and session lifecycle may differ from what's sketched here. Adjust accordingly.

2. **Session migration** — The `claude_sessions` → `agent_sessions` rename touches queries in `session_manager.go`. Test with both fresh database AND existing database with sessions.

3. **Frontend migration must be atomic** — Switch all `/api/claude` → `/api/agent` calls in one commit. Don't leave the app in a half-migrated state.

4. **LLM proxy port** — The proxy runs on the same Gin server. Agent CLIs get `ANTHROPIC_BASE_URL=http://localhost:{PORT}/api/anthropic`. The port must match the actual server port from config.

### What Gets Simpler (Thanks to ACP)

| Before | After |
|--------|-------|
| Custom Claude Code SDK wrapper (500+ lines) | ACP standardizes the protocol |
| Custom message parser (20+ message types) | ACP standardizes message format |
| Custom permission protocol | ACP `RequestPermission` callback |
| Per-agent adapter code | Register binary path, done |
| Custom WebSocket protocol | ACP events → our Event → WebSocket |

### What Stays Complex

- **WebSocket handler** — Client fan-out, reconnect, pagination still needed (reimplemented simpler without page model)
- **Session persistence** — Still need to save/load from `agent_sessions`
- **LLM proxy** — Still custom (credential injection, token auth)
