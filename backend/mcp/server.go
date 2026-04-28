package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ServerName is the value advertised in the MCP `serverInfo.name` field.
// Clients see this as the server identifier (tools become
// `mcp__mylifedb-builtin__<tool>` in Claude Code's allowlist namespace).
const ServerName = "mylifedb-builtin"

// ServerVersion is advertised in `serverInfo.version`.
const ServerVersion = "1.0.0"

// protocolVersion advertised in initialize. Matches the streamable-HTTP spec
// revision the rest of the codebase targets.
const protocolVersion = "2024-11-05"

// toolCallTimeout caps how long a single tools/call may run before the server
// aborts. Sized for the slowest tool currently registered (image generation,
// ~30-90s typical, ~5min worst case via the upstream HTTP timeout).
const toolCallTimeout = 6 * time.Minute

// keepaliveInterval is how often the SSE path sends a `: keepalive\n\n`
// comment frame to keep proxy and client read-timers from firing.
const keepaliveInterval = 15 * time.Second

// Server serves MCP over streamable HTTP for a Registry of tools.
//
// Auth model: if Token is non-empty AND the caller sent an Authorization
// header, it must match `Bearer <Token>`. Requests with no Authorization
// header are accepted (localhost trust — the backend binds to localhost by
// default and Claude Code on the same host calls without a header). This
// matches the previous agentrunner behavior; explore's stricter
// "always-require-when-configured" mode is intentionally dropped because
// the same token guards both surfaces and Claude Code never sends one.
type Server struct {
	reg   *Registry
	token string
}

// NewServer wraps a registry as an HTTP handler. token is optional.
func NewServer(reg *Registry, token string) *Server {
	return &Server{reg: reg, token: token}
}

// Registry returns the registry the server dispatches to. Useful for callers
// that need to enumerate tool names (e.g. allowlist generation).
func (s *Server) Registry() *Registry { return s.reg }

// HandleMCP is a gin.HandlerFunc for POST /api/mcp. It reads a JSON-RPC 2.0
// request, dispatches it, and writes either a single JSON response or an
// SSE stream for tools/call requests when the client advertises support.
func (s *Server) HandleMCP(c *gin.Context) {
	if s.token != "" {
		if auth := c.GetHeader("Authorization"); auth != "" && auth != "Bearer "+s.token {
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

	// tools/call can be slow (image gen 30-90s on gpt-image-2). MCP
	// streamable-HTTP lets us reply with SSE, sending periodic keepalive
	// comments so the client's read timeout doesn't kill the request
	// mid-flight. Use SSE whenever the client advertises Accept:
	// text/event-stream.
	if req.Method == "tools/call" && acceptsSSE(c.Request) {
		s.handleToolsCallSSE(c, req)
		return
	}

	resp := s.handleRequest(c.Request.Context(), req)
	if resp == nil {
		c.Status(http.StatusAccepted)
		return
	}
	if req.Method == "tools/call" {
		logToolCallResponse(req, resp)
	}
	c.JSON(http.StatusOK, resp)
}

func acceptsSSE(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept"), "text/event-stream")
}

func (s *Server) handleToolsCallSSE(c *gin.Context, req jsonrpcRequest) {
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		// Defensive: gin's writer always implements Flusher in practice.
		resp := s.handleRequest(c.Request.Context(), req)
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
		defer func() {
			if r := recover(); r != nil {
				log.Error().Interface("panic", r).Msg("mcp: tools/call panicked")
				done <- &jsonrpcResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Error:   &rpcError{Code: -32000, Message: fmt.Sprintf("internal panic: %v", r)},
				}
			}
		}()
		done <- s.handleRequest(c.Request.Context(), req)
	}()

	keepalive := time.NewTicker(keepaliveInterval)
	defer keepalive.Stop()

	for {
		select {
		case resp := <-done:
			if resp == nil {
				return
			}
			logToolCallResponse(req, resp)
			body, err := json.Marshal(resp)
			if err != nil {
				log.Error().Err(err).Msg("mcp: marshal SSE response failed")
				return
			}
			if _, err := fmt.Fprintf(c.Writer, "data: %s\n\n", body); err != nil {
				log.Warn().Err(err).Msg("mcp: SSE final write failed")
				return
			}
			flusher.Flush()
			return
		case <-keepalive.C:
			if _, err := c.Writer.Write([]byte(": keepalive\n\n")); err != nil {
				log.Warn().Err(err).Msg("mcp: SSE keepalive write failed (client likely disconnected)")
				return
			}
			flusher.Flush()
		case <-c.Request.Context().Done():
			log.Warn().Msg("mcp: client disconnected during tools/call")
			return
		}
	}
}

func (s *Server) handleRequest(ctx context.Context, req jsonrpcRequest) *jsonrpcResponse {
	switch req.Method {
	case "initialize":
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": protocolVersion,
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo": map[string]any{
					"name":    ServerName,
					"version": ServerVersion,
				},
			},
		}
	case "notifications/initialized":
		return nil
	case "tools/list":
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]any{"tools": s.reg.schemas()},
		}
	case "tools/call":
		return s.handleToolsCall(ctx, req)
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

func (s *Server) handleToolsCall(ctx context.Context, req jsonrpcRequest) *jsonrpcResponse {
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

	tool, ok := s.reg.Get(params.Name)
	if !ok {
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32602, Message: "unknown tool: " + params.Name},
		}
	}

	callCtx, cancel := context.WithTimeout(ctx, toolCallTimeout)
	defer cancel()

	res, err := tool.Handler(callCtx, params.Arguments)
	if err != nil {
		return resultToResponse(req.ID, ErrorResult(err.Error()))
	}
	return resultToResponse(req.ID, res)
}

// resultToResponse converts a Result into the wire-level jsonrpcResponse.
func resultToResponse(id json.RawMessage, r Result) *jsonrpcResponse {
	content := make([]map[string]any, 0, len(r.Content))
	for _, b := range r.Content {
		entry := map[string]any{"type": b.Type}
		if b.Text != "" {
			entry["text"] = b.Text
		}
		content = append(content, entry)
	}
	result := map[string]any{"content": content}
	if r.IsError {
		result["isError"] = true
	}
	if r.StructuredContent != nil {
		result["structuredContent"] = r.StructuredContent
	}
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	}
}

// logToolCallResponse logs a structured summary of a tools/call response
// for debugging downstream rendering issues. Cheap; runs on every call.
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
		Msg("mcp: tools/call response")
}
