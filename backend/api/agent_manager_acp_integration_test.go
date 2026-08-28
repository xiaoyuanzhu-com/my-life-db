package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
		mustSetSessionCreator(t, mgr, newACPStubClient())
		registrationBaseline := capture.registrationCount()
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
		if got := capture.registrationCount(); got != registrationBaseline+1 {
			t.Fatalf("registrations = %d, want %d", got, registrationBaseline+1)
		}
		assertStubObservation(t, observation, marker, routerURL+capture.mcpPath())
		capture.assertLatestLeaseLifecycle(t)
		assertReceiverEvidence(t, routerURL, routerDataDir, capture.slug(), marker)
		assertReleasedCapabilityRejected(t, routerURL, capture)
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
		mustSetSessionCreator(t, mgr, stubClient)

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
		mustSetSessionCreator(t, mgr, newACPStubClient())
	})

	t.Run("prompt cancellation releases the lease", func(t *testing.T) {
		observation := t.TempDir() + "/cancel.json"
		t.Setenv(acpStubModeEnv, "block")
		t.Setenv(acpStubObserveEnv, observation)
		mustSetSessionCreator(t, mgr, newACPStubClient())
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
		mustSetSessionCreator(t, mgr, shutdownClient)
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

func TestAgentManagerSessionCreatorCoordination(t *testing.T) {
	t.Run("server owned creator is not closed by manager shutdown", func(t *testing.T) {
		serverOwned := &creatorLifecycleProbe{}
		mgr := newCreatorLifecycleTestManager(serverOwned, false)

		client, release, err := mgr.acquireSessionCreator()
		if err != nil {
			t.Fatalf("acquireSessionCreator: %v", err)
		}
		if client != serverOwned {
			t.Fatal("acquireSessionCreator returned the wrong creator")
		}

		shutdownDone := make(chan error, 1)
		go func() {
			shutdownDone <- mgr.Shutdown(context.Background())
		}()
		waitFor(t, "manager shutdown admission close", time.Second, func() bool {
			mgr.agentClientMu.Lock()
			defer mgr.agentClientMu.Unlock()
			return mgr.agentClientClosed
		})
		select {
		case err := <-shutdownDone:
			t.Fatalf("Shutdown returned before the active create released: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		if got := serverOwned.shutdownCount(); got != 0 {
			t.Fatalf("server-owned creator shutdown count while active = %d, want 0", got)
		}

		release()
		if err := <-shutdownDone; err != nil {
			t.Fatalf("Shutdown: %v", err)
		}
		if got := serverOwned.shutdownCount(); got != 0 {
			t.Fatalf("server-owned creator shutdown count = %d, want 0", got)
		}
	})

	t.Run("manager owned replacement is closed once after active create", func(t *testing.T) {
		serverOwned := &creatorLifecycleProbe{}
		firstInjected := &creatorLifecycleProbe{}
		secondInjected := &creatorLifecycleProbe{}
		rejectedReplacement := &creatorLifecycleProbe{}
		mgr := newCreatorLifecycleTestManager(serverOwned, false)

		if err := mgr.setSessionCreator(firstInjected); err != nil {
			t.Fatalf("set first injected creator: %v", err)
		}
		if got := serverOwned.shutdownCount(); got != 0 {
			t.Fatalf("server-owned creator shutdown during replacement = %d, want 0", got)
		}
		if err := mgr.setSessionCreator(secondInjected); err != nil {
			t.Fatalf("set second injected creator: %v", err)
		}
		if got := firstInjected.shutdownCount(); got != 1 {
			t.Fatalf("replaced manager-owned creator shutdown count = %d, want 1", got)
		}

		client, release, err := mgr.acquireSessionCreator()
		if err != nil {
			t.Fatalf("acquireSessionCreator: %v", err)
		}
		if client != secondInjected {
			t.Fatal("acquireSessionCreator returned the wrong injected creator")
		}
		if err := mgr.setSessionCreator(rejectedReplacement); err == nil ||
			!strings.Contains(err.Error(), "create operation") {
			t.Fatalf("active replacement error = %v", err)
		}
		if got := rejectedReplacement.shutdownCount(); got != 0 {
			t.Fatalf("rejected replacement shutdown count = %d, want caller-owned 0", got)
		}

		shutdownDone := make(chan error, 1)
		go func() {
			shutdownDone <- mgr.Shutdown(context.Background())
		}()
		waitFor(t, "manager shutdown admission close", time.Second, func() bool {
			mgr.agentClientMu.Lock()
			defer mgr.agentClientMu.Unlock()
			return mgr.agentClientClosed
		})
		select {
		case err := <-shutdownDone:
			t.Fatalf("Shutdown returned before the active create released: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		if got := secondInjected.shutdownCount(); got != 0 {
			t.Fatalf("injected creator shutdown count while active = %d, want 0", got)
		}

		release()
		if err := <-shutdownDone; err != nil {
			t.Fatalf("Shutdown: %v", err)
		}
		if got := secondInjected.shutdownCount(); got != 1 {
			t.Fatalf("injected creator shutdown count = %d, want 1", got)
		}
		if err := mgr.Shutdown(context.Background()); err != nil {
			t.Fatalf("idempotent Shutdown: %v", err)
		}
		if got := secondInjected.shutdownCount(); got != 1 {
			t.Fatalf("idempotent shutdown count = %d, want 1", got)
		}
		if _, _, err := mgr.acquireSessionCreator(); !errors.Is(err, errAgentManagerShuttingDown) {
			t.Fatalf("post-shutdown acquire error = %v", err)
		}
		if _, err := mgr.CreateSession(context.Background(), SessionParams{
			Source:    "auto",
			AgentName: "weekly-report-friday",
		}); !errors.Is(err, errAgentManagerShuttingDown) {
			t.Fatalf("post-shutdown CreateSession error = %v", err)
		}
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
	ExternalMCPURL       string   `json:"external_mcp_url,omitempty"`
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
		a.observed.ExternalMCPURL = copy.Url
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
	base             http.RoundTripper
	mu               sync.Mutex
	slugValue        string
	ownerValue       string
	mcpPathValue     string
	capabilityValue  string
	expiresAtValue   time.Time
	registrationAuth string
	registrations    int
	releases         int
	releaseAuth      string
	releaseStatus    int
}

type shutdownTrackingSessionCreator struct {
	sessionCreator
	mu        sync.Mutex
	shutdowns int
}

type creatorLifecycleProbe struct {
	mu        sync.Mutex
	shutdowns int
}

func (c *creatorLifecycleProbe) CreateSession(context.Context, agentsdk.SessionConfig) (agentsdk.Session, error) {
	return nil, fmt.Errorf("creatorLifecycleProbe.CreateSession must not be called")
}

func (c *creatorLifecycleProbe) Shutdown(context.Context) error {
	c.mu.Lock()
	c.shutdowns++
	c.mu.Unlock()
	return nil
}

func (c *creatorLifecycleProbe) shutdownCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.shutdowns
}

func newCreatorLifecycleTestManager(client sessionCreator, owned bool) *AgentManager {
	activeCreatesDone := make(chan struct{})
	close(activeCreatesDone)
	return &AgentManager{
		agentClient:       client,
		agentClientOwned:  owned,
		activeCreatesDone: activeCreatesDone,
		shutdownCtx:       context.Background(),
	}
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
		c.ownerValue = data.Owner
		c.mcpPathValue = data.MCPURL
		c.capabilityValue = data.Capability
		c.expiresAtValue = data.ExpiresAt
		c.registrationAuth = req.Header.Get("Authorization")
		c.registrations++
		c.mu.Unlock()
		resp.Body = newReadCloser(raw)
	} else if req.Method == http.MethodDelete && strings.HasPrefix(req.URL.Path, "/api/external-sessions/") {
		c.mu.Lock()
		c.releases++
		c.releaseAuth = req.Header.Get("Authorization")
		c.releaseStatus = resp.StatusCode
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

func (c *leaseCaptureTransport) registrationCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.registrations
}

func (c *leaseCaptureTransport) mcpPath() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.mcpPathValue
}

func (c *leaseCaptureTransport) assertLatestLeaseLifecycle(t *testing.T) {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ownerValue != "cognition" {
		t.Fatalf("registration owner = %q, want cognition", c.ownerValue)
	}
	if c.slugValue == "" || c.slugValue == c.ownerValue {
		t.Fatalf("registration slug/owner binding = %q/%q", c.slugValue, c.ownerValue)
	}
	if c.mcpPathValue == "" || c.capabilityValue == "" || !c.expiresAtValue.After(time.Now()) {
		t.Fatalf("registration lease is incomplete: mcp=%q capability=%t expiry=%s", c.mcpPathValue, c.capabilityValue != "", c.expiresAtValue)
	}
	if c.registrationAuth != "Bearer "+os.Getenv("MLD_HI_AGENT_TEST_SURFACE_TOKEN") {
		t.Fatalf("registration authorization did not use the isolated surface credential")
	}
	if c.releaseAuth != "Bearer "+c.capabilityValue {
		t.Fatalf("release authorization did not use the returned per-run capability")
	}
	if c.releaseStatus != http.StatusNoContent {
		t.Fatalf("release status = %d, want 204", c.releaseStatus)
	}
}

func (c *leaseCaptureTransport) releasedMCP() (string, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.mcpPathValue, c.capabilityValue
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
		Transport:     capture,
		Timeout:       10 * time.Second,
		CheckRedirect: rejectExternalRedirect,
	}
	mustSetSessionCreator(t, mgr, newACPStubClient())
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

func assertStubObservation(t *testing.T, path, marker, wantMCPURL string) {
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
	if obs.ExternalMCPURL != wantMCPURL {
		t.Fatalf("injected MCP URL = %q, want host-returned %q", obs.ExternalMCPURL, wantMCPURL)
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

func mustSetSessionCreator(t *testing.T, mgr *AgentManager, client sessionCreator) {
	t.Helper()
	if err := mgr.setSessionCreator(client); err != nil {
		t.Fatalf("setSessionCreator: %v", err)
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

func assertReleasedCapabilityRejected(t *testing.T, routerURL string, capture *leaseCaptureTransport) {
	t.Helper()
	mcpPath, capability := capture.releasedMCP()
	body := strings.NewReader(`{"jsonrpc":"2.0","id":"released","method":"tools/list","params":{}}`)
	req, err := http.NewRequest(http.MethodPost, routerURL+mcpPath, body)
	if err != nil {
		t.Fatalf("build post-release MCP request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+capability)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post-release MCP request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("post-release MCP status = %d, want 401", resp.StatusCode)
	}
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
