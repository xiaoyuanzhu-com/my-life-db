package agentrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// imageCallTimeout caps how long generateImage / editImage can run before the
// MCP handler aborts the goroutine. Sized slightly above image.go's 5-minute
// HTTP client timeout so the underlying call's own error surface (clearer
// message) wins over a context deadline race.
const imageCallTimeout = 6 * time.Minute

// MCPHandler serves MCP (Model Context Protocol) over streamable HTTP for
// the auto-run agent system. Exposes:
//   - validateAgent: parses an agent definition's frontmatter without touching
//     disk so the create-auto-agent skill can pre-flight its output before
//     calling the Write tool.
//   - generateImage: generates an image via gpt-image-2 through the configured
//     LiteLLM gateway (AGENT_BASE_URL / AGENT_API_KEY) and saves it under
//     USER_DATA_DIR/generated/<date>/.
//   - editImage: edits an existing image via gpt-image-2's /images/edits
//     endpoint, with optional inpainting mask. See image.go.
type MCPHandler struct {
	runner *Runner
	token  string // optional bearer token; empty disables auth

	// ImageGen / ImageEdit, if non-nil, override the default implementations.
	// Used by tests to inject a mock LiteLLM endpoint.
	ImageGen  func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error)
	ImageEdit func(ctx context.Context, req ImageEditRequest) (*ImageGenResult, error)
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

	// tools/call can be slow (image gen takes 30-90s on gpt-image-2). Agent
	// CLIs typically have a ~60s read timeout on MCP HTTP responses, so a
	// blocking application/json reply gets killed mid-flight with a broken
	// pipe and the model sees no result. Per the MCP streamable HTTP spec
	// (rev 2024-11-05), the server may respond with text/event-stream when
	// the client advertises support, sending periodic SSE keepalives while
	// the work runs and the JSON-RPC response as the final event. Use SSE
	// whenever the client accepts it to keep the connection alive.
	if req.Method == "tools/call" && acceptsSSE(c.Request) {
		m.handleToolsCallSSE(c, req)
		return
	}

	resp := m.handleRequest(req)
	if resp == nil {
		c.Status(http.StatusAccepted)
		return
	}
	if req.Method == "tools/call" {
		logToolCallResponse(req, resp)
	}
	c.JSON(http.StatusOK, resp)
}

// acceptsSSE reports whether the request's Accept header includes
// "text/event-stream". Per the MCP streamable HTTP spec, clients that can
// receive SSE responses MUST advertise it here.
func acceptsSSE(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/event-stream")
}

// handleToolsCallSSE responds to a tools/call request as a Server-Sent
// Events stream. The headers + initial 200 OK are flushed immediately so the
// client's read timeout doesn't fire while the tool runs. A keepalive comment
// is sent every 15 seconds. When the tool finishes, the JSON-RPC response is
// emitted as one SSE `data:` event and the stream is closed.
func (m *MCPHandler) handleToolsCallSSE(c *gin.Context, req jsonrpcRequest) {
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		// No flushing support (rare in practice; mostly a defensive guard).
		// Fall back to direct JSON.
		resp := m.handleRequest(req)
		if resp != nil {
			logToolCallResponse(req, resp)
			c.JSON(http.StatusOK, resp)
		} else {
			c.Status(http.StatusAccepted)
		}
		return
	}

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)
	flusher.Flush()

	done := make(chan *jsonrpcResponse, 1)
	go func() {
		// Recover from any panic in the tool handler so the goroutine
		// always sends *something* on done — otherwise the SSE loop hangs
		// waiting forever.
		defer func() {
			if r := recover(); r != nil {
				log.Error().Interface("panic", r).Msg("agent mcp: tools/call panicked")
				done <- &jsonrpcResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Error:   &rpcError{Code: -32000, Message: fmt.Sprintf("internal panic: %v", r)},
				}
			}
		}()
		done <- m.handleRequest(req)
	}()

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case resp := <-done:
			if resp == nil {
				// No response (shouldn't happen for tools/call but handle gracefully).
				return
			}
			logToolCallResponse(req, resp)
			body, err := json.Marshal(resp)
			if err != nil {
				log.Error().Err(err).Msg("agent mcp: marshal SSE response failed")
				return
			}
			if _, err := fmt.Fprintf(c.Writer, "data: %s\n\n", body); err != nil {
				log.Warn().Err(err).Msg("agent mcp: SSE final write failed")
				return
			}
			flusher.Flush()
			return
		case <-keepalive.C:
			if _, err := c.Writer.Write([]byte(": keepalive\n\n")); err != nil {
				log.Warn().Err(err).Msg("agent mcp: SSE keepalive write failed (client likely disconnected)")
				return
			}
			flusher.Flush()
		case <-c.Request.Context().Done():
			log.Warn().Msg("agent mcp: client disconnected during tools/call")
			return
		}
	}
}

// logToolCallResponse writes a structured Info log summarizing what we're
// about to send back for a tools/call. Captures: tool name, response byte
// size, content block count, per-block types/sizes, and whether isError is
// set. Helps diagnose downstream rendering issues (e.g. the model reports
// "no output" when the agent CLI silently dropped an unsupported block).
func logToolCallResponse(req jsonrpcRequest, resp *jsonrpcResponse) {
	var params struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(req.Params, &params)

	bodyBytes, _ := json.Marshal(resp)

	var blockCount int
	var blockTypes []string
	var blockSizes []int
	var isError bool

	if result, ok := resp.Result.(map[string]any); ok {
		if v, ok := result["isError"].(bool); ok {
			isError = v
		}
		if blocks, ok := result["content"].([]map[string]any); ok {
			blockCount = len(blocks)
			for _, b := range blocks {
				t, _ := b["type"].(string)
				blockTypes = append(blockTypes, t)
				switch t {
				case "text":
					if s, _ := b["text"].(string); s != "" {
						blockSizes = append(blockSizes, len(s))
					} else {
						blockSizes = append(blockSizes, 0)
					}
				case "image":
					if s, _ := b["data"].(string); s != "" {
						blockSizes = append(blockSizes, len(s))
					} else {
						blockSizes = append(blockSizes, 0)
					}
				default:
					blockSizes = append(blockSizes, 0)
				}
			}
		}
	}

	log.Info().
		Str("tool", params.Name).
		Int("respBytes", len(bodyBytes)).
		Int("blocks", blockCount).
		Strs("blockTypes", blockTypes).
		Ints("blockSizes", blockSizes).
		Bool("isError", isError).
		Msg("agent mcp: tools/call response")
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
	// Shared output schema for generateImage / editImage. Mirrored by the
	// `structuredContent` field on the tool result and the `[mylifedb-image]`
	// text-block marker. See imageToolResult.
	imageOutputSchema := map[string]any{
		"type":     "object",
		"required": []string{"op", "absPath", "relPath", "mimeType", "bytes"},
		"properties": map[string]any{
			"op":            map[string]any{"type": "string", "enum": []string{"generated", "edited"}},
			"absPath":       map[string]any{"type": "string", "description": "Absolute on-disk path to the saved PNG."},
			"relPath":       map[string]any{"type": "string", "description": "Path relative to USER_DATA_DIR, forward-slashed; usable directly in /raw/<relPath>."},
			"mimeType":      map[string]any{"type": "string", "enum": []string{"image/png"}},
			"bytes":         map[string]any{"type": "integer", "minimum": 0},
			"revisedPrompt": map[string]any{"type": "string", "description": "Empty if the model did not rephrase the prompt."},
		},
	}
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
		{
			"name": "generateImage",
			"description": "Generate a new image from a text prompt using gpt-image-2. " +
				"The image is saved to the user's USER_DATA_DIR/generated/<date>/ folder and the frontend " +
				"renders it inline in the conversation. Use this whenever the user asks for an icon, " +
				"illustration, mockup, diagram, or any visual asset — do NOT write Python/SVG code to fake " +
				"an image when this tool is available.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"prompt"},
				"properties": map[string]any{
					"prompt": map[string]any{
						"type":        "string",
						"description": "Detailed description of the image. Be specific about subject, style, composition, colors.",
					},
					"size": map[string]any{
						"type":        "string",
						"enum":        []string{"1024x1024", "1536x1024", "1024x1536", "auto"},
						"default":     "1024x1024",
						"description": "Image dimensions. Use 1536x1024 for landscape, 1024x1536 for portrait.",
					},
					"quality": map[string]any{
						"type":        "string",
						"enum":        []string{"low", "medium", "high", "auto"},
						"default":     "medium",
						"description": "Higher quality costs more. Default 'medium' (~$0.05/image at 1024x1024). Use 'low' (~$0.006) for drafts; 'high' (~$0.21) only when fidelity matters.",
					},
					"background": map[string]any{
						"type":        "string",
						"enum":        []string{"transparent", "opaque", "auto"},
						"description": "Optional. Use 'transparent' for icons/logos that need a transparent background.",
					},
					"filename": map[string]any{
						"type":        "string",
						"description": "Optional. Filename hint without extension. Defaults to a slug of the prompt.",
					},
				},
			},
			"outputSchema": imageOutputSchema,
		},
		{
			"name": "editImage",
			"description": "Edit an existing image using gpt-image-2. The source image is read from disk by " +
				"absolute path. Use for changing colors, adding/removing elements, applying styles, or " +
				"inpainting (with an optional mask). Output is saved alongside generated images at " +
				"USER_DATA_DIR/generated/<date>/edited-<slug>-<hash>.png and rendered inline in the conversation.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"prompt", "imagePath"},
				"properties": map[string]any{
					"prompt": map[string]any{
						"type":        "string",
						"description": "Edit instruction. Describe the change you want — be specific.",
					},
					"imagePath": map[string]any{
						"type":        "string",
						"description": "Absolute path to the source image (PNG, JPEG, or WebP). Max 20 MB.",
					},
					"maskPath": map[string]any{
						"type":        "string",
						"description": "Optional absolute path to a PNG mask. Transparent pixels mark the regions to edit; opaque pixels are preserved.",
					},
					"size": map[string]any{
						"type":    "string",
						"enum":    []string{"1024x1024", "1536x1024", "1024x1536", "auto"},
						"default": "1024x1024",
					},
					"quality": map[string]any{
						"type":    "string",
						"enum":    []string{"low", "medium", "high", "auto"},
						"default": "medium",
					},
					"background": map[string]any{
						"type": "string",
						"enum": []string{"transparent", "opaque", "auto"},
					},
					"filename": map[string]any{
						"type":        "string",
						"description": "Optional. Filename hint without extension. Defaults to '<source-stem>-edited'.",
					},
				},
			},
			"outputSchema": imageOutputSchema,
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
	case "generateImage":
		return m.callGenerateImage(req.ID, params.Arguments)
	case "editImage":
		return m.callEditImage(req.ID, params.Arguments)
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

func (m *MCPHandler) callGenerateImage(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	prompt, _ := args["prompt"].(string)
	if prompt == "" {
		return m.toolError(id, "prompt is required")
	}
	size, _ := args["size"].(string)
	quality, _ := args["quality"].(string)
	background, _ := args["background"].(string)
	filename, _ := args["filename"].(string)

	gen := m.ImageGen
	if gen == nil {
		gen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
			cfg := config.Get()
			return GenerateImage(ctx, ImageGenConfig{
				BaseURL:     cfg.AgentBaseURL,
				APIKey:      cfg.AgentAPIKey,
				UserDataDir: cfg.UserDataDir,
			}, req)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), imageCallTimeout)
	defer cancel()

	res, err := gen(ctx, ImageGenRequest{
		Prompt:     prompt,
		Size:       size,
		Quality:    quality,
		Background: background,
		Filename:   filename,
	})
	if err != nil {
		return m.toolError(id, err.Error())
	}
	return imageToolResult(id, "Generated", res)
}

func (m *MCPHandler) callEditImage(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	prompt, _ := args["prompt"].(string)
	if prompt == "" {
		return m.toolError(id, "prompt is required")
	}
	imagePath, _ := args["imagePath"].(string)
	if imagePath == "" {
		return m.toolError(id, "imagePath is required")
	}
	maskPath, _ := args["maskPath"].(string)
	size, _ := args["size"].(string)
	quality, _ := args["quality"].(string)
	background, _ := args["background"].(string)
	filename, _ := args["filename"].(string)

	edit := m.ImageEdit
	if edit == nil {
		edit = func(ctx context.Context, req ImageEditRequest) (*ImageGenResult, error) {
			cfg := config.Get()
			return EditImage(ctx, ImageGenConfig{
				BaseURL:     cfg.AgentBaseURL,
				APIKey:      cfg.AgentAPIKey,
				UserDataDir: cfg.UserDataDir,
			}, req)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), imageCallTimeout)
	defer cancel()

	res, err := edit(ctx, ImageEditRequest{
		Prompt:     prompt,
		ImagePath:  imagePath,
		MaskPath:   maskPath,
		Size:       size,
		Quality:    quality,
		Background: background,
		Filename:   filename,
	})
	if err != nil {
		return m.toolError(id, err.Error())
	}
	return imageToolResult(id, "Edited", res)
}

// imageToolResult builds the MCP tool_result for an image operation.
//
// The result carries the same structured payload in TWO places, by design:
//
//  1. `structuredContent` — the MCP 2025-06-18 native field for structured
//     tool results. Spec-aware clients read this directly. (Pre-2025-06-18
//     clients ignore unknown fields, which is harmless.)
//  2. `[mylifedb-image] <JSON>` marker line at the end of the text content
//     block. The MCP spec itself recommends this pattern even when
//     `structuredContent` is set: "For backwards compatibility, a tool that
//     returns structured content SHOULD also return the serialized JSON in a
//     TextContent block." We rely on this fallback because the agent CLI
//     (Claude Code, observed 2026-04-28) drops fields it doesn't recognize
//     when forwarding to ACP — `_meta` and `structuredContent` both vanish
//     today. Text content is the only thing that always survives.
//
// The base64 image bytes are NOT included inline — that would burn ~640K
// text tokens or ~1500 vision tokens per call. The frontend renders the
// image from disk via the existing /raw/<RelPath> endpoint.
func imageToolResult(id json.RawMessage, verb string, res *ImageGenResult) *jsonrpcResponse {
	op := strings.ToLower(verb)

	structured := map[string]any{
		"op":            op,
		"absPath":       res.AbsPath,
		"relPath":       res.RelPath,
		"mimeType":      "image/png",
		"bytes":         res.Bytes,
		"revisedPrompt": res.RevisedPrompt,
	}
	marker, _ := json.Marshal(structured)

	text := fmt.Sprintf("%s image saved to %s\nRelative path (under USER_DATA_DIR): %s\nSize: %s.",
		verb, res.AbsPath, res.RelPath, formatBytes(res.Bytes))
	if res.RevisedPrompt != "" {
		text += "\nModel's revised prompt: " + res.RevisedPrompt
	}
	text += "\n\n[mylifedb-image] " + string(marker)

	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": text},
			},
			"structuredContent": structured,
		},
	}
}

// toolError returns a tool-call result flagged as an error so the model can
// recover rather than treating the error as a transport failure.
func (m *MCPHandler) toolError(id json.RawMessage, msg string) *jsonrpcResponse {
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]any{
			"isError": true,
			"content": []map[string]any{
				{"type": "text", "text": msg},
			},
		},
	}
}

func formatBytes(n int) string {
	const kb = 1024
	const mb = 1024 * 1024
	switch {
	case n >= mb:
		return fmt.Sprintf("%.1f MB", float64(n)/float64(mb))
	case n >= kb:
		return fmt.Sprintf("%.1f KB", float64(n)/float64(kb))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
