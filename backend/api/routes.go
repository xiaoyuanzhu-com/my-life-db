package api

import (
	"github.com/gin-gonic/gin"
)

// SetupRoutes configures all API routes
func SetupRoutes(r *gin.Engine) {
	// API group
	api := r.Group("/api")

	// Auth routes
	api.POST("/auth/login", Login)
	api.POST("/auth/logout", Logout)

	// OAuth routes
	api.GET("/oauth/authorize", OAuthAuthorize)
	api.GET("/oauth/callback", OAuthCallback)
	api.POST("/oauth/refresh", OAuthRefresh) // POST per OAuth 2.0 spec
	api.GET("/oauth/token", OAuthToken)
	api.POST("/oauth/logout", OAuthLogout)

	// Inbox routes
	api.GET("/inbox", GetInbox)
	api.POST("/inbox", CreateInboxItem)
	api.GET("/inbox/pinned", GetPinnedInboxItems)
	api.GET("/inbox/:id", GetInboxItem)
	api.PUT("/inbox/:id", UpdateInboxItem)
	api.DELETE("/inbox/:id", DeleteInboxItem)
	api.POST("/inbox/:id/reenrich", ReenrichInboxItem)
	api.GET("/inbox/:id/status", GetInboxItemStatus)

	// Digest routes - static routes first
	api.GET("/digest/digesters", GetDigesters)
	api.GET("/digest/stats", GetDigestStats)
	api.DELETE("/digest/reset/:digester", ResetDigester)
	// Wildcard routes use /digest/file/* to avoid conflict with static routes
	api.GET("/digest/file/*path", GetDigest)
	api.POST("/digest/file/*path", TriggerDigest)

	// Library routes
	api.DELETE("/library/file", DeleteLibraryFile)
	api.GET("/library/file-info", GetLibraryFileInfo)
	api.POST("/library/pin", PinFile)
	api.DELETE("/library/pin", UnpinFile)
	api.GET("/library/tree", GetLibraryTree)

	// Notifications (SSE)
	api.GET("/notifications/stream", NotificationStream)

	// People routes
	api.GET("/people", GetPeople)
	api.POST("/people", CreatePerson)
	api.GET("/people/:id", GetPerson)
	api.PUT("/people/:id", UpdatePerson)
	api.DELETE("/people/:id", DeletePerson)
	api.POST("/people/:id/merge", MergePeople)
	api.POST("/people/embeddings/:id/assign", AssignEmbedding)
	api.POST("/people/embeddings/:id/unassign", UnassignEmbedding)

	// Search
	api.GET("/search", Search)

	// Settings
	api.GET("/settings", GetSettings)
	api.PUT("/settings", UpdateSettings)
	api.POST("/settings", ResetSettings)

	// Stats
	api.GET("/stats", GetStats)

	// Upload (TUS)
	api.POST("/upload/finalize", FinalizeUpload)
	api.Any("/upload/tus/*path", TUSHandler)

	// Directories
	api.GET("/directories", GetDirectories)

	// Vendor routes
	api.GET("/vendors/openai/models", GetOpenAIModels)

	// Raw file serving
	r.GET("/raw/*path", ServeRawFile)
	r.PUT("/raw/*path", SaveRawFile)

	// SQLAR file serving
	r.GET("/sqlar/*path", ServeSqlarFile)
}
