package api

import (
	"github.com/gin-gonic/gin"
)

// SetupRoutes configures all API routes with handlers
func SetupRoutes(r *gin.Engine, h *Handlers) {
	// API group
	api := r.Group("/api")

	// Auth routes
	api.POST("/auth/login", h.Login)
	api.POST("/auth/logout", h.Logout)

	// OAuth routes
	api.GET("/oauth/authorize", h.OAuthAuthorize)
	api.GET("/oauth/callback", h.OAuthCallback)
	api.POST("/oauth/refresh", h.OAuthRefresh) // POST per OAuth 2.0 spec
	api.GET("/oauth/token", h.OAuthToken)
	api.POST("/oauth/logout", h.OAuthLogout)

	// Inbox routes
	api.GET("/inbox", h.GetInbox)
	api.POST("/inbox", h.CreateInboxItem)
	api.GET("/inbox/pinned", h.GetPinnedInboxItems)
	api.GET("/inbox/:id", h.GetInboxItem)
	api.PUT("/inbox/:id", h.UpdateInboxItem)
	api.DELETE("/inbox/:id", h.DeleteInboxItem)
	api.POST("/inbox/:id/reenrich", h.ReenrichInboxItem)
	api.GET("/inbox/:id/status", h.GetInboxItemStatus)

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

	// Stats
	api.GET("/stats", h.GetStats)

	// Upload (TUS)
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
	api.POST("/claude/sessions/:id/messages", h.SendClaudeMessage)
	api.PATCH("/claude/sessions/:id", h.UpdateClaudeSession)
	api.POST("/claude/sessions/:id/deactivate", h.DeactivateClaudeSession)
	api.DELETE("/claude/sessions/:id", h.DeleteClaudeSession)

	// WebSocket routes - register on main router to bypass API group middleware
	r.GET("/api/claude/sessions/:id/ws", h.ClaudeWebSocket)
	r.GET("/api/claude/sessions/:id/subscribe", h.ClaudeSubscribeWebSocket)
	r.GET("/api/asr/realtime", h.RealtimeASR)

	// ASR routes
	api.POST("/asr", h.ASRHandler) // Non-realtime ASR processing

	// Raw file serving
	r.GET("/raw/*path", h.ServeRawFile)
	r.PUT("/raw/*path", h.SaveRawFile)

	// SQLAR file serving
	r.GET("/sqlar/*path", h.ServeSqlarFile)
}
