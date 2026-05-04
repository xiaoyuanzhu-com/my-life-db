package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
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
	connectAuth := h.ConnectAuthMiddleware()
	bufferBody := h.BufferJSONBody()

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
	r.GET("/raw/*path", connectAuth, auth, h.RequireConnectScope("files.read"), h.ServeRawFile)
	r.PUT("/raw/*path", connectAuth, auth, h.RequireConnectScope("files.write"), h.SaveRawFile)
	r.GET("/sqlar/*path", auth, h.ServeSqlarFile)

	// Integration surfaces — non-OAuth ingestion endpoints. Each is gated
	// by its own settings toggle so users who don't need a surface don't
	// expose it (off → no route registered → 404 by default).
	//
	// In v1 the toggle is read once at startup; flipping it requires a
	// restart. Phase 4 will swap the router on toggle change for live
	// reconfiguration.
	settings, err := h.server.AppDB().LoadUserSettings()
	if err != nil {
		log.Error().Err(err).Msg("routes: failed to load user settings; integration surfaces stay off")
	} else if settings.Integrations.Surfaces.Webhook {
		log.Info().Msg("integrations: webhook surface enabled, mounting /webhook/*")
		r.POST("/webhook/:credentialId/*subpath", h.WebhookIngest)
		r.PUT("/webhook/:credentialId/*subpath", h.WebhookIngest)
	}

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
		//
		// Phase E: Connect-scope-gated. `connectAuth` resolves a Connect
		// token (if present) into request context; per-route middleware
		// then enforces files.read / files.write against the request's
		// effective path.
		//
		// Three path-extraction strategies:
		//   - RequireConnectScope        — gin catch-all `*path`
		//   - RequireConnectScopeQuery   — `?path=` query parameter
		//   - RequireConnectScopeRoot    — implicit "/" (whole-FS scope)
		//
		// Body-derived paths (POST /folders, PATCH /files move-variant,
		// POST /extract, POST /uploads/finalize) use BufferJSONBody +
		// inline h.CheckConnectScope(...) calls inside the handler.
		// ---------------------------------------------------------------------
		data := api.Group("/data")
		data.Use(connectAuth)
		{
			// File metadata + lifecycle (REST: path is the resource).
			data.GET("/files/*path",
				h.RequireConnectScope("files.read"), h.GetDataFile)
			data.DELETE("/files/*path",
				h.RequireConnectScope("files.write"), h.DeleteDataFile)
			// PATCH: middleware checks write scope on the SOURCE path; the
			// handler additionally calls CheckConnectScope on the DEST path
			// for the move-variant.
			data.PATCH("/files/*path",
				bufferBody, h.RequireConnectScope("files.write"), h.PatchDataFile)

			// Folder creation. Body has {parent, name}; effective path is
			// parent/name. Handler calls CheckConnectScope inline.
			data.POST("/folders",
				bufferBody, h.CreateDataFolder)

			// Tree view of a folder. Note: `tree` is a derived view, so it
			// gets its own subroot rather than `/folders/*path/tree` (which
			// gin's catch-all syntax cannot express — `*path` must be the
			// final segment).
			data.GET("/tree",
				h.RequireConnectScopeQuery("files.read"), h.GetLibraryTree)

			// Pin lifecycle (idempotent PUT/DELETE on the pin resource).
			// Pins are "owner-side state about a file" — gated as files.write.
			data.PUT("/pins/*path",
				h.RequireConnectScope("files.write"), h.PutDataPin)
			data.DELETE("/pins/*path",
				h.RequireConnectScope("files.write"), h.DeleteDataPin)

			// Misc.
			data.GET("/download",
				h.RequireConnectScopeQuery("files.read"), h.DownloadLibraryPath)
			data.POST("/extract",
				bufferBody, h.ExtractArchive)
			data.GET("/root",
				h.RequireConnectScopeRoot("files.read"), h.GetLibraryRoot)
			data.GET("/directories",
				h.RequireConnectScopeRoot("files.read"), h.GetDirectories)
			data.GET("/search",
				h.RequireConnectScopeRoot("files.read"), h.Search)

			// Filesystem event stream (renamed from /api/notifications/stream:
			// these are filesystem events, not user-facing notifications).
			// The stream itself requires files.read at root; events are
			// filtered per-event by the handler against the token's scopes.
			data.GET("/events",
				h.RequireConnectScopeRoot("files.read"), h.NotificationStream)

			// Uploads (Simple PUT for small files + TUS for large files).
			data.PUT("/uploads/simple/*path",
				h.RequireConnectScope("files.write"), h.SimpleUpload)
			data.POST("/uploads/finalize",
				bufferBody, h.FinalizeUpload)
			data.Any("/uploads/tus/*path",
				h.RequireConnectScope("files.write"), h.TUSHandler)

			// App + collector catalogs (ingestion config). These are
			// owner-side metadata — gate at root scope.
			data.GET("/apps",
				h.RequireConnectScopeRoot("files.read"), h.GetApps)
			data.GET("/apps/:id",
				h.RequireConnectScopeRoot("files.read"), h.GetApp)
			data.GET("/collectors",
				h.RequireConnectScopeRoot("files.read"), h.GetCollectors)
			data.PUT("/collectors/:id",
				h.RequireConnectScopeRoot("files.write"), h.UpsertCollector)
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
		// /api/connect/* — owner-side OAuth admin + non-OAuth credentials
		// ---------------------------------------------------------------------
		connect := api.Group("/connect")
		{
			connect.POST("/consent", h.ConnectConsent)
			connect.GET("/clients", h.ConnectListClients)
			connect.DELETE("/clients/:id", h.ConnectRevokeClient)
			connect.GET("/clients/:id/audit", h.ConnectClientAudit)

			// Long-lived credentials for non-OAuth ingestion surfaces
			// (HTTP webhook / WebDAV / S3-compatible). Lives in the
			// /api/connect/* namespace because it is the same
			// conceptual category — third-party access management —
			// just with a different auth model.
			connect.GET("/credentials", h.IntegrationListCredentials)
			connect.POST("/credentials", h.IntegrationCreateCredential)
			connect.DELETE("/credentials/:id", h.IntegrationRevokeCredential)
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
