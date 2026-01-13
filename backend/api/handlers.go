package api

import "github.com/xiaoyuanzhu-com/my-life-db/server"

// Handlers holds references to server components
type Handlers struct {
	server *server.Server
}

// NewHandlers creates a new Handlers instance with server reference
func NewHandlers(srv *server.Server) *Handlers {
	return &Handlers{server: srv}
}
