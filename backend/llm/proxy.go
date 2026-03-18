package llm

import (
	"encoding/json"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Proxy is a reverse proxy that validates proxy tokens and injects
// real LLM provider credentials into upstream requests.
type Proxy struct {
	cfg Config
}

// NewProxy creates a new LLM proxy with the given config.
func NewProxy(cfg Config) *Proxy {
	return &Proxy{cfg: cfg}
}

// Token returns the ephemeral proxy token. Pass this to agent
// processes via the MLD_PROXY_TOKEN env var.
func (p *Proxy) Token() string { return p.cfg.ProxyToken }

// AnthropicHandler returns an http.Handler that proxies Anthropic API requests.
// Strips /api/anthropic prefix, injects x-api-key header, forwards to upstream.
func (p *Proxy) AnthropicHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !p.validateToken(r) {
			writeJSON(w, http.StatusUnauthorized, errorResp{
				Type:    "auth_error",
				Message: "invalid or missing proxy token",
			})
			return
		}
		if !p.cfg.HasAnthropic() {
			writeJSON(w, http.StatusServiceUnavailable, errorResp{
				Type:    "configuration_error",
				Message: "Anthropic API key not configured",
			})
			return
		}

		upstream, err := url.Parse(p.cfg.Anthropic.BaseURL)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResp{
				Type:    "proxy_error",
				Message: "invalid upstream URL",
			})
			return
		}

		proxy := &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL.Scheme = upstream.Scheme
				req.URL.Host = upstream.Host
				req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api/anthropic")
				req.Host = upstream.Host
				// Inject real API key
				req.Header.Set("x-api-key", p.cfg.Anthropic.APIKey)
				// Remove proxy token from upstream request
				req.Header.Del("Authorization")

				log.Info().
					Str("method", req.Method).
					Str("path", req.URL.Path).
					Str("upstream", upstream.Host).
					Msg("llm proxy: anthropic")
			},
		}
		proxy.ServeHTTP(w, r)
	})
}

// OpenAIHandler returns an http.Handler that proxies OpenAI API requests.
// Strips /api/openai prefix, injects Authorization: Bearer header, forwards to upstream.
func (p *Proxy) OpenAIHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !p.validateToken(r) {
			writeJSON(w, http.StatusUnauthorized, errorResp{
				Type:    "auth_error",
				Message: "invalid or missing proxy token",
			})
			return
		}
		if !p.cfg.HasOpenAI() {
			writeJSON(w, http.StatusServiceUnavailable, errorResp{
				Type:    "configuration_error",
				Message: "OpenAI API key not configured",
			})
			return
		}

		upstream, err := url.Parse(p.cfg.OpenAI.BaseURL)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorResp{
				Type:    "proxy_error",
				Message: "invalid upstream URL",
			})
			return
		}

		proxy := &httputil.ReverseProxy{
			Director: func(req *http.Request) {
				req.URL.Scheme = upstream.Scheme
				req.URL.Host = upstream.Host
				req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api/openai")
				req.Host = upstream.Host
				// Inject real API key
				req.Header.Set("Authorization", "Bearer "+p.cfg.OpenAI.APIKey)

				log.Info().
					Str("method", req.Method).
					Str("path", req.URL.Path).
					Str("upstream", upstream.Host).
					Msg("llm proxy: openai")
			},
		}
		proxy.ServeHTTP(w, r)
	})
}

// ModelsHandler returns an http.Handler listing configured LLM providers.
// This endpoint does not require token auth (informational only).
func (p *Proxy) ModelsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		type modelInfo struct {
			ID       string `json:"id"`
			Provider string `json:"provider"`
		}

		var models []modelInfo
		if p.cfg.HasAnthropic() {
			models = append(models, modelInfo{ID: "anthropic", Provider: "anthropic"})
		}
		if p.cfg.HasOpenAI() {
			models = append(models, modelInfo{ID: "openai", Provider: "openai"})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": models})
	})
}

// validateToken checks the Authorization header for the proxy token.
func (p *Proxy) validateToken(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	expected := "Bearer " + p.cfg.ProxyToken
	return auth == expected
}

// errorResp is the JSON error format matching provider conventions.
type errorResp struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, errResp errorResp) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]errorResp{"error": errResp})
}
