package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// SetupRoutes configures all API routes with handlers.
//
// The route table follows the namespace structure locked in
// internal/api/api-structure.md (Phase B): three tiers, six top-level
// `/api/*` namespaces, plus four protocol/byte-I/O surfaces outside `/api/`.
//
//   tier      | namespaces
//   --------- | --------------------------------
//   product   | /api/data/, /api/agent/, /api/explore/
//   protocol  | /api/connect/, /api/mcp/
//   admin     | /api/system/
//
// Phase D removed all legacy `/api/library/*`, `/api/auth/*`, `/api/oauth/*`,
// `/api/settings`, `/api/stats`, `/api/notifications/stream`, `/api/upload/*`,
// `/api/search`, `/api/directories`, `/api/apps*`, `/api/collectors*`, and
// `/api/share/*` aliases now that all first-party clients (web + iOS) speak
// the new namespace.
func SetupRoutes(r *gin.Engine, h *Handlers) {
	auth := h.AuthMiddleware()

	// =========================================================================
	// Outside `/api/` — OAuth public endpoints + RFC 8414 discovery
	// =========================================================================
	// MyLifeDB Connect — OAuth 2.1 endpoints exposed at the top level so
	// third-party apps can hardcode them. Public; PKCE replaces the client
	// secret on /connect/token.
	r.POST("/connect/token", h.ConnectToken)
	r.POST("/connect/revoke", h.ConnectRevoke)
	r.GET("/.well-known/oauth-authorization-server", h.ConnectMetadata)

	// =========================================================================
	// Outside `/api/` — byte I/O surfaces
	// =========================================================================
	// Raw file serving — protected. Three middlewares run in order:
	//
	//   1. ConnectAuthMiddleware  — if a valid Connect bearer token is
	//      attached, attach it to the request context; if it's invalid,
	//      reject here. No-op for owner-session traffic.
	//   2. AuthMiddleware         — owner-session check; passes through
	//      automatically when (1) already authenticated the request.
	//   3. RequireConnectScope    — for Connect-authenticated callers,
	//      check that the resolved scope satisfies the path; pass-through
	//      for owner-session callers.
	connectAuth := h.ConnectAuthMiddleware()
	r.GET("/raw/*path", connectAuth, auth, h.RequireConnectScope("files.read"), h.ServeRawFile)
	r.PUT("/raw/*path", connectAuth, auth, h.RequireConnectScope("files.write"), h.SaveRawFile)
	r.GET("/sqlar/*path", auth, h.ServeSqlarFile)

	// =========================================================================
	// /api/* — public group (no auth required)
	// =========================================================================
	public := r.Group("/api")
	{
		// --- /api/system/* — auth + OAuth login flow (must be public) ---
		public.POST("/system/auth/login", h.Login)
		public.POST("/system/auth/logout", h.Logout)
		public.GET("/system/oauth/authorize", h.OAuthAuthorize)
		public.GET("/system/oauth/callback", h.OAuthCallback)
		public.POST("/system/oauth/refresh", h.OAuthRefresh)
		public.GET("/system/oauth/token", h.OAuthToken)
		public.POST("/system/oauth/logout", h.OAuthLogout)

		// --- /api/agent/share/:token — public share link reads ---
		public.GET("/agent/share/:token", h.GetSharedSession)
		public.GET("/agent/share/:token/messages", h.GetSharedSessionMessages)

		// --- /api/connect/* — Connect consent UI preview (public) ---
		// The consent screen renders "App X wants permissions Y" before the
		// user is asked to approve. Read-only; mints no tokens or grants.
		public.GET("/connect/authorize/preview", h.ConnectAuthorizePreview)

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

			// Folder creation.
			data.POST("/folders", h.CreateDataFolder)

			// Tree view of a folder. Note: `tree` is a derived view, so it
			// gets its own subroot rather than `/folders/*path/tree` (which
			// gin's catch-all syntax cannot express — `*path` must be the
			// final segment).
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

			// Filesystem event stream (renamed from /api/notifications/stream:
			// these are filesystem events, not user-facing notifications).
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
			// REST writes (POST /posts, /posts/:id/comments, /posts/:id/tags)
			// are reserved by the ADR; backend implementation lands in a
			// follow-up. Until then, writes flow through MCP tools.
		}

		// ---------------------------------------------------------------------
		// /api/connect/* — owner-side OAuth admin
		// ---------------------------------------------------------------------
		connect := api.Group("/connect")
		{
			connect.POST("/consent", h.ConnectConsent)
			connect.GET("/clients", h.ConnectListClients)
			connect.DELETE("/clients/:id", h.ConnectRevokeClient)
			connect.GET("/clients/:id/audit", h.ConnectClientAudit)
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
