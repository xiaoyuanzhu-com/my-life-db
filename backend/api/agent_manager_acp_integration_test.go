package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

const (
	acpStubProcessEnv = "MLD_ACP_STUB_PROCESS"
	acpStubModeEnv    = "MLD_ACP_STUB_MODE"
	acpStubObserveEnv = "MLD_ACP_STUB_OBSERVATION"
)

// TestAgentManagerAutoRunACPInjectionLifecycle is a replayable, package-internal
// cross-repository check. The child process is this test binary running a tiny
// acp.NewAgentSideConnection implementation; it is not a model and it never
// touches the weekly-report artifacts.
//
// Replay requires an isolated hi-agent branch process:
//
//	MLD_HI_AGENT_TEST_URL=http://127.0.0.1:12480
//	MLD_HI_AGENT_TEST_SURFACE_TOKEN=<isolated surface credential>
//	MLD_HI_AGENT_TEST_DATA_DIR=<isolated hi-agent data directory>
//	MLD_SIMPLE_EXTENSION_DIR=<directory containing libsimple.dylib and dict/>
//	go test -tags sqlite_fts5 ./api -run '^TestAgentManagerAutoRunACPInjectionLifecycle$' -count=1 -v
//
// The test skips when those explicit replay inputs are absent. It never falls
// back to the live hi-agent listener or a caller-selected session slug.
func TestAgentManagerAutoRunACPInjectionLifecycle(t *testing.T) {
	routerURL := strings.TrimRight(os.Getenv("MLD_HI_AGENT_TEST_URL"), "/")
	surfaceToken := os.Getenv("MLD_HI_AGENT_TEST_SURFACE_TOKEN")
	routerDataDir := os.Getenv("MLD_HI_AGENT_TEST_DATA_DIR")
	simpleExtensionDir := os.Getenv("MLD_SIMPLE_EXTENSION_DIR")
	if routerURL == "" || surfaceToken == "" || routerDataDir == "" || simpleExtensionDir == "" {
		t.Skip("set MLD_HI_AGENT_TEST_URL, MLD_HI_AGENT_TEST_SURFACE_TOKEN, MLD_HI_AGENT_TEST_DATA_DIR, and MLD_SIMPLE_EXTENSION_DIR for the isolated cross-repo replay")
	}
	for _, path := range []string{
		filepath.Join(simpleExtensionDir, "libsimple.dylib"),
		filepath.Join(simpleExtensionDir, "dict"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("MLD_SIMPLE_EXTENSION_DIR fixture is incomplete: %s: %v", path, err)
		}
	}
	t.Setenv(acpStubProcessEnv, "1")

	mgr, srv, capture := newACPInjectionTestManager(t, routerURL, surfaceToken, simpleExtensionDir)
	serverClosed := false
	t.Cleanup(func() {
		if !serverClosed {
			_ = srv.Shutdown(context.Background())
		}
	})

	t.Run("prompt completion releases after injected MCP call", func(t *testing.T) {
		observation := t.TempDir() + "/complete.json"
		marker := "weekly-report-acp-seam-complete-" + uuid.NewString()
		t.Setenv(acpStubModeEnv, "complete")
		t.Setenv(acpStubObserveEnv, observation)
		mgr.setSessionCreator(newACPStubClient())
		releaseBaseline := capture.releaseCount()

		handle, err := mgr.CreateSession(context.Background(), SessionParams{
			AgentType:  "opencode",
			WorkingDir: t.TempDir(),
			Title:      "isolated ACP seam",
			Message:    marker,
			Source:     "auto",
			AgentName:  "weekly-report-friday",
		})
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		t.Cleanup(func() {
			_ = handle.AcpSession.Close()
			waitDone(t, handle.AcpSession.Done())
		})

		waitDone(t, handle.PromptDone)
		waitFor(t, "external lease release", 10*time.Second, func() bool {
			return capture.releaseCount() == releaseBaseline+1
		})
		assertStubObservation(t, observation, marker)
		assertReceiverEvidence(t, routerURL, routerDataDir, capture.slug(), marker)
		_ = handle.AcpSession.Close()
		waitDone(t, handle.AcpSession.Done())
	})

	t.Run("creation failure releases before returning", func(t *testing.T) {
		observation := t.TempDir() + "/creation-failure.json"
		t.Setenv(acpStubModeEnv, "complete")
		t.Setenv(acpStubObserveEnv, observation)
		releaseBaseline := capture.releaseCount()

		stubClient := agentsdk.NewClient(agentsdk.SessionConfig{}, agentsdk.AgentConfig{
			Type:    agentsdk.AgentOpencode,
			Name:    "missing disposable ACP",
			Command: filepath.Join(t.TempDir(), "does-not-exist"),
		})
		mgr.setSessionCreator(stubClient)

		_, err := mgr.CreateSession(context.Background(), SessionParams{
			AgentType: "opencode",
			Title:     "isolated ACP creation failure",
			Source:    "auto",
			AgentName: "weekly-report-friday",
		})
		if err == nil {
			t.Fatal("CreateSession unexpectedly succeeded with a missing ACP command")
		}
		waitFor(t, "failed-creation lease release", 10*time.Second, func() bool {
			return capture.releaseCount() == releaseBaseline+1
		})
		mgr.setSessionCreator(newACPStubClient())
	})

	t.Run("prompt cancellation releases the lease", func(t *testing.T) {
		observation := t.TempDir() + "/cancel.json"
		t.Setenv(acpStubModeEnv, "block")
		t.Setenv(acpStubObserveEnv, observation)
		mgr.setSessionCreator(newACPStubClient())
		releaseBaseline := capture.releaseCount()

		handle, err := mgr.CreateSession(context.Background(), SessionParams{
			AgentType:  "opencode",
			WorkingDir: t.TempDir(),
			Title:      "isolated ACP cancellation",
			Message:    "wait until the host cancels this prompt",
			Source:     "auto",
			AgentName:  "weekly-report-friday",
		})
		if err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		waitFor(t, "stub prompt start", 10*time.Second, func() bool {
			return observationHas(observation, `"prompt_started":true`)
		})
		if err := handle.AcpSession.Stop(); err != nil {
			t.Fatalf("Stop: %v", err)
		}
		waitDone(t, handle.PromptDone)
		waitFor(t, "cancelled lease release", 10*time.Second, func() bool {
			return capture.releaseCount() == releaseBaseline+1
		})
		_ = handle.AcpSession.Close()
		waitDone(t, handle.AcpSession.Done())
	})

	t.Run("server shutdown releases an empty auto session", func(t *testing.T) {
		observation := t.TempDir() + "/shutdown.json"
		t.Setenv(acpStubModeEnv, "complete")
		t.Setenv(acpStubObserveEnv, observation)
		shutdownClient := &shutdownTrackingSessionCreator{sessionCreator: newACPStubClient()}
		mgr.setSessionCreator(shutdownClient)
		releaseBaseline := capture.releaseCount()

		handle, err := mgr.CreateSession(context.Background(), SessionParams{
			AgentType: "opencode",
			Title:     "isolated ACP shutdown",
			Source:    "auto",
			AgentName: "weekly-report-friday",
		})
		if err != nil {
			_ = srv.Shutdown(context.Background())
			serverClosed = true
			t.Fatalf("CreateSession: %v", err)
		}
		if handle.PromptDone != nil {
			t.Fatal("empty auto session unexpectedly has PromptDone")
		}
		if err := srv.Shutdown(context.Background()); err != nil {
			t.Fatalf("Server.Shutdown: %v", err)
		}
		serverClosed = true
		waitFor(t, "shutdown lease release", 10*time.Second, func() bool {
			return capture.releaseCount() == releaseBaseline+1
		})
		waitFor(t, "injected ACP client shutdown", 10*time.Second, func() bool {
			return shutdownClient.shutdownCount() == 1
		})
		if err := mgr.Shutdown(context.Background()); err != nil {
			t.Fatalf("second AgentManager.Shutdown: %v", err)
		}
		if got := shutdownClient.shutdownCount(); got != 1 {
			t.Fatalf("injected ACP client shutdown count = %d, want exactly one", got)
		}
		_ = handle.AcpSession.Close()
		waitDone(t, handle.AcpSession.Done())
	})
}

// TestACPStubProcess is invoked by agentsdk.Client in the parent test. Its
// stdout is reserved for ACP JSON-RPC; all durable observations go to the
// path supplied by the parent.
func TestACPStubProcess(t *testing.T) {
	if os.Getenv(acpStubProcessEnv) != "1" {
		return
	}

	agent := &acpInjectionStubAgent{
		mode:        os.Getenv(acpStubModeEnv),
		observation: os.Getenv(acpStubObserveEnv),
	}
	conn := acp.NewAgentSideConnection(agent, os.Stdout, os.Stdin)
	agent.conn = conn
	<-conn.Done()
}

type acpInjectionStubAgent struct {
	conn        *acp.AgentSideConnection
	mode        string
	observation string
	mu          sync.Mutex
	externalMCP *acp.McpServerHttpInline
	observed    acpStubObservation
}

type acpStubObservation struct {
	MCPServerCount       int      `json:"mcp_server_count"`
	ExternalMCPFound     bool     `json:"external_mcp_found"`
	CapabilityHeaderSeen bool     `json:"capability_header_seen"`
	URLContainsSecret    bool     `json:"url_contains_capability"`
	PromptStarted        bool     `json:"prompt_started"`
	Prompt               string   `json:"prompt,omitempty"`
	Tools                []string `json:"tools,omitempty"`
	CallResult           string   `json:"call_result,omitempty"`
}

func (a *acpInjectionStubAgent) Authenticate(context.Context, acp.AuthenticateRequest) (acp.AuthenticateResponse, error) {
	return acp.AuthenticateResponse{}, nil
}

func (a *acpInjectionStubAgent) Initialize(context.Context, acp.InitializeRequest) (acp.InitializeResponse, error) {
	return acp.InitializeResponse{
		ProtocolVersion:   acp.ProtocolVersionNumber,
		AgentCapabilities: acp.AgentCapabilities{},
	}, nil
}

func (a *acpInjectionStubAgent) Logout(context.Context, acp.LogoutRequest) (acp.LogoutResponse, error) {
	return acp.LogoutResponse{}, nil
}

func (a *acpInjectionStubAgent) Cancel(context.Context, acp.CancelNotification) error {
	return nil
}

func (a *acpInjectionStubAgent) CloseSession(context.Context, acp.CloseSessionRequest) (acp.CloseSessionResponse, error) {
	return acp.CloseSessionResponse{}, nil
}

func (a *acpInjectionStubAgent) ListSessions(context.Context, acp.ListSessionsRequest) (acp.ListSessionsResponse, error) {
	return acp.ListSessionsResponse{}, nil
}

func (a *acpInjectionStubAgent) NewSession(_ context.Context, params acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	a.mu.Lock()
	a.observed.MCPServerCount = len(params.McpServers)
	for i := range params.McpServers {
		srv := params.McpServers[i]
		if srv.Http == nil || srv.Http.Name != "hi-agent-external-notification" {
			continue
		}
		copy := *srv.Http
		a.externalMCP = &copy
		a.observed.ExternalMCPFound = true
		a.observed.CapabilityHeaderSeen = hasHeader(copy.Headers, "Authorization", "Bearer ")
		a.observed.URLContainsSecret = strings.Contains(copy.Url, "Bearer ") || strings.Contains(copy.Url, "capability")
	}
	a.mu.Unlock()
	a.writeObservation()

	return acp.NewSessionResponse{SessionId: acp.SessionId("stub-session-" + uuid.NewString())}, nil
}

func (a *acpInjectionStubAgent) Prompt(ctx context.Context, params acp.PromptRequest) (acp.PromptResponse, error) {
	a.mu.Lock()
	a.observed.PromptStarted = true
	a.observed.Prompt = promptText(params.Prompt)
	prompt := a.observed.Prompt
	a.mu.Unlock()
	a.writeObservation()

	if a.mode == "block" {
		<-ctx.Done()
		return acp.PromptResponse{StopReason: acp.StopReasonCancelled}, nil
	}

	a.mu.Lock()
	external := a.externalMCP
	a.mu.Unlock()
	if external == nil {
		return acp.PromptResponse{}, fmt.Errorf("session/new did not contain the hi-agent MCP server")
	}
	tools, err := callMCP(ctx, external, "tools/list", map[string]any{})
	if err != nil {
		return acp.PromptResponse{}, fmt.Errorf("tools/list: %w", err)
	}
	var toolList struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(tools["result"], &toolList); err != nil {
		return acp.PromptResponse{}, fmt.Errorf("decode tools/list: %w", err)
	}
	names := make([]string, 0, len(toolList.Tools))
	for _, tool := range toolList.Tools {
		names = append(names, tool.Name)
	}
	a.mu.Lock()
	a.observed.Tools = names
	a.mu.Unlock()

	call, err := callMCP(ctx, external, "tools/call", map[string]any{
		"name": "hi_send_message",
		"arguments": map[string]any{
			"to":      "cognition",
			"message": prompt,
		},
	})
	if err != nil {
		return acp.PromptResponse{}, fmt.Errorf("tools/call: %w", err)
	}
	callResult := string(call["result"])
	a.mu.Lock()
	a.observed.CallResult = callResult
	a.mu.Unlock()
	a.writeObservation()

	if err := a.conn.SessionUpdate(ctx, acp.SessionNotification{
		SessionId: params.SessionId,
		Update:    acp.UpdateAgentMessageText("disposable ACP stub completed"),
	}); err != nil {
		return acp.PromptResponse{}, err
	}
	return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
}

func (a *acpInjectionStubAgent) ResumeSession(context.Context, acp.ResumeSessionRequest) (acp.ResumeSessionResponse, error) {
	return acp.ResumeSessionResponse{}, nil
}

func (a *acpInjectionStubAgent) SetSessionConfigOption(context.Context, acp.SetSessionConfigOptionRequest) (acp.SetSessionConfigOptionResponse, error) {
	return acp.SetSessionConfigOptionResponse{}, nil
}

func (a *acpInjectionStubAgent) SetSessionMode(context.Context, acp.SetSessionModeRequest) (acp.SetSessionModeResponse, error) {
	return acp.SetSessionModeResponse{}, nil
}

func (a *acpInjectionStubAgent) writeObservation() {
	a.mu.Lock()
	data, err := json.Marshal(a.observed)
	path := a.observation
	a.mu.Unlock()
	if err == nil && path != "" {
		_ = os.WriteFile(path, data, 0o600)
	}
}

func callMCP(ctx context.Context, srv *acp.McpServerHttpInline, method string, params map[string]any) (map[string]json.RawMessage, error) {
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      uuid.NewString(),
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.Url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for _, header := range srv.Headers {
		req.Header.Set(header.Name, header.Value)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %s", resp.Status)
	}
	var result map[string]json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if rpcErr, ok := result["error"]; ok {
		return nil, fmt.Errorf("JSON-RPC error: %s", rpcErr)
	}
	return result, nil
}

type leaseCaptureTransport struct {
	base      http.RoundTripper
	mu        sync.Mutex
	slugValue string
	releases  int
}

type shutdownTrackingSessionCreator struct {
	sessionCreator
	mu        sync.Mutex
	shutdowns int
}

func (c *shutdownTrackingSessionCreator) Shutdown(ctx context.Context) error {
	c.mu.Lock()
	c.shutdowns++
	c.mu.Unlock()
	return c.sessionCreator.Shutdown(ctx)
}

func (c *shutdownTrackingSessionCreator) shutdownCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.shutdowns
}

func (c *leaseCaptureTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := c.base
	if base == nil {
		base = http.DefaultTransport
	}
	resp, err := base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	return c.captureResponse(req, resp)
}

func (c *leaseCaptureTransport) captureResponse(req *http.Request, resp *http.Response) (*http.Response, error) {
	if req.URL.Path == "/api/external-sessions" && req.Method == http.MethodPost {
		var data externalRegistrationResponse
		raw, err := readResponseBody(resp)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &data); err != nil {
			return nil, err
		}
		c.mu.Lock()
		c.slugValue = data.Slug
		c.mu.Unlock()
		resp.Body = newReadCloser(raw)
	} else if req.Method == http.MethodDelete && strings.HasPrefix(req.URL.Path, "/api/external-sessions/") {
		c.mu.Lock()
		c.releases++
		c.mu.Unlock()
	}
	return resp, nil
}

func (c *leaseCaptureTransport) slug() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.slugValue
}

func (c *leaseCaptureTransport) releaseCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.releases
}

func newACPInjectionTestManager(t *testing.T, routerURL, surfaceToken, simpleExtensionDir string) (*AgentManager, *server.Server, *leaseCaptureTransport) {
	t.Helper()
	userDir := t.TempDir()
	appDir := t.TempDir()
	srv, err := server.New(&server.Config{
		Port:                0,
		Host:                "127.0.0.1",
		Env:                 "development",
		UserDataDir:         userDir,
		AppDataDir:          appDir,
		DatabasePath:        filepath.Join(appDir, "database.sqlite"),
		SimpleExtensionPath: filepath.Join(simpleExtensionDir, "libsimple.dylib"),
		SimpleDictDir:       filepath.Join(simpleExtensionDir, "dict"),
		FSScanInterval:      time.Hour,
		FSWatchEnabled:      false,
		DisableAgentPool:    true,
		HiAgent: server.HiAgentConfig{
			BaseURL:      routerURL,
			SurfaceToken: surfaceToken,
		},
	})
	if err != nil {
		t.Fatalf("server.New: %v", err)
	}

	capture := &leaseCaptureTransport{}
	mgr := NewAgentManager(srv)
	mgr.externalBridge.httpClient = &http.Client{
		Transport: capture,
		Timeout:   10 * time.Second,
	}
	mgr.setSessionCreator(newACPStubClient())
	return mgr, srv, capture
}

func newACPStubClient() *agentsdk.Client {
	return agentsdk.NewClient(agentsdk.SessionConfig{}, agentsdk.AgentConfig{
		Type:    agentsdk.AgentOpencode,
		Name:    "disposable ACP stub",
		Command: os.Args[0],
		Args:    []string{"-test.run=^TestACPStubProcess$", "-test.v=false"},
	})
}

func assertStubObservation(t *testing.T, path, marker string) {
	t.Helper()
	var obs acpStubObservation
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read ACP observation: %v", err)
	}
	if err := json.Unmarshal(raw, &obs); err != nil {
		t.Fatalf("decode ACP observation: %v", err)
	}
	if !obs.ExternalMCPFound || obs.MCPServerCount < 1 {
		t.Fatalf("session/new did not receive the injected MCP server: %+v", obs)
	}
	if !obs.CapabilityHeaderSeen {
		t.Fatalf("injected MCP server lacked a bearer capability: %+v", obs)
	}
	if obs.URLContainsSecret {
		t.Fatalf("MCP URL contains capability material: %+v", obs)
	}
	if len(obs.Tools) != 1 || obs.Tools[0] != "hi_send_message" {
		t.Fatalf("external MCP tool inventory = %v, want [hi_send_message]", obs.Tools)
	}
	if !strings.Contains(obs.CallResult, "delivered") {
		t.Fatalf("MCP call result = %q, want delivered", obs.CallResult)
	}
	if obs.Prompt != marker {
		t.Fatalf("stub prompt = %q, want marker %q", obs.Prompt, marker)
	}
}

func assertReceiverEvidence(t *testing.T, routerURL, routerDataDir, slug, marker string) {
	t.Helper()
	if slug == "" {
		t.Fatal("registration response did not contain a host-minted slug")
	}
	var response struct {
		Messages []struct {
			From string `json:"from"`
			To   string `json:"to"`
			Text string `json:"text"`
		} `json:"messages"`
	}
	waitFor(t, "receiver mailbox evidence", 10*time.Second, func() bool {
		req, err := http.NewRequest(http.MethodGet, routerURL+"/api/workers/mail?a="+slug+"&b=cognition", nil)
		if err != nil {
			return false
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&response) != nil {
			return false
		}
		for _, msg := range response.Messages {
			if msg.From == slug && msg.To == "cognition" && msg.Text == marker {
				return true
			}
		}
		return false
	})

	mailPath := filepath.Join(routerDataDir, "memory", "raw", "sessions", "mail.jsonl")
	waitFor(t, "durable receiver mail evidence", 10*time.Second, func() bool {
		raw, err := os.ReadFile(mailPath)
		return err == nil && strings.Contains(string(raw), slug) && strings.Contains(string(raw), marker)
	})
}

func observationHas(path, needle string) bool {
	raw, err := os.ReadFile(path)
	return err == nil && strings.Contains(string(raw), needle)
}

func promptText(blocks []acp.ContentBlock) string {
	for _, block := range blocks {
		if block.Text != nil {
			return block.Text.Text
		}
	}
	return ""
}

func hasHeader(headers []acp.HttpHeader, name, prefix string) bool {
	for _, header := range headers {
		if header.Name == name && len(header.Value) > len(prefix) && strings.HasPrefix(header.Value, prefix) {
			return true
		}
	}
	return false
}

func waitDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for ACP session completion")
	}
}

func waitFor(t *testing.T, label string, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", label)
}

// response body helpers live here so the capture transport can inspect a
// registration without consuming the body that register() still decodes.
func readResponseBody(resp *http.Response) ([]byte, error) {
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func newReadCloser(data []byte) *bytesReadCloser {
	return &bytesReadCloser{data: append([]byte(nil), data...)}
}

type bytesReadCloser struct {
	data []byte
	pos  int
}

func (r *bytesReadCloser) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}

func (r *bytesReadCloser) Close() error { return nil }
