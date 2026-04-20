package api

import (
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/agentrunner"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// defToJSON converts an AgentDef into the wire shape used by the frontend.
func defToJSON(d *agentrunner.AgentDef, markdown string) gin.H {
	enabled := true
	if d.Enabled != nil {
		enabled = *d.Enabled
	}
	resp := gin.H{
		"name":     d.Name,
		"agent":    d.Agent,
		"trigger":  d.Trigger,
		"schedule": d.Schedule,
		"path":     d.Path,
		"enabled":  enabled,
		"prompt":   d.Prompt,
		"file":     d.File,
	}
	if markdown != "" {
		resp["markdown"] = markdown
	}
	return resp
}

// ListAutoAgents returns all loaded auto-agent definitions.
// GET /api/agent/defs
func (h *Handlers) ListAutoAgents(c *gin.Context) {
	runner := h.server.AgentRunner()
	if runner == nil {
		c.JSON(http.StatusOK, gin.H{"defs": []any{}})
		return
	}
	defs := runner.Defs()
	out := make([]gin.H, 0, len(defs))
	for _, d := range defs {
		out = append(out, defToJSON(d, ""))
	}
	c.JSON(http.StatusOK, gin.H{"defs": out})
}

// GetAutoAgent returns the parsed def + raw markdown for a single agent.
// GET /api/agent/defs/:name
func (h *Handlers) GetAutoAgent(c *gin.Context) {
	name := c.Param("name")
	runner := h.server.AgentRunner()
	if runner == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "agent runner not available"})
		return
	}
	def, markdown, err := runner.GetDef(name)
	if err != nil {
		log.Error().Err(err).Str("agent", name).Msg("failed to get agent def")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if def == nil && markdown == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "agent not found"})
		return
	}
	if def == nil {
		// Folder exists but def failed to parse — still return the raw markdown
		// so the user can fix it in the editor.
		c.JSON(http.StatusOK, gin.H{
			"name":     name,
			"markdown": string(markdown),
			"parseError": "failed to parse frontmatter",
		})
		return
	}
	c.JSON(http.StatusOK, defToJSON(def, string(markdown)))
}

// SaveAutoAgent writes the markdown body for an agent. Accepts text/markdown
// or application/json with a "markdown" field. Returns the parsed def.
// PUT /api/agent/defs/:name
func (h *Handlers) SaveAutoAgent(c *gin.Context) {
	name := c.Param("name")
	runner := h.server.AgentRunner()
	if runner == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "agent runner not available"})
		return
	}

	var markdown []byte
	contentType := c.ContentType()
	if contentType == "application/json" {
		var req struct {
			Markdown string `json:"markdown"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		markdown = []byte(req.Markdown)
	} else {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read body"})
			return
		}
		markdown = body
	}
	if len(markdown) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "markdown body is required"})
		return
	}

	def, err := runner.SaveDef(name, markdown)
	if err != nil {
		log.Warn().Err(err).Str("agent", name).Msg("failed to save agent def")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, defToJSON(def, string(markdown)))
}

// DeleteAutoAgent removes the agent folder from disk.
// DELETE /api/agent/defs/:name
func (h *Handlers) DeleteAutoAgent(c *gin.Context) {
	name := c.Param("name")
	runner := h.server.AgentRunner()
	if runner == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "agent runner not available"})
		return
	}
	if err := runner.DeleteDef(name); err != nil {
		log.Error().Err(err).Str("agent", name).Msg("failed to delete agent def")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// RunAutoAgent manually triggers an agent once.
// POST /api/agent/defs/:name/run
func (h *Handlers) RunAutoAgent(c *gin.Context) {
	name := c.Param("name")
	runner := h.server.AgentRunner()
	if runner == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "agent runner not available"})
		return
	}
	if err := runner.RunNow(c.Request.Context(), name); err != nil {
		log.Warn().Err(err).Str("agent", name).Msg("failed to run agent")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
