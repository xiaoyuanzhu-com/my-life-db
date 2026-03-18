package llm

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestConfig(anthropicKey, openaiKey, proxyToken string) Config {
	return Config{
		Anthropic:  ProviderConfig{APIKey: anthropicKey, BaseURL: "https://api.anthropic.com"},
		OpenAI:     ProviderConfig{APIKey: openaiKey, BaseURL: "https://api.openai.com"},
		ProxyToken: proxyToken,
	}
}

func TestAnthropicProxy_InjectsKey(t *testing.T) {
	var receivedKey string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedKey = r.Header.Get("x-api-key")
		// Verify proxy token was removed from upstream request
		if auth := r.Header.Get("Authorization"); auth != "" {
			t.Errorf("Authorization header leaked to upstream: %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"msg_123","type":"message","content":[{"type":"text","text":"hello"}]}`))
	}))
	defer upstream.Close()

	cfg := Config{
		Anthropic:  ProviderConfig{APIKey: "sk-ant-real-key", BaseURL: upstream.URL},
		ProxyToken: "test-token-123",
	}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer test-token-123")
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if receivedKey != "sk-ant-real-key" {
		t.Errorf("upstream x-api-key = %q, want %q", receivedKey, "sk-ant-real-key")
	}

	body, _ := io.ReadAll(rec.Body)
	if !strings.Contains(string(body), "msg_123") {
		t.Errorf("response body = %q, want to contain msg_123", string(body))
	}
}

func TestAnthropicProxy_PathStripping(t *testing.T) {
	var receivedPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	cfg := Config{
		Anthropic:  ProviderConfig{APIKey: "sk-ant", BaseURL: upstream.URL},
		ProxyToken: "token",
	}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer token")

	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if receivedPath != "/v1/messages" {
		t.Errorf("upstream path = %q, want %q", receivedPath, "/v1/messages")
	}
}

func TestOpenAIProxy_InjectsBearer(t *testing.T) {
	var receivedAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"chatcmpl-123","choices":[{"message":{"content":"hi"}}]}`))
	}))
	defer upstream.Close()

	cfg := Config{
		OpenAI:     ProviderConfig{APIKey: "sk-openai-real", BaseURL: upstream.URL},
		ProxyToken: "test-token",
	}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/openai/v1/chat/completions", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer test-token")

	rec := httptest.NewRecorder()
	proxy.OpenAIHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if receivedAuth != "Bearer sk-openai-real" {
		t.Errorf("upstream Authorization = %q, want %q", receivedAuth, "Bearer sk-openai-real")
	}
}

func TestProxy_InvalidToken_Returns401(t *testing.T) {
	cfg := newTestConfig("sk-ant", "", "correct-token")
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer wrong-token")

	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestProxy_NoToken_Returns401(t *testing.T) {
	cfg := newTestConfig("sk-ant", "", "correct-token")
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader(`{}`))
	// No Authorization header

	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestAnthropicProxy_NoKey_Returns503(t *testing.T) {
	cfg := Config{ProxyToken: "token"} // no Anthropic key
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer token")

	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestOpenAIProxy_NoKey_Returns503(t *testing.T) {
	cfg := Config{ProxyToken: "token"} // no OpenAI key
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/openai/v1/chat/completions", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer token")

	rec := httptest.NewRecorder()
	proxy.OpenAIHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestProxy_Upstream429_ForwardsError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"type":"rate_limit_error","message":"quota exceeded"}}`))
	}))
	defer upstream.Close()

	cfg := Config{
		Anthropic:  ProviderConfig{APIKey: "sk-ant", BaseURL: upstream.URL},
		ProxyToken: "token",
	}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("POST", "/api/anthropic/v1/messages", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer token")

	rec := httptest.NewRecorder()
	proxy.AnthropicHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", rec.Code)
	}

	body, _ := io.ReadAll(rec.Body)
	if !strings.Contains(string(body), "quota exceeded") {
		t.Errorf("body = %q, want to contain 'quota exceeded'", string(body))
	}
}

func TestModelsHandler_ListsProviders(t *testing.T) {
	cfg := newTestConfig("sk-ant", "sk-oai", "token")
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("GET", "/api/llm/v1/models", nil)
	rec := httptest.NewRecorder()
	proxy.ModelsHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "anthropic") {
		t.Error("response missing anthropic")
	}
	if !strings.Contains(body, "openai") {
		t.Error("response missing openai")
	}
}

func TestModelsHandler_EmptyWhenNoKeys(t *testing.T) {
	cfg := Config{ProxyToken: "token"}
	proxy := NewProxy(cfg)

	req := httptest.NewRequest("GET", "/api/llm/v1/models", nil)
	rec := httptest.NewRecorder()
	proxy.ModelsHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, "anthropic") || strings.Contains(body, "openai") {
		t.Errorf("response should be empty, got %q", body)
	}
}

func TestProxy_Token(t *testing.T) {
	cfg := Config{ProxyToken: "my-secret-token"}
	proxy := NewProxy(cfg)

	if proxy.Token() != "my-secret-token" {
		t.Errorf("Token() = %q, want %q", proxy.Token(), "my-secret-token")
	}
}
