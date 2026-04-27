package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// mcpServerEntry is the wire shape for a single MCP server registered in
// .mcp.json. Only the fields meaningful to the composer UI are surfaced.
type mcpServerEntry struct {
	Name     string `json:"name"`
	Type     string `json:"type,omitempty"`    // "http" | "stdio" (sse rare in practice)
	URL      string `json:"url,omitempty"`     // for http/sse
	Command  string `json:"command,omitempty"` // for stdio
	Disabled bool   `json:"disabled"`
}

// ListMCPServers reads <dataDir>/.mcp.json and returns the registered servers.
//
// GET /api/agent/mcp-servers
func (h *Handlers) ListMCPServers(c *gin.Context) {
	dataDir := h.server.Cfg().UserDataDir
	servers, err := readMCPServers(dataDir)
	if err != nil {
		log.Warn().Err(err).Msg("failed to read .mcp.json")
		c.JSON(http.StatusOK, gin.H{"servers": []mcpServerEntry{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"servers": servers})
}

// UpdateMCPServer toggles a server's `disabled` flag in .mcp.json.
//
// PATCH /api/agent/mcp-servers/:name
// Body: { "disabled": bool }
func (h *Handlers) UpdateMCPServer(c *gin.Context) {
	name := c.Param("name")
	var req struct {
		Disabled *bool `json:"disabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Disabled == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "disabled is required"})
		return
	}
	dataDir := h.server.Cfg().UserDataDir
	if err := setMCPServerDisabled(dataDir, name, *req.Disabled); err != nil {
		log.Warn().Err(err).Str("server", name).Msg("failed to update .mcp.json")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func readMCPServers(dataDir string) ([]mcpServerEntry, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, ".mcp.json"))
	if err != nil {
		return nil, err
	}
	var doc struct {
		MCPServers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	out := make([]mcpServerEntry, 0, len(doc.MCPServers))
	for name, cfg := range doc.MCPServers {
		entry := mcpServerEntry{Name: name}
		if v, ok := cfg["type"].(string); ok {
			entry.Type = v
		}
		if v, ok := cfg["url"].(string); ok {
			entry.URL = v
		}
		if v, ok := cfg["command"].(string); ok {
			entry.Command = v
		}
		if v, ok := cfg["disabled"].(bool); ok {
			entry.Disabled = v
		}
		out = append(out, entry)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func setMCPServerDisabled(dataDir, name string, disabled bool) error {
	path := filepath.Join(dataDir, ".mcp.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	// Decode into a generic map so we round-trip unknown fields untouched.
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	servers, _ := doc["mcpServers"].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
		doc["mcpServers"] = servers
	}
	entry, _ := servers[name].(map[string]any)
	if entry == nil {
		return os.ErrNotExist
	}
	if disabled {
		entry["disabled"] = true
	} else {
		// Removing the key keeps the file tidy when re-enabled.
		delete(entry, "disabled")
	}
	servers[name] = entry

	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(body, '\n'), 0644)
}
