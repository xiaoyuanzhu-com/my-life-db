package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// SetupRoutes configures all API routes with handlers.
//
// Auth model (post-Connect):
//
//   - "none" (default): all APIs are open
//   - "password":      AuthMiddleware enforces an owner session cookie on every
//                      /api/* route except the password-login + public ones
//
// Third-party OAuth ("Connect" protocol) used to live here; it has been moved
// out of the backend entirely to the cloud gateway. The backend is now a
// user-agnostic data store. The /webhook/*, /webdav/*, /s3/* integration
// surfaces still authenticate via integration credentials (a separate concept
// from Connect OAuth tokens); they remain mounted but will migrate to the
// gateway in a later pass.
func SetupRoutes(r *gin.Engine, h *Handlers) {
	auth := h.AuthMiddleware()

	// =========================================================================
	// Outside `/api/` — byte I/O surfaces
	// =========================================================================
	// Raw file serving — owner-only when password mode is on; open otherwise.
	r.GET("/raw/*path", auth, h.ServeRawFile)
	r.PUT("/raw/*path", auth, h.SaveRawFile)
	r.GET("/sqlar/*path", auth, h.ServeSqlarFile)

	// Integration surfaces — non-OAuth ingestion endpoints. Each route
	// is mounted unconditionally and gated per-request by
	// RequireSurfaceEnabled, which reads the live settings toggle and
	// 404s when off. Flipping the toggle in the UI takes effect on the
	// very next request — no restart needed.
	webhookGuard := RequireSurfaceEnabled(h.server, surfaceWebhook)
	r.POST("/webhook/:credentialId/*subpath", webhookGuard, h.WebhookIngest)
	r.PUT("/webhook/:credentialId/*subpath", webhookGuard, h.WebhookIngest)

	webdavGuard := RequireSurfaceEnabled(h.server, surfaceWebDAV)
	// One handler for every WebDAV verb. gin's Any() covers the
	// standard methods; the WebDAV-specific verbs (PROPFIND, PROPPATCH,
	// MKCOL, COPY, MOVE, LOCK, UNLOCK) must be registered explicitly
	// via Handle().
	r.Any("/webdav/*path", webdavGuard, h.WebDAVHandler)
	for _, m := range []string{"PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK"} {
		r.Handle(m, "/webdav/*path", webdavGuard, h.WebDAVHandler)
	}

	s3Guard := RequireSurfaceEnabled(h.server, surfaceS3)
	// One catch-all dispatcher for every S3 op. Path-style addressing
	// (/s3/<bucket>/<key>) means the bucket lives in the URL alongside
	// the key — gin's `*path` covers both. The dispatcher in api/s3.go
	// does the real routing based on method + query parameters.
	r.Any("/s3", s3Guard, h.S3Handler)
	r.Any("/s3/*path", s3Guard, h.S3Handler)

	// =========================================================================
	// /api/* — public group (no auth required)
	// =========================================================================
	public := r.Group("/api")
	{
		// --- /api/system/* — password login flow (must be public) ---
		public.POST("/system/auth/login", h.Login)
		public.POST("/system/auth/logout", h.Logout)

		// --- /api/agent/share/:token — public share link reads ---
		public.GET("/agent/share/:token", h.GetSharedSession)
		public.GET("/agent/share/:token/messages", h.GetSharedSessionMessages)

		// --- /api/public/apps — public read-only onboarding catalog ---
		// These routes expose static app import metadata and seed prompts only.
		// User data, collectors, uploads, sessions, and all /api/data/* routes
		// remain behind the authenticated group below.
		public.GET("/public/apps", h.GetApps)
		public.GET("/public/apps/:id", h.GetApp)

		// --- /api/mcp — JSON-RPC tool runtime ---
		// Single MCP endpoint hosting every MyLifeDB tool. Auth: the server's
		// internal MCP token is enforced when callers send an Authorization
		// header (auto-run agents do); requests with no header are accepted
		// (localhost trust — Claude Code CLI on the same host).
		public.POST("/mcp", h.server.MCP().HandleMCP)
		public.GET("/mcp", func(c *gin.Context) {
			c.Status(http.StatusMethodNotAllowed)
		})
	}

	// =========================================================================
	// /api/* — authenticated group
	// =========================================================================
	api := r.Group("/api")
	api.Use(auth)
	{
		// ---------------------------------------------------------------------
		// /api/data/* — file I/O, search, events, uploads, ingestion config
		// ---------------------------------------------------------------------
		data := api.Group("/data")
		{
			// File metadata + lifecycle (REST: path is the resource).
			data.GET("/files/*path", h.GetDataFile)
			data.DELETE("/files/*path", h.DeleteDataFile)
			data.PATCH("/files/*path", h.PatchDataFile)

			// Folder creation. Body has {parent, name}.
			data.POST("/folders", h.CreateDataFolder)

			// Tree view of a folder.
			data.GET("/tree", h.GetLibraryTree)

			// Pin lifecycle (idempotent PUT/DELETE on the pin resource).
			data.PUT("/pins/*path", h.PutDataPin)
			data.DELETE("/pins/*path", h.DeleteDataPin)

			// Misc.
			data.GET("/download", h.DownloadLibraryPath)
			data.POST("/extract", h.ExtractArchive)
			data.GET("/root", h.GetLibraryRoot)
			data.GET("/directories", h.GetDirectories)
			data.GET("/search", h.Search)

			// Filesystem event stream.
			data.GET("/events", h.NotificationStream)

			// Uploads (Simple PUT for small files + TUS for large files).
			data.PUT("/uploads/simple/*path", h.SimpleUpload)
			data.POST("/uploads/finalize", h.FinalizeUpload)
			data.Any("/uploads/tus/*path", h.TUSHandler)

			// App + collector catalogs (ingestion config).
			data.GET("/apps", h.GetApps)
			data.GET("/apps/:id", h.GetApp)
			data.GET("/collectors", h.GetCollectors)
			data.PUT("/collectors/:id", h.UpsertCollector)
		}

		// ---------------------------------------------------------------------
		// /api/explore/* — feed posts and comments
		// ---------------------------------------------------------------------
		explore := api.Group("/explore")
		{
			explore.GET("/posts", h.GetExplorePosts)
			explore.GET("/posts/:id", h.GetExplorePost)
			explore.GET("/posts/:id/comments", h.GetExploreComments)
			explore.DELETE("/posts/:id", h.DeleteExplorePost)
		}

		// ---------------------------------------------------------------------
		// /api/connect/credentials — integration credential CRUD
		//
		// These manage long-lived secrets for the non-OAuth ingestion
		// surfaces (webhook / WebDAV / S3). They live under the legacy
		// /api/connect/* namespace for now and will migrate to the cloud
		// gateway in a later pass.
		// ---------------------------------------------------------------------
		connect := api.Group("/connect")
		{
			connect.GET("/credentials", h.IntegrationListCredentials)
			connect.POST("/credentials", h.IntegrationCreateCredential)
			connect.DELETE("/credentials/:id", h.IntegrationRevokeCredential)
			connect.GET("/credentials/:id/audit", h.IntegrationCredentialAudit)
		}

		// ---------------------------------------------------------------------
		// /api/system/* — owner-only control plane (settings + stats)
		// ---------------------------------------------------------------------
		system := api.Group("/system")
		{
			system.GET("/settings", h.GetSettings)
			system.PUT("/settings", h.UpdateSettings)
			system.POST("/settings", h.ResetSettings)
			system.GET("/stats", h.GetStats)
		}
	}

	// =========================================================================
	// /api/agent/* — agent runtime, sessions, attachments, defs, MCP catalog
	// =========================================================================
	// Registered separately because WebSocket routes need to live on the
	// main router (gin route groups + `*` wildcards collide with the
	// session subscribe endpoint).
	agentRoutes := r.Group("/api/agent")
	agentRoutes.Use(auth)
	{
		agentRoutes.GET("/config", h.GetAgentConfig)
		agentRoutes.GET("/info", h.GetAgentInfo)

		agentRoutes.GET("/sessions", h.GetAgentSessions)
		agentRoutes.GET("/sessions/all", h.GetAgentSessions)
		agentRoutes.GET("/sessions/search", h.SearchAgentSessions)
		agentRoutes.POST("/sessions", h.CreateAgentSession)
		agentRoutes.GET("/sessions/:id", h.GetAgentSession)
		agentRoutes.PATCH("/sessions/:id", h.UpdateAgentSession)
		agentRoutes.GET("/sessions/:id/messages", h.GetAgentMessages)
		agentRoutes.GET("/sessions/:id/changed-files", h.GetAgentChangedFiles)
		agentRoutes.POST("/sessions/:id/deactivate", h.DeactivateAgentSession)
		agentRoutes.POST("/sessions/:id/restart", h.RestartAgentSession)
		agentRoutes.POST("/sessions/:id/archive", h.ArchiveAgentSession)
		agentRoutes.POST("/sessions/:id/unarchive", h.UnarchiveAgentSession)
		agentRoutes.POST("/sessions/:id/share", h.ShareAgentSession)
		agentRoutes.DELETE("/sessions/:id/share", h.UnshareAgentSession)

		// Session groups (sidebar organization).
		agentRoutes.GET("/groups", h.ListAgentSessionGroups)
		agentRoutes.POST("/groups", h.CreateAgentSessionGroup)
		agentRoutes.PUT("/groups/order", h.ReorderAgentSessionGroups)
		agentRoutes.PATCH("/groups/:id", h.UpdateAgentSessionGroup)
		agentRoutes.DELETE("/groups/:id", h.DeleteAgentSessionGroup)

		// Per-session attachments. Files stage under
		//   USER_DATA_DIR/sessions/<storageId>/uploads/<filename>.
		// The storageId is minted by the first upload (returned in the
		// response) and included on subsequent uploads + on POST sessions.
		agentRoutes.POST("/attachments", h.UploadAgentAttachment)
		agentRoutes.DELETE("/attachments/:storageId/:filename", h.DeleteAgentAttachment)

		// Auto agent definitions (markdown files with triggers that spawn sessions).
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
	// WebSocket routes — registered on main router because gin's group-level
	// middleware doesn't compose cleanly with route-level middleware here.
	r.GET("/api/agent/sessions/:id/subscribe", auth, h.AgentSessionWebSocket)
	r.GET("/api/agent/share/:token/subscribe", h.SharedSessionSubscribeWebSocket)
}
