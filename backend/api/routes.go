package api

import (
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

		// Vendor routes
		api.GET("/vendors/openai/models", h.GetOpenAIModels)

		// Claude Code routes
		api.GET("/claude/sessions", h.ListClaudeSessions)
		api.GET("/claude/sessions/all", h.ListAllClaudeSessions)
		api.POST("/claude/sessions", h.CreateClaudeSession)
		api.GET("/claude/sessions/:id", h.GetClaudeSession)
		api.GET("/claude/sessions/:id/messages", h.GetClaudeSessionMessages)
		api.PATCH("/claude/sessions/:id", h.UpdateClaudeSession)
		api.POST("/claude/sessions/:id/deactivate", h.DeactivateClaudeSession)
		api.POST("/claude/sessions/:id/archive", h.ArchiveClaudeSession)
		api.POST("/claude/sessions/:id/unarchive", h.UnarchiveClaudeSession)
		api.DELETE("/claude/sessions/:id", h.DeleteClaudeSession)

		// ASR routes
		api.POST("/asr", h.ASRHandler)
	}

	// WebSocket routes - need auth but registered on main router
	// Apply auth middleware individually
	wsAuth := AuthMiddleware()
	r.GET("/api/claude/sessions/:id/subscribe", wsAuth, h.ClaudeSubscribeWebSocket)
	r.GET("/api/asr/realtime", wsAuth, h.RealtimeASR)

	// Raw file serving - protected
	r.GET("/raw/*path", wsAuth, h.ServeRawFile)
	r.PUT("/raw/*path", wsAuth, h.SaveRawFile)

	// SQLAR file serving - protected
	r.GET("/sqlar/*path", wsAuth, h.ServeSqlarFile)
}
