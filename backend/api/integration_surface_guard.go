// Live-toggle guard for the non-OAuth integration surface routes
// (webhook / WebDAV / S3).
//
// Phases 1-3 conditionally mounted each surface at startup based on
// `settings.Integrations.Surfaces.<name>` — flipping the toggle in the
// UI required a server restart for the route to appear or disappear.
//
// Phase 4 keeps the routes mounted permanently and gates them per-request
// with this middleware. The settings read happens inside each request, so
// flipping the toggle takes effect on the very next request — no restart
// needed.
//
// On disabled: respond with bare 404 + abort. Same shape the gin router
// emits when a route isn't registered, so a probe cannot tell whether
// the surface is "off" or simply "not implemented" without authenticating
// first. This matches the previous conditional-mount behavior exactly.
package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

// Surface identifiers — strings rather than typed enums because they
// only exist at the seam between routes.go and this middleware.
const (
	surfaceWebhook = "webhook"
	surfaceWebDAV  = "webdav"
	surfaceS3      = "s3"
)

// RequireSurfaceEnabled returns a gin middleware that 404s the request
// when the named surface's settings toggle is off.
//
// `settings.Integrations.Surfaces` is read fresh from the app DB on
// every request via `server.AppDB().LoadUserSettings()`. That call
// does N+1-free settings load (one query for the whole table) so the
// per-request cost is one SQLite SELECT — a hot SQLite read on a
// connection pool, well under a millisecond on the personal-server
// hardware this app targets.
//
// On a settings-load error we log and 404 (fail closed). A user who
// just disabled the surface in the UI should never get a successful
// request through, even if the DB blips.
func RequireSurfaceEnabled(s *server.Server, surface string) gin.HandlerFunc {
	return func(c *gin.Context) {
		settings, err := s.AppDB().LoadUserSettings()
		if err != nil {
			log.Error().Err(err).Str("surface", surface).
				Msg("surface guard: failed to load settings; treating as disabled")
			c.Status(http.StatusNotFound)
			c.Abort()
			return
		}
		var enabled bool
		switch surface {
		case surfaceWebhook:
			enabled = settings.Integrations.Surfaces.Webhook
		case surfaceWebDAV:
			enabled = settings.Integrations.Surfaces.WebDAV
		case surfaceS3:
			enabled = settings.Integrations.Surfaces.S3
		default:
			// Unknown surface name — fail closed.
			log.Error().Str("surface", surface).Msg("surface guard: unknown surface name")
			c.Status(http.StatusNotFound)
			c.Abort()
			return
		}
		if !enabled {
			c.Status(http.StatusNotFound)
			c.Abort()
			return
		}
		c.Next()
	}
}
