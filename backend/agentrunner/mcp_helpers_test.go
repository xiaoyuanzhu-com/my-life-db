package agentrunner

import (
	"context"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/mcp"
)

// MCPHandler is a test-only shim that mirrors the pre-refactor agentrunner
// MCPHandler API so existing tests need no rewrites. Production code uses
// agentrunner.RegisterTools + mcp.NewServer directly via server.Server.
//
// HandleMCP rebuilds the registry on each request so test mutations of
// ImageGen / ImageEdit between handler construction and the call take effect.
type MCPHandler struct {
	runner    *Runner
	token     string
	ImageGen  func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error)
	ImageEdit func(ctx context.Context, req ImageEditRequest) (*ImageGenResult, error)
}

// NewMCPHandler creates a test handler that wraps the central mcp.Server.
func NewMCPHandler(runner *Runner, token string) *MCPHandler {
	return &MCPHandler{runner: runner, token: token}
}

// HandleMCP serves a single MCP request. The registry is built fresh per
// call so any post-construction mock injection is visible.
func (h *MCPHandler) HandleMCP(c *gin.Context) {
	reg := mcp.NewRegistry()
	RegisterTools(reg, h.runner, &ToolOptions{
		ImageGen:  h.ImageGen,
		ImageEdit: h.ImageEdit,
	})
	srv := mcp.NewServer(reg, h.token)
	srv.HandleMCP(c)
}
