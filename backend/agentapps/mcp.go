package agentapps

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// MCPServer is a minimal MCP server over stdio for agent apps.
// It exposes putFile and getFile tools via JSON-RPC 2.0.
type MCPServer struct {
	service *Service
}

// NewMCPServer creates a new MCP server backed by the given service.
func NewMCPServer(service *Service) *MCPServer {
	return &MCPServer{service: service}
}

// jsonrpcRequest is a JSON-RPC 2.0 request.
type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// jsonrpcResponse is a JSON-RPC 2.0 response.
type jsonrpcResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any         `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Run reads JSON-RPC requests from stdin and writes responses to stdout.
func (m *MCPServer) Run() error {
	reader := bufio.NewReader(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)

	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("read error: %w", err)
		}

		var req jsonrpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			// Skip malformed messages
			continue
		}

		resp := m.handleRequest(req)
		if resp != nil {
			if err := encoder.Encode(resp); err != nil {
				return fmt.Errorf("write error: %w", err)
			}
		}
	}
}

func (m *MCPServer) handleRequest(req jsonrpcRequest) *jsonrpcResponse {
	switch req.Method {
	case "initialize":
		return m.handleInitialize(req)
	case "notifications/initialized":
		// Client notification, no response needed
		return nil
	case "tools/list":
		return m.handleToolsList(req)
	case "tools/call":
		return m.handleToolsCall(req)
	case "ping":
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]any{},
		}
	default:
		// Unknown method — notifications don't get responses
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

func (m *MCPServer) handleInitialize(req jsonrpcRequest) *jsonrpcResponse {
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
			"serverInfo": map[string]any{
				"name":    "mylifedb-agent-apps",
				"version": "1.0.0",
			},
		},
	}
}

func (m *MCPServer) handleToolsList(req jsonrpcRequest) *jsonrpcResponse {
	tools := []map[string]any{
		{
			"name":        "putFile",
			"description": "Publish a file to an agent app. Content must be base64-encoded. The file will be served at /apps/<app>/<path>. Use this to publish HTML pages, images, PDFs, or any static assets.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"app", "path", "content"},
				"properties": map[string]any{
					"app": map[string]any{
						"type":        "string",
						"description": "App name (e.g. 'backup', 'monitoring'). Used as the URL prefix: /apps/<app>/",
					},
					"path": map[string]any{
						"type":        "string",
						"description": "File path within the app (e.g. 'index.html', '2026-03-31.html', 'assets/chart.png')",
					},
					"content": map[string]any{
						"type":        "string",
						"description": "Base64-encoded file content",
					},
				},
			},
		},
		{
			"name":        "getFile",
			"description": "Read a file from an agent app. Returns base64-encoded content. Use this to check existing files before updating them.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"app", "path"},
				"properties": map[string]any{
					"app": map[string]any{
						"type":        "string",
						"description": "App name",
					},
					"path": map[string]any{
						"type":        "string",
						"description": "File path within the app",
					},
				},
			},
		},
		{
			"name":        "listFiles",
			"description": "List all files in an agent app, or list all apps if no app name is given.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"app": map[string]any{
						"type":        "string",
						"description": "App name. If omitted, lists all apps.",
					},
				},
			},
		},
		{
			"name":        "deleteFile",
			"description": "Delete a file from an agent app, or delete an entire app if no path is given.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"app"},
				"properties": map[string]any{
					"app": map[string]any{
						"type":        "string",
						"description": "App name",
					},
					"path": map[string]any{
						"type":        "string",
						"description": "File path. If omitted, deletes the entire app.",
					},
				},
			},
		},
		{
			"name":        "validateAgent",
			"description": "Validate an agent definition before saving it. Pass the full markdown content (frontmatter + prompt) and get back validation results with specific, actionable error messages. Always call this before writing to the agents/ directory.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"content"},
				"properties": map[string]any{
					"content": map[string]any{
						"type":        "string",
						"description": "Full markdown content of the agent definition (YAML frontmatter between --- delimiters + prompt body)",
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

func (m *MCPServer) handleToolsCall(req jsonrpcRequest) *jsonrpcResponse {
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
	case "putFile":
		return m.callPutFile(req.ID, params.Arguments)
	case "getFile":
		return m.callGetFile(req.ID, params.Arguments)
	case "listFiles":
		return m.callListFiles(req.ID, params.Arguments)
	case "deleteFile":
		return m.callDeleteFile(req.ID, params.Arguments)
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

func (m *MCPServer) callPutFile(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	app, _ := args["app"].(string)
	path, _ := args["path"].(string)
	content, _ := args["content"].(string)

	if err := m.service.PutFile(app, path, content); err != nil {
		return m.toolError(id, err.Error())
	}

	return m.toolResult(id, fmt.Sprintf("Published %s/%s. Available at /apps/%s/%s", app, path, app, path))
}

func (m *MCPServer) callGetFile(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	app, _ := args["app"].(string)
	path, _ := args["path"].(string)

	content, err := m.service.GetFile(app, path)
	if err != nil {
		return m.toolError(id, err.Error())
	}

	return m.toolResult(id, content)
}

func (m *MCPServer) callListFiles(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	app, _ := args["app"].(string)

	if app == "" {
		apps, err := m.service.ListApps()
		if err != nil {
			return m.toolError(id, err.Error())
		}
		data, _ := json.Marshal(apps)
		return m.toolResult(id, string(data))
	}

	files, err := m.service.ListFiles(app)
	if err != nil {
		return m.toolError(id, err.Error())
	}
	data, _ := json.Marshal(files)
	return m.toolResult(id, string(data))
}

func (m *MCPServer) callDeleteFile(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	app, _ := args["app"].(string)
	path, _ := args["path"].(string)

	if path == "" {
		if err := m.service.DeleteApp(app); err != nil {
			return m.toolError(id, err.Error())
		}
		return m.toolResult(id, fmt.Sprintf("Deleted app %s", app))
	}

	if err := m.service.DeleteFile(app, path); err != nil {
		return m.toolError(id, err.Error())
	}
	return m.toolResult(id, fmt.Sprintf("Deleted %s/%s", app, path))
}

func (m *MCPServer) callValidateAgent(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	content, _ := args["content"].(string)
	if content == "" {
		return m.toolError(id, "content is required")
	}

	result := ValidateAgentDef(content)
	data, _ := json.Marshal(result)
	return m.toolResult(id, string(data))
}

func (m *MCPServer) toolResult(id json.RawMessage, text string) *jsonrpcResponse {
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": text},
			},
		},
	}
}

func (m *MCPServer) toolError(id json.RawMessage, msg string) *jsonrpcResponse {
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": "Error: " + msg},
			},
			"isError": true,
		},
	}
}
