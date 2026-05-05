package agentproxy

import (
	"context"
	"net"
	"net/http"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Server runs a Proxy on a loopback-only listener.
type Server struct {
	proxy    *Proxy
	server   *http.Server
	listener net.Listener
}

// Start binds 127.0.0.1 on an OS-picked free port and begins serving the
// proxy in a background goroutine. The listener is ready before Start
// returns, so BaseURL can be passed to child processes immediately.
func Start(p *Proxy) (*Server, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &http.Server{
		Handler:           p,
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          log.StdErrorLogger(),
		// Intentionally no WriteTimeout / IdleTimeout — would kill long
		// streaming responses (Anthropic SSE turns can run for minutes).
	}
	ps := &Server{proxy: p, server: s, listener: ln}
	go func() {
		if err := s.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Error().Err(err).Msg("agent proxy serve error")
		}
	}()
	log.Info().Str("addr", ln.Addr().String()).Msg("agent proxy started")
	return ps, nil
}

// BaseURL is what agents use as e.g. ANTHROPIC_BASE_URL. Always
// http://127.0.0.1:<port>, never with a path.
func (s *Server) BaseURL() string {
	return "http://" + s.listener.Addr().String()
}

// Proxy returns the underlying proxy for token issuance.
func (s *Server) Proxy() *Proxy { return s.proxy }

// Shutdown stops accepting new connections and waits up to ctx for in-flight
// requests to drain. Streaming responses are cut off when ctx expires.
func (s *Server) Shutdown(ctx context.Context) error {
	return s.server.Shutdown(ctx)
}
