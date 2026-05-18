package api

import (
	"crypto/subtle"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/auth"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// AuthMiddleware returns a Gin middleware that enforces authentication
// based on the configured auth mode (none, password).
//
// Backend supports two modes:
//
//	none      — all APIs are open
//	password  — accepts either an owner-session cookie (set by
//	            POST /api/system/auth/login) or HTTP Basic Auth. WebDAV
//	            clients (Finder, iOS Files, rclone, Obsidian Remotely Save)
//	            send Basic Auth and cannot manage a session cookie, so
//	            both shapes share the same gate.
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
			// Session cookie path (web UI).
			if h.ValidatePasswordSession(c) != nil {
				c.Next()
				return
			}
			// HTTP Basic Auth path (WebDAV clients + curl). The
			// username is ignored — only the password is verified
			// against the stored owner password hash, matching the
			// single-user model of POST /api/system/auth/login.
			if _, pass, ok := c.Request.BasicAuth(); ok && h.validatePasswordBasic(pass) {
				c.Next()
				return
			}
			// No valid credential. WebDAV clients require a Basic
			// challenge to prompt the user; emit it on every 401 so
			// the same response works for browsers, curl, and sync
			// clients. Browsers ignore it and rely on the JSON body.
			c.Header("WWW-Authenticate", `Basic realm="MyLifeDB"`)
			RespondCoded(c, http.StatusUnauthorized, "AUTH_INVALID_SESSION", "Unauthorized")
			c.Abort()
			return
		}
		c.Next()
	}
}

// validatePasswordBasic compares the presented password to the stored
// owner password hash. Constant-time comparison on the hash bytes so
// timing doesn't leak the hash prefix.
//
// Returns false if no password has ever been set — Basic Auth must not
// be a back door for first-time setup; the first login still has to
// happen through POST /api/system/auth/login.
func (h *Handlers) validatePasswordBasic(pass string) bool {
	storedHash, err := h.server.AppDB().GetSetting("auth_password_hash")
	if err != nil {
		log.Error().Err(err).Msg("auth: failed to read password hash for basic auth")
		return false
	}
	if storedHash == "" {
		return false
	}
	presented := hashPassword(pass)
	return subtle.ConstantTimeCompare([]byte(presented), []byte(storedHash)) == 1
}
