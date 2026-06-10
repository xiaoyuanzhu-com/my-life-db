// Package agentproxy reverse-proxies agent LLM traffic to the upstream
// gateway (e.g. LiteLLM), injecting the real API key server-side.
// The agent process never sees the upstream API key in its environment
// or in outgoing requests — it only sees a per-server-lifetime token
// used to authenticate to the proxy.
//
// Listens on loopback only and is bound to the lifecycle of the main
// MyLifeDB server (started in server.New, shut down in Server.Shutdown
// after the agent client has closed its sessions).
package agentproxy

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Proxy validates a per-process token from the agent, then forwards the
// request to upstream with the real API key substituted in.
type Proxy struct {
	upstream *url.URL
	apiKey   string // real upstream API key

	mu     sync.RWMutex
	tokens map[string]struct{}

	rp *httputil.ReverseProxy
}

// New builds a proxy that forwards to upstream and injects apiKey.
func New(upstream string, apiKey string) (*Proxy, error) {
	u, err := url.Parse(upstream)
	if err != nil {
		return nil, err
	}
	p := &Proxy{
		upstream: u,
		apiKey:   apiKey,
		tokens:   make(map[string]struct{}),
	}
	p.rp = &httputil.ReverseProxy{
		Director:      p.director,
		FlushInterval: -1, // critical: stream SSE without buffering
		ErrorLog:      log.StdErrorLogger(),
	}
	return p, nil
}

// IssueToken generates a new random token authorising agent traffic.
// Call RevokeToken to retire it (or just let the proxy shut down).
func (p *Proxy) IssueToken() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	tok := "mldb-" + hex.EncodeToString(b[:])
	p.mu.Lock()
	p.tokens[tok] = struct{}{}
	p.mu.Unlock()
	return tok
}

// RevokeToken invalidates a previously issued token.
func (p *Proxy) RevokeToken(tok string) {
	p.mu.Lock()
	delete(p.tokens, tok)
	p.mu.Unlock()
}

// ServeHTTP authenticates the incoming request and forwards it upstream.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	presented := r.Header.Get("x-api-key")
	if presented == "" {
		if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
			presented = strings.TrimPrefix(a, "Bearer ")
		}
	}
	p.mu.RLock()
	_, ok := p.tokens[presented]
	p.mu.RUnlock()
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	p.rp.ServeHTTP(w, r)
}

func (p *Proxy) director(r *http.Request) {
	r.URL.Scheme = p.upstream.Scheme
	r.URL.Host = p.upstream.Host
	r.Host = p.upstream.Host

	// Prepend the upstream path prefix (e.g. /anthropic) to the request path.
	upstreamPath := strings.TrimRight(p.upstream.Path, "/")
	r.URL.Path = upstreamPath + r.URL.Path
	if r.URL.RawPath != "" {
		r.URL.RawPath = upstreamPath + r.URL.RawPath
	}

	// Strip whatever the agent presented and substitute real credentials.
	r.Header.Del("x-api-key")
	r.Header.Del("Authorization")
	r.Header.Set("x-api-key", p.apiKey)
}
