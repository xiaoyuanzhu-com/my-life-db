// Package mcp implements a single MCP (Model Context Protocol) server over
// streamable HTTP. Features register their tools with a Registry; the Server
// owns the JSON-RPC transport, auth, SSE streaming, and tools/list + tools/call
// dispatch. There is one server per backend instance, exposed at /api/mcp,
// advertising itself as `mylifedb-builtin`.
package mcp

import (
	"context"
	"encoding/json"
)

// JSON-RPC 2.0 wire types.

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

// Tool is a single MCP tool registered with the Registry.
//
// InputSchema and OutputSchema are JSON-Schema fragments encoded as
// map[string]any (matching the MCP wire format). Handler receives the parsed
// arguments object and returns a Result. Errors returned by Handler are
// wrapped as MCP tool errors (isError=true) so the model can recover.
type Tool struct {
	Name         string
	Description  string
	InputSchema  map[string]any
	OutputSchema map[string]any
	Handler      func(ctx context.Context, args map[string]any) (Result, error)
}

// Result is a tool-call response. At least one ContentBlock is expected.
// StructuredContent, if non-nil, is emitted as the MCP 2025-06-18
// `structuredContent` field. IsError marks the call as a tool error.
type Result struct {
	Content           []ContentBlock
	StructuredContent map[string]any
	IsError           bool
}

// ContentBlock is one entry in the MCP tool-result `content` array.
// Currently only "text" blocks are emitted by registered tools; the type
// is open-ended to mirror the MCP spec.
type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// TextResult is a convenience for the common case of a single text block.
func TextResult(text string) Result {
	return Result{Content: []ContentBlock{{Type: "text", Text: text}}}
}

// JSONResult marshals value to JSON and returns it as a single text block.
// Marshal errors fall back to an error result.
func JSONResult(value any) Result {
	data, err := json.Marshal(value)
	if err != nil {
		return Result{
			Content: []ContentBlock{{Type: "text", Text: "marshal error: " + err.Error()}},
			IsError: true,
		}
	}
	return Result{Content: []ContentBlock{{Type: "text", Text: string(data)}}}
}

// ErrorResult builds a tool-error result with a single text block.
func ErrorResult(msg string) Result {
	return Result{
		Content: []ContentBlock{{Type: "text", Text: msg}},
		IsError: true,
	}
}
