package explore

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
)

// MCPHandler serves MCP (Model Context Protocol) over streamable HTTP for explore.
type MCPHandler struct {
	service *Service
	token   string // required bearer token; empty disables auth
}

// NewMCPHandler creates a new MCP handler backed by the given explore service.
// If token is non-empty, requests must include "Authorization: Bearer <token>".
func NewMCPHandler(service *Service, token string) *MCPHandler {
	return &MCPHandler{service: service, token: token}
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

// HandleMCP is a gin.HandlerFunc for POST /api/explore/mcp.
// It reads a JSON-RPC 2.0 request from the POST body, dispatches it,
// and writes the JSON-RPC 2.0 response.
func (m *MCPHandler) HandleMCP(c *gin.Context) {
	if m.token != "" {
		auth := c.GetHeader("Authorization")
		if auth != "Bearer "+m.token {
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
		// Notification — no response expected, return 202 Accepted
		c.Status(http.StatusAccepted)
		return
	}

	c.JSON(http.StatusOK, resp)
}

func (m *MCPHandler) handleRequest(req jsonrpcRequest) *jsonrpcResponse {
	switch req.Method {
	case "initialize":
		return m.handleInitialize(req)
	case "notifications/initialized":
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

func (m *MCPHandler) handleInitialize(req jsonrpcRequest) *jsonrpcResponse {
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
			"serverInfo": map[string]any{
				"name":    "mylifedb-explore",
				"version": "1.0.0",
			},
		},
	}
}

func (m *MCPHandler) handleToolsList(req jsonrpcRequest) *jsonrpcResponse {
	tools := []map[string]any{
		{
			"name":        "createPost",
			"description": "Create a new explore post. RENDERING CONTEXT: In the feed, only the first image and the title (max 2 lines) are visible on the post card — no description, no tags, no content. Users decide whether to open a post based solely on the cover image and title. Write a short, intriguing title that sparks curiosity. The first media item is the cover image — make it visually compelling and representative of the post. Content, tags, and additional images are only shown after the user opens the post. IMAGE GUIDELINES: Most readers view posts on mobile devices. Generated images should be mobile-friendly — use large, legible text, bold visuals, high contrast, and avoid tiny details that get lost on small screens. IMAGE SIZE: The feed crops cover images into 3 aspect ratio buckets — portrait (3:4), square (1:1), or landscape (4:3) — based on the image's natural ratio. For best results use one of these sizes: 1080×1440 (3:4 portrait, recommended — takes up the most screen space), 1080×1080 (1:1 square), or 1440×1080 (4:3 landscape). Avoid extreme aspect ratios as they will be cropped significantly.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"author", "title"},
				"properties": map[string]any{
					"author": map[string]any{
						"type":        "string",
						"description": "Author name for the post",
					},
					"title": map[string]any{
						"type":        "string",
						"description": "Short, intriguing title (1-2 lines max). This is the only text visible on the post card in the feed — make it count. Aim to spark curiosity so users want to open the post.",
					},
					"content": map[string]any{
						"type":        "string",
						"description": "Text content of the post (only visible after user opens the post)",
					},
					"mediaType": map[string]any{
						"type":        "string",
						"enum":        []string{"image", "video"},
						"description": "Type of media attached to the post",
					},
					"media": map[string]any{
						"type":        "array",
						"description": "Media files to attach. The FIRST item becomes the cover image shown on the post card — choose the most visually striking image. Each item needs a filename and either content (base64) or path (absolute file path on server).",
						"items": map[string]any{
							"type":     "object",
							"required": []string{"filename"},
							"properties": map[string]any{
								"filename": map[string]any{
									"type":        "string",
									"description": "Filename for the media file",
								},
								"content": map[string]any{
									"type":        "string",
									"description": "Base64-encoded file content",
								},
								"path": map[string]any{
									"type":        "string",
									"description": "Absolute file path on the server (alternative to content — use this for large files)",
								},
							},
						},
					},
					"tags": map[string]any{
						"type":        "array",
						"items":       map[string]any{"type": "string"},
						"description": "Tags to attach to the post (only visible after user opens the post)",
					},
				},
			},
		},
		{
			"name":        "deletePost",
			"description": "Delete an explore post and its associated media files.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"post_id"},
				"properties": map[string]any{
					"post_id": map[string]any{
						"type":        "string",
						"description": "ID of the post to delete",
					},
				},
			},
		},
		{
			"name":        "listPosts",
			"description": "List explore posts in reverse-chronological order with cursor-based pagination.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"cursor": map[string]any{
						"type":        "string",
						"description": "Pagination cursor to fetch older posts (returned as nextCursor from previous call)",
					},
					"limit": map[string]any{
						"type":        "integer",
						"description": "Number of posts to return (default 30, max 100)",
					},
				},
			},
		},
		{
			"name":        "addComment",
			"description": "Add a comment to an existing explore post.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"post_id", "author", "content"},
				"properties": map[string]any{
					"post_id": map[string]any{
						"type":        "string",
						"description": "ID of the post to comment on",
					},
					"author": map[string]any{
						"type":        "string",
						"description": "Author name for the comment",
					},
					"content": map[string]any{
						"type":        "string",
						"description": "Comment text",
					},
				},
			},
		},
		{
			"name":        "addTags",
			"description": "Add tags to an existing explore post. Tags are merged idempotently with existing tags.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"post_id", "tags"},
				"properties": map[string]any{
					"post_id": map[string]any{
						"type":        "string",
						"description": "ID of the post to tag",
					},
					"tags": map[string]any{
						"type":        "array",
						"items":       map[string]any{"type": "string"},
						"description": "Tags to add to the post",
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
	case "createPost":
		return m.callCreatePost(req.ID, params.Arguments)
	case "deletePost":
		return m.callDeletePost(req.ID, params.Arguments)
	case "listPosts":
		return m.callListPosts(req.ID, params.Arguments)
	case "addComment":
		return m.callAddComment(req.ID, params.Arguments)
	case "addTags":
		return m.callAddTags(req.ID, params.Arguments)
	default:
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32602, Message: "unknown tool: " + params.Name},
		}
	}
}

func (m *MCPHandler) callCreatePost(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	author, _ := args["author"].(string)
	title, _ := args["title"].(string)

	if author == "" || title == "" {
		return m.toolError(id, "author and title are required")
	}

	input := CreatePostInput{
		Author: author,
		Title:  title,
	}

	if content, ok := args["content"].(string); ok {
		input.Content = &content
	}
	if mediaType, ok := args["mediaType"].(string); ok {
		input.MediaType = &mediaType
	}

	if mediaRaw, ok := args["media"].([]any); ok {
		for _, item := range mediaRaw {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			filename, _ := m["filename"].(string)
			content, _ := m["content"].(string)
			path, _ := m["path"].(string)
			if filename == "" {
				continue
			}
			if content == "" && path == "" {
				continue
			}
			input.Media = append(input.Media, MediaInput{
				Filename: filename,
				Content:  content,
				Path:     path,
			})
		}
	}

	if tagsRaw, ok := args["tags"].([]any); ok {
		for _, t := range tagsRaw {
			if s, ok := t.(string); ok {
				input.Tags = append(input.Tags, s)
			}
		}
	}

	post, err := m.service.CreatePost(input)
	if err != nil {
		return m.toolError(id, err.Error())
	}

	data, _ := json.Marshal(post)
	return m.toolResult(id, string(data))
}

func (m *MCPHandler) callDeletePost(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	postID, _ := args["post_id"].(string)
	if postID == "" {
		return m.toolError(id, "post_id is required")
	}

	if err := m.service.DeletePost(postID); err != nil {
		return m.toolError(id, err.Error())
	}

	return m.toolResult(id, fmt.Sprintf("Deleted post %s", postID))
}

func (m *MCPHandler) callListPosts(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	limit := 30
	if limitRaw, ok := args["limit"]; ok {
		switch v := limitRaw.(type) {
		case float64:
			limit = int(v)
		case string:
			if parsed, err := strconv.Atoi(v); err == nil {
				limit = parsed
			}
		}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	cursor, _ := args["cursor"].(string)

	var result *db.ExplorePostListResult
	var err error

	if cursor != "" {
		result, err = db.ListExplorePostsBefore(cursor, limit)
	} else {
		result, err = db.ListExplorePostsNewest(limit)
	}
	if err != nil {
		return m.toolError(id, err.Error())
	}

	// Build response with optional nextCursor
	resp := map[string]any{
		"posts":    result.Posts,
		"hasOlder": result.HasOlder,
		"hasNewer": result.HasNewer,
	}

	if result.HasOlder && len(result.Posts) > 0 {
		last := result.Posts[len(result.Posts)-1]
		resp["nextCursor"] = db.CreateExploreCursor(last.CreatedAt, last.ID)
	}

	data, _ := json.Marshal(resp)
	return m.toolResult(id, string(data))
}

func (m *MCPHandler) callAddComment(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	postID, _ := args["post_id"].(string)
	author, _ := args["author"].(string)
	content, _ := args["content"].(string)

	if postID == "" || author == "" || content == "" {
		return m.toolError(id, "post_id, author, and content are required")
	}

	comment, err := m.service.AddComment(postID, author, content)
	if err != nil {
		return m.toolError(id, err.Error())
	}

	data, _ := json.Marshal(comment)
	return m.toolResult(id, string(data))
}

func (m *MCPHandler) callAddTags(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	postID, _ := args["post_id"].(string)
	if postID == "" {
		return m.toolError(id, "post_id is required")
	}

	var tags []string
	if tagsRaw, ok := args["tags"].([]any); ok {
		for _, t := range tagsRaw {
			if s, ok := t.(string); ok {
				tags = append(tags, s)
			}
		}
	}
	if len(tags) == 0 {
		return m.toolError(id, "tags array is required and must not be empty")
	}

	merged, err := m.service.AddTags(postID, tags)
	if err != nil {
		return m.toolError(id, err.Error())
	}

	data, _ := json.Marshal(map[string]any{"postId": postID, "tags": merged})
	return m.toolResult(id, string(data))
}

func (m *MCPHandler) toolResult(id json.RawMessage, text string) *jsonrpcResponse {
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

func (m *MCPHandler) toolError(id json.RawMessage, msg string) *jsonrpcResponse {
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
