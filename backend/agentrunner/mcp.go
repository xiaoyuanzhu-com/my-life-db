package agentrunner

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
)

// MCPHandler serves MCP (Model Context Protocol) over streamable HTTP for
// the auto-run agent system. Currently exposes a single tool, validateAgent,
// that parses an agent definition's frontmatter without touching disk so the
// create-auto-agent skill can pre-flight its output before calling the Write tool.
type MCPHandler struct {
	runner *Runner
	token  string // optional bearer token; empty disables auth
}

// NewMCPHandler creates a new MCP handler backed by the given runner.
// If token is non-empty, requests that include an Authorization header must
// match "Bearer <token>". Requests with no Authorization header are always
// accepted (localhost trust model — the backend binds to localhost by default).
func NewMCPHandler(runner *Runner, token string) *MCPHandler {
	return &MCPHandler{runner: runner, token: token}
}

// JSON-RPC 2.0 types
type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// HandleMCP is a gin.HandlerFunc for POST /api/agent/mcp. It reads a
// JSON-RPC 2.0 request from the POST body, dispatches it, and writes the
// JSON-RPC 2.0 response.
func (m *MCPHandler) HandleMCP(c *gin.Context) {
	// Auth: if a token is configured AND the caller sent an Authorization
	// header, it must match. Absent header is accepted (localhost trust).
	if m.token != "" {
		if auth := c.GetHeader("Authorization"); auth != "" && auth != "Bearer "+m.token {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
	}

	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, jsonrpcResponse{
			JSONRPC: "2.0",
			Error:   &rpcError{Code: -32700, Message: "failed to read request body"},
		})
		return
	}

	var req jsonrpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		c.JSON(http.StatusOK, jsonrpcResponse{
			JSONRPC: "2.0",
			Error:   &rpcError{Code: -32700, Message: "parse error"},
		})
		return
	}

	resp := m.handleRequest(req)
	if resp == nil {
		c.Status(http.StatusAccepted)
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (m *MCPHandler) handleRequest(req jsonrpcRequest) *jsonrpcResponse {
	switch req.Method {
	case "initialize":
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo": map[string]any{
					"name":    "mylifedb-builtin",
					"version": "1.0.0",
				},
			},
		}
	case "notifications/initialized":
		return nil
	case "tools/list":
		return m.handleToolsList(req)
	case "tools/call":
		return m.handleToolsCall(req)
	case "ping":
		return &jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}}
	default:
		if req.ID == nil {
			return nil
		}
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32601, Message: "method not found: " + req.Method},
		}
	}
}

func (m *MCPHandler) handleToolsList(req jsonrpcRequest) *jsonrpcResponse {
	tools := []map[string]any{
		{
			"name": "validateAgent",
			"description": "Parse an agent definition's frontmatter and validate required fields without writing to disk. " +
				"Use this BEFORE writing an agent markdown file to catch syntax errors (wrong trigger type, " +
				"missing schedule on cron, missing path glob on file triggers). " +
				"`agent` and `model` are optional — when omitted, the runner falls back to the global default agent " +
				"(claude_code) and the first gateway model compatible with that agent. " +
				"Returns { valid: bool, error?: string, parsed?: { agent, model, trigger, path, schedule, enabled } } — on success, " +
				"the parsed frontmatter (with `agent` filled in to the default if omitted); on failure, a human-readable error explaining what to fix.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"name", "markdown"},
				"properties": map[string]any{
					"name": map[string]any{
						"type":        "string",
						"description": "Agent folder name (kebab-case). Becomes the subfolder under agents/ and the .md filename stem.",
					},
					"markdown": map[string]any{
						"type":        "string",
						"description": "Full markdown content of the agent definition: YAML frontmatter between --- delimiters, then the prompt body.",
					},
				},
			},
		},
	}
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  map[string]any{"tools": tools},
	}
}

func (m *MCPHandler) handleToolsCall(req jsonrpcRequest) *jsonrpcResponse {
	var params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32602, Message: "invalid params"},
		}
	}

	switch params.Name {
	case "validateAgent":
		return m.callValidateAgent(req.ID, params.Arguments)
	default:
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32602, Message: "unknown tool: " + params.Name},
		}
	}
}

func (m *MCPHandler) callValidateAgent(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	name, _ := args["name"].(string)
	markdown, _ := args["markdown"].(string)

	if name == "" {
		return m.toolResult(id, map[string]any{
			"valid": false,
			"error": "name is required",
		})
	}
	if markdown == "" {
		return m.toolResult(id, map[string]any{
			"valid": false,
			"error": "markdown is required",
		})
	}

	if m.runner == nil {
		return m.toolResult(id, map[string]any{
			"valid": false,
			"error": "agent runner not available",
		})
	}

	def, err := m.runner.ValidateDef(name, []byte(markdown))
	if err != nil {
		return m.toolResult(id, map[string]any{
			"valid": false,
			"error": err.Error(),
		})
	}

	enabled := true
	if def.Enabled != nil {
		enabled = *def.Enabled
	}
	return m.toolResult(id, map[string]any{
		"valid": true,
		"parsed": map[string]any{
			"name":     def.Name,
			"agent":    def.Agent,
			"model":    def.Model,
			"trigger":  def.Trigger,
			"path":     def.Path,
			"schedule": def.Schedule,
			"enabled":  enabled,
		},
	})
}

func (m *MCPHandler) toolResult(id json.RawMessage, value any) *jsonrpcResponse {
	data, _ := json.Marshal(value)
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": string(data)},
			},
		},
	}
}
