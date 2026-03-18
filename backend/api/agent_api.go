package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// GetAgentInfo returns available agents and their metadata.
// GET /api/agent/info
func (h *Handlers) GetAgentInfo(c *gin.Context) {
	agents := h.server.AgentClient().AvailableAgents()

	type agentResponse struct {
		Type    string `json:"type"`
		Name    string `json:"name"`
		Version string `json:"version,omitempty"`
	}

	var resp []agentResponse
	for _, a := range agents {
		resp = append(resp, agentResponse{
			Type:    string(a.Type),
			Name:    a.Name,
			Version: a.Version,
		})
	}

	c.JSON(http.StatusOK, gin.H{"agents": resp})
}

// --- Session CRUD: delegate to existing Claude handlers ---
// These are thin wrappers that delegate to existing handlers.
// The existing handlers already use the agent_sessions table (after Phase 3).
// Adding agent_type awareness happens incrementally.

func (h *Handlers) GetAgentSessions(c *gin.Context)     { h.ListAllClaudeSessions(c) }
func (h *Handlers) CreateAgentSession(c *gin.Context)    { h.CreateClaudeSession(c) }
func (h *Handlers) GetAgentSession(c *gin.Context)       { h.GetClaudeSession(c) }
func (h *Handlers) UpdateAgentSession(c *gin.Context)    { h.UpdateClaudeSession(c) }
func (h *Handlers) DeleteAgentSession(c *gin.Context)    { h.DeleteClaudeSession(c) }
func (h *Handlers) GetAgentMessages(c *gin.Context)      { h.GetClaudeSessionMessages(c) }
func (h *Handlers) ArchiveAgentSession(c *gin.Context)   { h.ArchiveClaudeSession(c) }
func (h *Handlers) UnarchiveAgentSession(c *gin.Context) { h.UnarchiveClaudeSession(c) }
func (h *Handlers) ShareAgentSession(c *gin.Context)     { h.ShareClaudeSession(c) }
func (h *Handlers) UnshareAgentSession(c *gin.Context)   { h.UnshareClaudeSession(c) }
func (h *Handlers) DeactivateAgentSession(c *gin.Context) { h.DeactivateClaudeSession(c) }

// WebSocket handlers
func (h *Handlers) AgentSessionSubscribe(c *gin.Context) { h.ClaudeSubscribeWebSocket(c) }
