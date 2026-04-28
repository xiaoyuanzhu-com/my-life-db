package mcptools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeMCPServer mimics the JSON-RPC subset we use: initialize + tools/list.
// Returns plain application/json (not SSE) — that's the simpler half of the
// streamable HTTP transport.
func fakeMCPServer(t *testing.T, tools []map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "initialize":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": req.ID,
				"result": map[string]any{"protocolVersion": "2024-11-05"},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": req.ID,
				"result": map[string]any{"tools": tools},
			})
		default:
			http.Error(w, "bad method", 400)
		}
	}))
}

// writeMCPJSON drops a .mcp.json into dir with the given server map.
func writeMCPJSON(t *testing.T, dir string, servers map[string]any) {
	t.Helper()
	body, _ := json.MarshalIndent(map[string]any{"mcpServers": servers}, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, ".mcp.json"), body, 0644); err != nil {
		t.Fatalf("write .mcp.json: %v", err)
	}
}

func TestProbeHTTP_RoundTripsTools(t *testing.T) {
	srv := fakeMCPServer(t, []map[string]any{
		{"name": "ping", "description": "ping the server"},
		{"name": "echo", "description": "echo a message", "inputSchema": map[string]any{"type": "object"}},
	})
	defer srv.Close()

	dir := t.TempDir()
	writeMCPJSON(t, dir, map[string]any{
		"fake": map[string]any{"type": "http", "url": srv.URL},
	})

	c := New(dir, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	tools, err := c.GetTools(ctx, "fake")
	if err != nil {
		t.Fatalf("GetTools: %v", err)
	}
	if len(tools) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(tools))
	}
	if tools[0].Name != "ping" || tools[1].Name != "echo" {
		t.Fatalf("unexpected tool names: %+v", tools)
	}
}

func TestGetTools_HitsCacheOnSecondCall(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		var req struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		if req.Method == "tools/list" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": req.ID,
				"result": map[string]any{"tools": []map[string]any{{"name": "x"}}},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": req.ID,
			"result": map[string]any{"protocolVersion": "2024-11-05"},
		})
	}))
	defer srv.Close()

	dir := t.TempDir()
	writeMCPJSON(t, dir, map[string]any{
		"fake": map[string]any{"type": "http", "url": srv.URL},
	})
	c := New(dir, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := c.GetTools(ctx, "fake"); err != nil {
		t.Fatal(err)
	}
	first := hits
	if _, err := c.GetTools(ctx, "fake"); err != nil {
		t.Fatal(err)
	}
	if hits != first {
		t.Fatalf("cache miss on second call: hits=%d first=%d", hits, first)
	}
}

func TestGetTools_RejectsDisabledServer(t *testing.T) {
	dir := t.TempDir()
	writeMCPJSON(t, dir, map[string]any{
		"fake": map[string]any{"type": "http", "url": "http://example", "disabled": true},
	})
	c := New(dir, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	_, err := c.GetTools(ctx, "fake")
	if err == nil {
		t.Fatal("expected error for disabled server")
	}
}

func TestGetTools_HeadersResolverInjected(t *testing.T) {
	var seenAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if v := r.Header.Get("Authorization"); v != "" {
			seenAuth = v
		}
		var req struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")
		if req.Method == "tools/list" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"tools": []any{}},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
	}))
	defer srv.Close()

	dir := t.TempDir()
	writeMCPJSON(t, dir, map[string]any{
		"fake": map[string]any{"type": "http", "url": srv.URL},
	})
	c := New(dir, func(spec ServerSpec) map[string]string {
		return map[string]string{"Authorization": "Bearer secret"}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := c.GetTools(ctx, "fake"); err != nil {
		t.Fatal(err)
	}
	if seenAuth != "Bearer secret" {
		t.Fatalf("expected Authorization header, got %q", seenAuth)
	}
}
