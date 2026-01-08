package api

import (
	"github.com/labstack/echo/v4"
)

// SetupRoutes configures all API routes
func SetupRoutes(e *echo.Echo) {
	// API group
	api := e.Group("/api")

	// Auth routes
	api.POST("/auth/login", Login)
	api.POST("/auth/logout", Logout)

	// OAuth routes
	api.GET("/oauth/authorize", OAuthAuthorize)
	api.GET("/oauth/callback", OAuthCallback)
	api.GET("/oauth/refresh", OAuthRefresh)
	api.GET("/oauth/token", OAuthToken)

	// Inbox routes
	api.GET("/inbox", GetInbox)
	api.POST("/inbox", CreateInboxItem)
	api.GET("/inbox/pinned", GetPinnedInboxItems)
	api.GET("/inbox/:id", GetInboxItem)
	api.PUT("/inbox/:id", UpdateInboxItem)
	api.DELETE("/inbox/:id", DeleteInboxItem)
	api.POST("/inbox/:id/reenrich", ReenrichInboxItem)
	api.GET("/inbox/:id/status", GetInboxItemStatus)

	// Digest routes
	api.GET("/digest/digesters", GetDigesters)
	api.GET("/digest/stats", GetDigestStats)
	api.POST("/digest/reset/:digester", ResetDigester)
	api.GET("/digest/*", GetDigest)
	api.POST("/digest/*", TriggerDigest)

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
	api.Any("/upload/tus/*", TUSHandler)

	// Directories
	api.GET("/directories", GetDirectories)

	// Vendor routes
	api.GET("/vendors/openai/models", GetOpenAIModels)

	// Raw file serving
	e.GET("/raw/*", ServeRawFile)
	e.PUT("/raw/*", SaveRawFile)

	// SQLAR file serving
	e.GET("/sqlar/*", ServeSqlarFile)
}
