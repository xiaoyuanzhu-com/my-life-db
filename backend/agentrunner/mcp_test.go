package agentrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/mcp"
)

const validFileAgentMD = `---
agent: claude_code
trigger: file.created
path: "inbox/**"
---

Process the new inbox file.
`

const validCronAgentMD = `---
agent: claude_code
trigger: cron
schedule: "0 9 * * *"
---

Generate a daily summary.
`

// ValidateDef tests — exercises the parse-without-write path that the MCP
// tool depends on.

func TestValidateDef_FileAgent(t *testing.T) {
	r := New(Config{})
	def, err := r.ValidateDef("organize-inbox", []byte(validFileAgentMD))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if def.Name != "organize-inbox" {
		t.Errorf("Name = %q, want %q", def.Name, "organize-inbox")
	}
	if def.Trigger != "file.created" {
		t.Errorf("Trigger = %q, want file.created", def.Trigger)
	}
	if def.Path != "inbox/**" {
		t.Errorf("Path = %q, want inbox/**", def.Path)
	}
}

func TestValidateDef_CronAgent(t *testing.T) {
	r := New(Config{})
	def, err := r.ValidateDef("daily-summary", []byte(validCronAgentMD))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if def.Trigger != "cron" {
		t.Errorf("Trigger = %q, want cron", def.Trigger)
	}
	if def.Schedule != "0 9 * * *" {
		t.Errorf("Schedule = %q, want 0 9 * * *", def.Schedule)
	}
}

func TestValidateDef_DoesNotWriteToDisk(t *testing.T) {
	// ValidateDef takes no AgentsDir — proves it is purely parse-based.
	r := New(Config{AgentsDir: "/nonexistent/path/that/does/not/exist"})
	_, err := r.ValidateDef("any-name", []byte(validFileAgentMD))
	if err != nil {
		t.Fatalf("ValidateDef should not touch disk, got error: %v", err)
	}
}

func TestValidateDef_RejectsCronWithoutSchedule(t *testing.T) {
	r := New(Config{})
	md := `---
agent: claude_code
trigger: cron
---

Some prompt.
`
	if _, err := r.ValidateDef("bad-cron", []byte(md)); err == nil {
		t.Fatal("expected error for cron without schedule")
	}
}

func TestValidateDef_RejectsFileTriggerWithoutPath(t *testing.T) {
	r := New(Config{})
	md := `---
agent: claude_code
trigger: file.created
---

Some prompt.
`
	if _, err := r.ValidateDef("no-path", []byte(md)); err == nil {
		t.Fatal("expected error for file.created without path")
	}
}

func TestValidateDef_MissingAgentFallsBackToDefault(t *testing.T) {
	r := New(Config{})
	md := `---
trigger: cron
schedule: "0 9 * * *"
---

Prompt.
`
	def, err := r.ValidateDef("no-agent", []byte(md))
	if err != nil {
		t.Fatalf("expected no error (agent is optional and defaults to %s), got %v", DefaultAgent, err)
	}
	if def.Agent != DefaultAgent {
		t.Errorf("Agent = %q, want default %q", def.Agent, DefaultAgent)
	}
}

func TestValidateDef_RejectsBadName(t *testing.T) {
	r := New(Config{})
	cases := []string{"", ".hidden", "has/slash", "..", "."}
	for _, name := range cases {
		if _, err := r.ValidateDef(name, []byte(validCronAgentMD)); err == nil {
			t.Errorf("expected error for bad name %q, got nil", name)
		}
	}
}

// MCP handler tests — exercises the JSON-RPC surface the create-auto-agent skill
// calls through.

func newTestRouter(h *MCPHandler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/mcp", h.HandleMCP)
	return r
}

func postJSONRPC(t *testing.T, r *gin.Engine, body string, authHeader string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func unwrapToolResult(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var resp struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal response: %v — body: %s", err, string(body))
	}
	if len(resp.Result.Content) == 0 {
		t.Fatalf("no content in tool result — body: %s", string(body))
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(resp.Result.Content[0].Text), &payload); err != nil {
		t.Fatalf("unmarshal tool payload: %v — text: %s", err, resp.Result.Content[0].Text)
	}
	return payload
}

func TestMCP_Initialize(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), ""))
	w := postJSONRPC(t, r, `{"jsonrpc":"2.0","id":1,"method":"initialize"}`, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	result, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result in response: %v", resp)
	}
	serverInfo, _ := result["serverInfo"].(map[string]any)
	if name, _ := serverInfo["name"].(string); name != "mylifedb-builtin" {
		t.Errorf("serverInfo.name = %q, want mylifedb-builtin", name)
	}
}

func TestMCP_ToolsList_HasValidateAgent(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), ""))
	w := postJSONRPC(t, r, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	found := false
	for _, tool := range resp.Result.Tools {
		if tool.Name == "validate_agent" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("validate_agent tool not found in tools/list — got %+v", resp.Result.Tools)
	}
}

func TestMCP_ValidateAgent_Valid(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), ""))
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "validate_agent",
			"arguments": map[string]any{"name": "organize-inbox", "markdown": validFileAgentMD},
		},
	})
	w := postJSONRPC(t, r, string(body), "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	payload := unwrapToolResult(t, w.Body.Bytes())
	if valid, _ := payload["valid"].(bool); !valid {
		t.Errorf("valid = false, want true — payload: %v", payload)
	}
	parsed, _ := payload["parsed"].(map[string]any)
	if trigger, _ := parsed["trigger"].(string); trigger != "file.created" {
		t.Errorf("parsed.trigger = %q, want file.created", trigger)
	}
}

func TestMCP_ValidateAgent_InvalidReturnsError(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), ""))
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "validate_agent",
			"arguments": map[string]any{
				"name":     "bad-cron",
				"markdown": "---\nagent: claude_code\ntrigger: cron\n---\n\nNo schedule.\n",
			},
		},
	})
	w := postJSONRPC(t, r, string(body), "")
	payload := unwrapToolResult(t, w.Body.Bytes())
	if valid, _ := payload["valid"].(bool); valid {
		t.Errorf("valid = true, want false for cron without schedule")
	}
	if msg, _ := payload["error"].(string); msg == "" {
		t.Errorf("expected non-empty error message")
	}
}

func TestMCP_ValidateAgent_MissingArgs(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), ""))
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_agent","arguments":{}}}`
	w := postJSONRPC(t, r, body, "")
	payload := unwrapToolResult(t, w.Body.Bytes())
	if valid, _ := payload["valid"].(bool); valid {
		t.Errorf("valid = true, want false for missing args")
	}
}

func TestMCP_UnknownTool(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), ""))
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"doesNotExist","arguments":{}}}`
	w := postJSONRPC(t, r, body, "")
	var resp struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Error == nil {
		t.Errorf("expected error for unknown tool")
	}
}

// Auth: no header → accepted (localhost trust). Correct header → accepted.
// Wrong header → rejected.
func TestMCP_Auth_NoHeaderAccepted(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), "secret"))
	w := postJSONRPC(t, r, `{"jsonrpc":"2.0","id":1,"method":"ping"}`, "")
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 (no header should be accepted)", w.Code)
	}
}

func TestMCP_Auth_CorrectHeaderAccepted(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), "secret"))
	w := postJSONRPC(t, r, `{"jsonrpc":"2.0","id":1,"method":"ping"}`, "Bearer secret")
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

func TestMCP_Auth_WrongHeaderRejected(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), "secret"))
	w := postJSONRPC(t, r, `{"jsonrpc":"2.0","id":1,"method":"ping"}`, "Bearer wrong")
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestHandleMCP_PassesSessionIDIntoContext(t *testing.T) {
	var seen string
	h := NewMCPHandler(New(Config{}), "")
	h.ImageGen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
		seen = mcp.SessionIDFromContext(ctx)
		return &ImageGenResult{AbsPath: "/tmp/x.png", RelPath: "x.png", Bytes: 1}, nil
	}
	r := newTestRouter(h)

	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"hi"}}}`
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	req.Header.Set("X-MLD-Session-Id", "sid-from-header")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if seen != "sid-from-header" {
		t.Fatalf("ctx session id = %q, want sid-from-header", seen)
	}
}
