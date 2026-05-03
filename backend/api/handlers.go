package api

import "github.com/xiaoyuanzhu-com/my-life-db/server"

// Handlers holds references to server components and the agent session manager.
type Handlers struct {
	server   *server.Server
	agentMgr *AgentManager
}

// NewHandlers creates a new Handlers instance wired to the given server.
// Constructs the AgentManager, which owns the in-memory ACP session state.
func NewHandlers(srv *server.Server) *Handlers {
	mgr := NewAgentManager(srv)
	if fs := srv.FrameStore(); fs != nil {
		mgr.SetFrameStore(fs)
	}
	return &Handlers{
		server:   srv,
		agentMgr: mgr,
	}
}

// AgentMgr exposes the session manager so external wiring (e.g. agentrunner
// auto-run in main.go) can create sessions through the same entrypoint.
func (h *Handlers) AgentMgr() *AgentManager {
	return h.agentMgr
}
