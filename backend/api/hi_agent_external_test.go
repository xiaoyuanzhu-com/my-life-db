package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

func TestNewHiAgentExternalClientRequiresExplicitPair(t *testing.T) {
	if got := newHiAgentExternalClient(server.HiAgentConfig{}); got != nil {
		t.Fatal("empty hi-agent config must disable the bridge")
	}
	if got := newHiAgentExternalClient(server.HiAgentConfig{
		BaseURL: "http://127.0.0.1:12345",
	}); got != nil {
		t.Fatal("partial hi-agent config must disable the bridge")
	}
}

func TestHiAgentExternalLeaseRegisterAndRelease(t *testing.T) {
	const capability = "per-run-secret"
	var registered bool
	var released bool
	var gotAuth string
	var gotBody map[string]string

	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path == "/api/external-sessions" {
			if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
				t.Fatalf("decode registration: %v", err)
			}
			registered = true
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"slug":"general-weekly-report-friday","owner":"cognition","mcp_url":"/mcp/external","capability":"per-run-secret","expires_at":"2026-08-28T16:00:00Z"}`))
			return
		}
		if r.URL.Path == "/api/external-sessions/general-weekly-report-friday" {
			released = true
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.NotFound(w, r)
	}))
	defer stub.Close()

	client := newHiAgentExternalClient(server.HiAgentConfig{
		BaseURL:      stub.URL,
		SurfaceToken: "surface-secret",
	})
	lease, err := client.register(context.Background(), "weekly report", "weekly-report-friday")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if !registered {
		t.Fatal("registration endpoint was not called")
	}
	if gotAuth != "Bearer surface-secret" {
		t.Fatalf("registration auth = %q", gotAuth)
	}
	if gotBody["title"] != "weekly report" || gotBody["subject"] != "weekly-report-friday" {
		t.Fatalf("registration body = %#v", gotBody)
	}

	mcp := lease.mcpServer()
	if mcp.Http == nil || mcp.Http.Url != stub.URL+"/mcp/external" {
		t.Fatalf("unexpected MCP server: %#v", mcp)
	}
	if len(mcp.Http.Headers) != 1 || mcp.Http.Headers[0].Name != "Authorization" ||
		mcp.Http.Headers[0].Value != "Bearer "+capability {
		t.Fatalf("MCP capability was not scoped to the per-run server: %#v", mcp.Http.Headers)
	}
	if strings.Contains(mcp.Http.Url, capability) {
		t.Fatal("capability must not be placed in the MCP URL")
	}

	if err := lease.release(context.Background()); err != nil {
		t.Fatalf("release: %v", err)
	}
	if !released {
		t.Fatal("release endpoint was not called")
	}
	if gotAuth != "Bearer "+capability {
		t.Fatalf("release auth = %q", gotAuth)
	}
}
