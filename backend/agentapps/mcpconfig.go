package agentapps

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// MCPConfig represents the .mcp.json file format that Claude Code reads.
type MCPConfig struct {
	McpServers map[string]MCPServerEntry `json:"mcpServers"`
}

// MCPServerEntry is a single MCP server entry in .mcp.json.
type MCPServerEntry struct {
	Type    string   `json:"type"`
	Command string   `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	URL     string   `json:"url,omitempty"`
}

// WriteMCPConfig writes a .mcp.json file to the given directory,
// configuring the agent-apps MCP server. The binaryPath should be
// the path to the my-life-db binary (which supports `mcp-agent-apps` subcommand).
func WriteMCPConfig(dir, binaryPath, userDataDir string, port ...int) error {
	config := MCPConfig{
		McpServers: map[string]MCPServerEntry{
			"agent-apps": {
				Type:    "stdio",
				Command: binaryPath,
				Args:    []string{"mcp-agent-apps", "--user-data-dir", userDataDir},
			},
		},
	}

	// Read existing config if present and merge
	configPath := filepath.Join(dir, ".mcp.json")
	existing := MCPConfig{McpServers: make(map[string]MCPServerEntry)}
	if data, err := os.ReadFile(configPath); err == nil {
		json.Unmarshal(data, &existing)
	}

	// Add/update our entry, preserve others
	if existing.McpServers == nil {
		existing.McpServers = make(map[string]MCPServerEntry)
	}
	existing.McpServers["agent-apps"] = config.McpServers["agent-apps"]

	// Add explore MCP server if port is provided
	if len(port) > 0 && port[0] > 0 {
		existing.McpServers["explore"] = MCPServerEntry{
			Type: "streamable-http",
			URL:  fmt.Sprintf("http://localhost:%d/api/explore/mcp", port[0]),
		}
	}

	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	return os.WriteFile(configPath, data, 0644)
}
