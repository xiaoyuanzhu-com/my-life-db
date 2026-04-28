package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// SetupRoutes configures all API routes with handlers
func SetupRoutes(r *gin.Engine, h *Handlers) {
	// Public routes (no auth required)
	public := r.Group("/api")
	{
		// Auth routes - must be public for login flow
		public.POST("/auth/login", h.Login)
		public.POST("/auth/logout", h.Logout)

		// OAuth routes - must be public for OAuth flow
		public.GET("/oauth/authorize", h.OAuthAuthorize)
		public.GET("/oauth/callback", h.OAuthCallback)
		public.POST("/oauth/refresh", h.OAuthRefresh)
		public.GET("/oauth/token", h.OAuthToken)
		public.POST("/oauth/logout", h.OAuthLogout)

		// Public share routes (no auth required)
		public.GET("/share/:token", h.GetSharedSession)
		public.GET("/share/:token/messages", h.GetSharedSessionMessages)

		// Single MCP endpoint — hosts every MyLifeDB tool (validateAgent,
		// generateImage, editImage, createPost, listPosts, ...). Auth: the
		// server's internal MCP token is enforced when callers send an
		// Authorization header (auto-run agents do); requests with no header
		// are accepted (localhost trust — Claude Code CLI on the same host).
		public.POST("/mcp", h.server.MCP().HandleMCP)
		public.GET("/mcp", func(c *gin.Context) {
			c.Status(http.StatusMethodNotAllowed)
		})
	}

	// Protected routes (require auth when auth mode is enabled)
	api := r.Group("/api")
	api.Use(AuthMiddleware())
	{
		// Inbox routes
		api.GET("/inbox", h.GetInbox)
		api.POST("/inbox", h.CreateInboxItem)
		api.GET("/inbox/pinned", h.GetPinnedInboxItems)
		api.GET("/inbox/intentions", h.GetInboxIntentions)
		api.GET("/inbox/:id", h.GetInboxItem)
		api.PUT("/inbox/:id", h.UpdateInboxItem)
		api.DELETE("/inbox/:id", h.DeleteInboxItem)
		api.POST("/inbox/:id/reenrich", h.ReenrichInboxItem)
		api.GET("/inbox/:id/status", h.GetInboxItemStatus)

		// Agent routes
		api.GET("/files/intention", h.GetFileIntention)

		// Digest routes - static routes first
		api.GET("/digest/digesters", h.GetDigesters)
		api.GET("/digest/stats", h.GetDigestStats)
		api.DELETE("/digest/reset/:digester", h.ResetDigester)
		// Wildcard routes use /digest/file/* to avoid conflict with static routes
		api.GET("/digest/file/*path", h.GetDigest)
		api.POST("/digest/file/*path", h.TriggerDigest)

		// Library routes
		api.DELETE("/library/file", h.DeleteLibraryFile)
		api.GET("/library/file-info", h.GetLibraryFileInfo)
		api.POST("/library/pin", h.PinFile)
		api.DELETE("/library/pin", h.UnpinFile)
		api.GET("/library/tree", h.GetLibraryTree)
		api.POST("/library/rename", h.RenameLibraryFile)
		api.POST("/library/move", h.MoveLibraryFile)
		api.POST("/library/folder", h.CreateLibraryFolder)
		api.GET("/library/download", h.DownloadLibraryPath)
		api.GET("/library/root", h.GetLibraryRoot)
		api.POST("/library/extract", h.ExtractArchive)

		// Notifications (SSE)
		api.GET("/notifications/stream", h.NotificationStream)

		// People routes
		api.GET("/people", h.GetPeople)
		api.POST("/people", h.CreatePerson)
		api.GET("/people/:id", h.GetPerson)
		api.PUT("/people/:id", h.UpdatePerson)
		api.DELETE("/people/:id", h.DeletePerson)
		api.POST("/people/:id/merge", h.MergePeople)
		api.POST("/people/embeddings/:id/assign", h.AssignEmbedding)
		api.POST("/people/embeddings/:id/unassign", h.UnassignEmbedding)

		// Search
		api.GET("/search", h.Search)

		// AI routes
		api.POST("/ai/summarize", h.Summarize)

		// Settings
		api.GET("/settings", h.GetSettings)
		api.PUT("/settings", h.UpdateSettings)
		api.POST("/settings", h.ResetSettings)

		// Collectors
		api.GET("/collectors", h.GetCollectors)
		api.PUT("/collectors/:id", h.UpsertCollector)

		// Stats
		api.GET("/stats", h.GetStats)

		// Upload (Simple PUT for small files + TUS for large files)
		api.PUT("/upload/simple/*path", h.SimpleUpload)
		api.POST("/upload/finalize", h.FinalizeUpload)
		api.Any("/upload/tus/*path", h.TUSHandler)

		// Directories
		api.GET("/directories", h.GetDirectories)

		// Apps registry (import catalog)
		api.GET("/apps", h.GetApps)
		api.GET("/apps/:id", h.GetApp)

		// Vendor routes
		api.GET("/vendors/openai/models", h.GetOpenAIModels)

		// ASR routes
		api.POST("/asr", h.ASRHandler)
	}

	// WebSocket routes - need auth but registered on main router
	// Apply auth middleware individually
	wsAuth := AuthMiddleware()
	r.GET("/api/asr/realtime", wsAuth, h.RealtimeASR)
	r.GET("/api/share/:token/subscribe", h.SharedSessionSubscribeWebSocket)

	// Agent routes (new unified API)
	agentRoutes := r.Group("/api/agent")
	agentRoutes.Use(wsAuth)
	{
		agentRoutes.GET("/config", h.GetAgentConfig)
		agentRoutes.GET("/info", h.GetAgentInfo)
		agentRoutes.GET("/sessions", h.GetAgentSessions)
		agentRoutes.GET("/sessions/all", h.GetAgentSessions)
		agentRoutes.POST("/sessions", h.CreateAgentSession)
		agentRoutes.GET("/sessions/:id", h.GetAgentSession)
		agentRoutes.PATCH("/sessions/:id", h.UpdateAgentSession)

		agentRoutes.GET("/sessions/:id/messages", h.GetAgentMessages)
		agentRoutes.GET("/sessions/:id/changed-files", h.GetAgentChangedFiles)
		agentRoutes.POST("/sessions/:id/deactivate", h.DeactivateAgentSession)
		agentRoutes.POST("/sessions/:id/archive", h.ArchiveAgentSession)
		agentRoutes.POST("/sessions/:id/unarchive", h.UnarchiveAgentSession)
		agentRoutes.POST("/sessions/:id/share", h.ShareAgentSession)
		agentRoutes.DELETE("/sessions/:id/share", h.UnshareAgentSession)

		// Per-session attachments for agent prompts (1 GiB cap per file).
		// Files stage under USER_DATA_DIR/sessions/<storageId>/uploads/<filename>.
		// The storageId is minted by the first upload (returned in the response) and
		// included on subsequent uploads + on POST /api/agent/sessions.
		agentRoutes.POST("/attachments", h.UploadAgentAttachment)
		agentRoutes.DELETE("/attachments/:storageId/:filename", h.DeleteAgentAttachment)

		// Auto agent definitions (markdown files with triggers that spawn sessions)
		agentRoutes.GET("/defs", h.ListAutoAgents)
		agentRoutes.GET("/defs/:name", h.GetAutoAgent)
		agentRoutes.PUT("/defs/:name", h.SaveAutoAgent)
		agentRoutes.DELETE("/defs/:name", h.DeleteAutoAgent)
		agentRoutes.POST("/defs/:name/run", h.RunAutoAgent)

		// Skills + MCP listing for the composer + menu.
		agentRoutes.GET("/skills", h.ListSkills)
		agentRoutes.GET("/mcp-servers", h.ListMCPServers)
		agentRoutes.GET("/mcp-servers/:name/tools", h.ListMCPServerTools)
		agentRoutes.PATCH("/mcp-servers/:name", h.UpdateMCPServer)
	}
	r.GET("/api/agent/sessions/:id/subscribe", wsAuth, h.AgentSessionWebSocket)

	// Explore routes
	api.GET("/explore/posts", h.GetExplorePosts)
	api.GET("/explore/posts/:id", h.GetExplorePost)
	api.GET("/explore/posts/:id/comments", h.GetExploreComments)
	api.DELETE("/explore/posts/:id", h.DeleteExplorePost)

	// Explore MCP endpoint — registered in public group (see above)

	// Raw file serving - protected
	r.GET("/raw/*path", wsAuth, h.ServeRawFile)
	r.PUT("/raw/*path", wsAuth, h.SaveRawFile)

	// SQLAR file serving - protected
	r.GET("/sqlar/*path", wsAuth, h.ServeSqlarFile)
}
