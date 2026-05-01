package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/connect"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Connect bearer authentication.
//
// Two stages run on every /raw/* (and other Connect-resourced) request:
//
//  1. ConnectAuthMiddleware — if the Authorization header carries a Connect
//     access token, look it up, attach the resolved Token to the request
//     context, and let the handler chain continue. Otherwise skip without
//     setting anything; the existing AuthMiddleware decides whether the
//     request is allowed via owner-session/OAuth instead.
//
//  2. RequireConnectScope("files.read") — wraps a route to require the
//     resolved Connect token to satisfy that scope for the requested path.
//     If no Connect token is present, this middleware passes through (so
//     owner-session traffic still works); only Connect callers are gated.
//
// Layering this way means Connect is purely additive: the existing front-end
// session flow is untouched.

// connectTokenContextKey is the gin-context key carrying the resolved Token.
const connectTokenContextKey = "connectToken"

// ConnectAuthMiddleware resolves a Connect bearer token, if any. It does
// NOT reject requests that lack a token — that's the resource handler /
// the legacy AuthMiddleware's job. We just enrich the context for handlers
// that want scope-aware behavior.
func (h *Handlers) ConnectAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := extractBearer(c)
		if raw == "" {
			c.Next()
			return
		}

		// OAuth JWTs (owner-session) are also sent as Authorization: Bearer.
		// Distinguish by shape: Connect tokens are base64url-encoded random
		// bytes (no dots); JWTs have the form header.payload.signature.
		// If the token contains a dot, it isn't a Connect token — fall
		// through and let AuthMiddleware validate it as an OAuth token.
		if strings.Contains(raw, ".") {
			c.Next()
			return
		}

		store := h.server.Connect()
		hash := connect.HashToken(raw)
		row, err := store.LookupActiveToken(hash)
		if err != nil {
			log.Error().Err(err).Msg("connect: token lookup failed")
			c.Next()
			return
		}
		if row == nil || row.Kind != connect.KindAccess {
			// Unknown / expired / revoked / wrong-kind: do NOT silently
			// promote to owner-auth. The bearer has no JWT shape so it's
			// clearly a connect token attempt — refuse here to avoid
			// surprising fall-through.
			RespondCoded(c, http.StatusUnauthorized, "AUTH_INVALID_TOKEN",
				"connect access token is invalid, expired, or revoked")
			c.Abort()
			return
		}
		c.Set(connectTokenContextKey, row)
		// Non-blocking touch + grant-touch.
		store.TouchToken(row.Hash)
		_ = store.TouchGrant(row.ClientID)
		c.Next()
	}
}

// RequireConnectScope returns a middleware that enforces a scope check
// for callers authenticated via a Connect token. If the request has no
// Connect token (i.e., owner-session/OAuth user), it passes through.
//
// `family` is the scope family (e.g., "files.read"); the path argument
// for path-keyed scopes is taken from the gin route param "path" (the same
// /:*path that /raw/ uses).
func (h *Handlers) RequireConnectScope(family string) gin.HandlerFunc {
	return func(c *gin.Context) {
		v, ok := c.Get(connectTokenContextKey)
		if !ok {
			// No connect token in play — defer to other auth.
			c.Next()
			return
		}
		tok, ok := v.(*connect.Token)
		if !ok || tok == nil {
			RespondCoded(c, http.StatusUnauthorized, "AUTH_INVALID_TOKEN", "invalid connect token state")
			c.Abort()
			return
		}

		path := strings.TrimPrefix(c.Param("path"), "/")
		if path == "" {
			path = "/"
		} else {
			path = "/" + path
		}

		matched := tok.Scopes.Allows(family, path)
		// Audit every gated request, regardless of outcome.
		go func(clientID, method, urlPath, scopeFamily string, allowed bool) {
			status := http.StatusOK
			if !allowed {
				status = http.StatusForbidden
			}
			scopeLabel := ""
			if allowed {
				scopeLabel = scopeFamily
			}
			_ = h.server.Connect().AppendAudit(connect.AuditEntry{
				ClientID: clientID,
				Ts:       time.Now(),
				Method:   method,
				Path:     urlPath,
				Status:   status,
				Scope:    scopeLabel,
			})
		}(tok.ClientID, c.Request.Method, c.Request.URL.Path, family, matched)

		if !matched {
			RespondCoded(c, http.StatusForbidden, "FORBIDDEN",
				"connect token does not have "+family+" scope for this path")
			c.Abort()
			return
		}
		c.Next()
	}
}

// IsConnectAuthenticated reports whether the current request was
// authenticated via a Connect token. Used by AuthMiddleware to skip the
// owner-session check.
func IsConnectAuthenticated(c *gin.Context) bool {
	_, ok := c.Get(connectTokenContextKey)
	return ok
}

// extractBearer pulls a bearer token out of the Authorization header or,
// for compatibility with WebSocket / browser <img> use cases, from the
// `?access_token=` query parameter.
func extractBearer(c *gin.Context) string {
	if h := c.GetHeader("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	if t := c.Query("connect_access_token"); t != "" {
		return t
	}
	return ""
}
