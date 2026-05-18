package agentproxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// upstreamRecorder is a fake LiteLLM that captures the inbound request
// for assertions and replies with a fixed body.
type upstreamRecorder struct {
	gotAuth   string
	gotAPIKey string
	gotPath   string
	gotBody   string
}

func (u *upstreamRecorder) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u.gotAuth = r.Header.Get("Authorization")
		u.gotAPIKey = r.Header.Get("x-api-key")
		u.gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		u.gotBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}
}

func TestProxy_InjectsRealKeyAndStripsAgentAuth(t *testing.T) {
	rec := &upstreamRecorder{}
	upstream := httptest.NewServer(rec.handler())
	defer upstream.Close()

	p, err := New(upstream.URL, "real-upstream-key-XYZ")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	tok := p.IssueToken()

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{"prompt":"hi"}`))
	req.Header.Set("x-api-key", tok)
	req.Header.Set("Authorization", "Bearer "+tok)

	resp := httptest.NewRecorder()
	p.ServeHTTP(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%q", resp.Code, resp.Body.String())
	}
	if rec.gotAPIKey != "real-upstream-key-XYZ" {
		t.Errorf("upstream x-api-key = %q, want real-upstream-key-XYZ", rec.gotAPIKey)
	}
	if strings.Contains(rec.gotAPIKey, tok) || strings.Contains(rec.gotAuth, tok) {
		t.Errorf("agent token leaked upstream: api-key=%q auth=%q", rec.gotAPIKey, rec.gotAuth)
	}
	if rec.gotAuth != "" {
		t.Errorf("upstream Authorization should be stripped, got %q", rec.gotAuth)
	}
	if rec.gotPath != "/v1/messages" {
		t.Errorf("upstream path = %q, want /v1/messages", rec.gotPath)
	}
	if rec.gotBody != `{"prompt":"hi"}` {
		t.Errorf("upstream body = %q, want forwarded request body", rec.gotBody)
	}
}

func TestProxy_RejectsUnknownToken(t *testing.T) {
	rec := &upstreamRecorder{}
	upstream := httptest.NewServer(rec.handler())
	defer upstream.Close()

	p, err := New(upstream.URL, "real-key", nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_ = p.IssueToken() // there's a valid token, but we don't present it

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("x-api-key", "mldb-not-issued")
	resp := httptest.NewRecorder()
	p.ServeHTTP(resp, req)

	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.Code)
	}
	if rec.gotAPIKey != "" {
		t.Errorf("upstream should NOT have been called, but saw x-api-key=%q", rec.gotAPIKey)
	}
}

func TestProxy_RevokeToken(t *testing.T) {
	rec := &upstreamRecorder{}
	upstream := httptest.NewServer(rec.handler())
	defer upstream.Close()

	p, _ := New(upstream.URL, "real-key", nil)
	tok := p.IssueToken()
	p.RevokeToken(tok)

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("x-api-key", tok)
	resp := httptest.NewRecorder()
	p.ServeHTTP(resp, req)

	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("revoked token should be rejected, got status %d", resp.Code)
	}
}

func TestProxy_AcceptsBearerToken(t *testing.T) {
	rec := &upstreamRecorder{}
	upstream := httptest.NewServer(rec.handler())
	defer upstream.Close()

	p, _ := New(upstream.URL, "real-key", nil)
	tok := p.IssueToken()

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+tok) // no x-api-key, only Bearer
	resp := httptest.NewRecorder()
	p.ServeHTTP(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("Bearer token should authenticate, got status %d", resp.Code)
	}
}

func TestServer_BaseURLLoopback(t *testing.T) {
	p, _ := New("http://example.invalid", "k", nil)
	srv, err := Start(p)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	url := srv.BaseURL()
	if !strings.HasPrefix(url, "http://127.0.0.1:") {
		t.Errorf("BaseURL = %q, want http://127.0.0.1:<port> (loopback only)", url)
	}
}
