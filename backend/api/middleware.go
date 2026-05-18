package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/auth"
)

// AuthMiddleware returns a Gin middleware that enforces authentication
// based on the configured auth mode (none, password).
//
// Backend supports two modes:
//
//	none      — all APIs are open
//	password  — owner-session cookie required (set by POST /api/system/auth/login)
//
// Third-party access (OAuth, Connect, scope tokens) is the cloud gateway's
// responsibility, not the backend's.
func (h *Handlers) AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !auth.IsAuthRequired() {
			c.Next()
			return
		}
		if auth.IsPasswordAuthEnabled() {
			if h.ValidatePasswordSession(c) == nil {
				RespondCoded(c, http.StatusUnauthorized, "AUTH_INVALID_SESSION", "Unauthorized")
				c.Abort()
				return
			}
		}
		c.Next()
	}
}
