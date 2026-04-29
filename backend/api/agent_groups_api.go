package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ListAgentSessionGroups returns all groups in sort order.
// GET /api/agent/groups
func (h *Handlers) ListAgentSessionGroups(c *gin.Context) {
	groups, err := db.ListAgentSessionGroups()
	if err != nil {
		log.Error().Err(err).Msg("failed to list agent session groups")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list groups"})
		return
	}
	if groups == nil {
		groups = []db.AgentSessionGroupRecord{}
	}
	c.JSON(http.StatusOK, gin.H{"groups": groups})
}

// CreateAgentSessionGroup creates a new group.
// POST /api/agent/groups  body: {name}
func (h *Handlers) CreateAgentSessionGroup(c *gin.Context) {
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	g, err := db.CreateAgentSessionGroup(name)
	if err != nil {
		log.Error().Err(err).Msg("failed to create agent session group")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create group"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"group": g})
}

// UpdateAgentSessionGroup renames a group.
// PATCH /api/agent/groups/:id  body: {name}
func (h *Handlers) UpdateAgentSessionGroup(c *gin.Context) {
	id := c.Param("id")
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	if err := db.RenameAgentSessionGroup(id, name); err != nil {
		log.Error().Err(err).Str("id", id).Msg("failed to rename group")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to rename group"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeleteAgentSessionGroup deletes a group; sessions in it become ungrouped.
// DELETE /api/agent/groups/:id
func (h *Handlers) DeleteAgentSessionGroup(c *gin.Context) {
	id := c.Param("id")
	if err := db.DeleteAgentSessionGroup(id); err != nil {
		log.Error().Err(err).Str("id", id).Msg("failed to delete group")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete group"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ReorderAgentSessionGroups sets sort_order = 0..N-1 in the given ID order.
// PUT /api/agent/groups/order  body: {ids: [...]}
func (h *Handlers) ReorderAgentSessionGroups(c *gin.Context) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := db.ReorderAgentSessionGroups(req.IDs); err != nil {
		log.Error().Err(err).Msg("failed to reorder groups")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to reorder groups"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
