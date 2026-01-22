package models

import "encoding/json"

// SystemInitMessage represents the session initialization system message (subtype: "init").
// This is sent at the start of a session with configuration and available tools.
type SystemInitMessage struct {
	RawJSON
	BaseMessage
	Subtype          string       `json:"subtype,omitempty"` // Always "init"
	Cwd              string       `json:"cwd,omitempty"`
	SessionID        string       `json:"session_id,omitempty"`
	Tools            []string     `json:"tools,omitempty"`
	MCPServers       []MCPServer  `json:"mcp_servers,omitempty"`
	Model            string       `json:"model,omitempty"`
	PermissionMode   string       `json:"permissionMode,omitempty"`
	SlashCommands    []string     `json:"slash_commands,omitempty"`
	APIKeySource     string       `json:"apiKeySource,omitempty"`
	ClaudeCodeVer    string       `json:"claude_code_version,omitempty"`
	OutputStyle      string       `json:"output_style,omitempty"`
	Agents           []string     `json:"agents,omitempty"`
	Skills           []string     `json:"skills,omitempty"`
	Plugins          []PluginInfo `json:"plugins,omitempty"`
}

// MCPServer represents an MCP server status in the init message.
type MCPServer struct {
	Name   string `json:"name"`
	Status string `json:"status"` // "connected" or "disabled"
}

// PluginInfo represents a loaded plugin in the init message.
type PluginInfo struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func (m SystemInitMessage) MarshalJSON() ([]byte, error) {
	if len(m.Raw) > 0 {
		return m.Raw, nil
	}
	type Alias SystemInitMessage
	return json.Marshal(Alias(m))
}
