package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/connect"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Connect bearer authentication.
//
// Two stages run on every Connect-resourced request:
//
//  1. ConnectAuthMiddleware — if the Authorization header carries a Connect
//     access token, look it up, attach the resolved Token to the request
//     context, and let the handler chain continue. Otherwise skip without
//     setting anything; the existing AuthMiddleware decides whether the
//     request is allowed via owner-session/OAuth instead.
//
//  2. RequireConnectScope("files.read") (and friends) — wraps a route to
//     require the resolved Connect token to satisfy that scope for the
//     requested path. If no Connect token is present, this middleware passes
//     through (so owner-session traffic still works); only Connect callers
//     are gated.
//
// Layering this way means Connect is purely additive: the existing front-end
// session flow is untouched.

// connectTokenContextKey is the gin-context key carrying the resolved Token.
const connectTokenContextKey = "connectToken"

// bufferedBodyKey is the gin-context key carrying the JSON body bytes.
const bufferedBodyKey = "bufferedBody"

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
		// Set the auth-source-agnostic principal so RequireConnectScope /
		// CheckConnectScope can gate the request without knowing it came
		// from Connect specifically.
		clientID := row.ClientID
		setRequestPrincipal(c, &RequestPrincipal{
			Scopes:      row.Scopes,
			PrincipalID: clientID,
			AuditFn: func(method, urlPath string, status int, scopeFamily string) {
				_ = h.server.Connect().AppendAudit(connect.AuditEntry{
					ClientID: clientID,
					Ts:       time.Now(),
					Method:   method,
					Path:     urlPath,
					Status:   status,
					Scope:    scopeFamily,
				})
			},
		})
		// Non-blocking touch + grant-touch.
		store.TouchToken(row.Hash)
		_ = store.TouchGrant(row.ClientID)
		c.Next()
	}
}

// RequireConnectScope returns a middleware that enforces a scope check
// against the URL catch-all parameter named "path" (the same /:*path that
// /raw/ uses). Use for routes shaped `/foo/*path`.
func (h *Handlers) RequireConnectScope(family string) gin.HandlerFunc {
	return h.requireConnectScopeFn(family, pathFromParam)
}

// RequireConnectScopeQuery returns a middleware that enforces a scope check
// against the `path` query parameter. Use for routes like /api/data/tree
// and /api/data/download where the file path is `?path=...`.
func (h *Handlers) RequireConnectScopeQuery(family string) gin.HandlerFunc {
	return h.requireConnectScopeFn(family, pathFromQuery)
}

// RequireConnectScopeRoot returns a middleware that enforces a scope check
// against the root path "/". Use for routes that don't carry a per-resource
// path argument (search, root, directories, events, apps, collectors).
// A token with `files.read:/somefolder` will NOT pass this check; the owner
// must grant scope at the root.
func (h *Handlers) RequireConnectScopeRoot(family string) gin.HandlerFunc {
	return h.requireConnectScopeFn(family, func(_ *gin.Context) string { return "/" })
}

// CheckConnectScope is the inline equivalent of RequireConnectScope*: it
// verifies the request's principal (if any) has `family` scope for `path`.
// Owner-session / unauthenticated requests pass through (returns true).
//
// On denial, it writes a 403 response and returns false; the handler should
// return immediately. The principal's audit hook is invoked either way.
//
// Use this from handlers whose effective path can only be known after
// parsing the request body (e.g. POST /folders body.parent, PATCH /files
// move-variant body.parent, POST /extract body.path, POST /uploads/finalize
// body.path).
//
// Despite the historical "Connect" name, this gate now applies to any
// scoped request — both Connect bearer tokens and integration credentials
// produce a principal that this check honors.
func (h *Handlers) CheckConnectScope(c *gin.Context, family, path string) bool {
	p, ok := RequestPrincipalFromContext(c)
	if !ok {
		return true
	}
	return h.enforceScope(c, p, family, path)
}

// requireConnectScopeFn is the shared core: extracts the principal from
// context, pulls the path via `pathFn`, and enforces.
func (h *Handlers) requireConnectScopeFn(family string, pathFn func(*gin.Context) string) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := RequestPrincipalFromContext(c)
		if !ok {
			// No scoped principal in play — defer to other auth.
			c.Next()
			return
		}
		if !h.enforceScope(c, p, family, pathFn(c)) {
			c.Abort()
			return
		}
		c.Next()
	}
}

// enforceScope is the audit-emitting scope check. Returns true if the
// principal's scopes cover (family, path); false (and writes 403) otherwise.
func (h *Handlers) enforceScope(c *gin.Context, p *RequestPrincipal, family, path string) bool {
	if path == "" {
		path = "/"
	} else if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	matched := p.Scopes.Allows(family, path)

	// Audit every gated request, regardless of outcome — if the principal
	// supplied a hook. Connect tokens supply one (writes connect_audit);
	// integration credentials may or may not.
	if p.AuditFn != nil {
		status := http.StatusOK
		if !matched {
			status = http.StatusForbidden
		}
		scopeLabel := ""
		if matched {
			scopeLabel = family
		}
		go p.AuditFn(c.Request.Method, c.Request.URL.Path, status, scopeLabel)
	}

	if !matched {
		RespondCoded(c, http.StatusForbidden, "FORBIDDEN",
			"credential does not have "+family+" scope for this path")
		return false
	}
	return true
}

// connectTokenFromContext pulls the resolved Connect token out of the gin
// context. The bool return is false for owner-session / no-Connect requests.
func connectTokenFromContext(c *gin.Context) (*connect.Token, bool) {
	v, ok := c.Get(connectTokenContextKey)
	if !ok {
		return nil, false
	}
	tok, ok := v.(*connect.Token)
	if !ok || tok == nil {
		return nil, false
	}
	return tok, true
}

// IsConnectAuthenticated reports whether the current request was
// authenticated via a Connect token. Used by AuthMiddleware to skip the
// owner-session check.
func IsConnectAuthenticated(c *gin.Context) bool {
	_, ok := connectTokenFromContext(c)
	return ok
}

// ConnectScopesFromContext returns the granted scopes of the current request's
// principal (Connect token or integration credential), or nil for
// owner-session traffic. Useful for handlers that want to filter their
// output by scope (e.g. SSE event filtering).
func ConnectScopesFromContext(c *gin.Context) connect.ScopeSet {
	p, ok := RequestPrincipalFromContext(c)
	if !ok {
		return nil
	}
	return p.Scopes
}

// pathFromParam reads the gin catch-all `path` route parameter. Used by
// /raw/*path and /api/data/files/*path.
func pathFromParam(c *gin.Context) string {
	return strings.TrimPrefix(c.Param("path"), "/")
}

// pathFromQuery reads the `?path=` query parameter. Used by routes like
// /api/data/tree and /api/data/download.
func pathFromQuery(c *gin.Context) string {
	return c.Query("path")
}

// BufferJSONBody is a middleware that reads the JSON body into a context
// cache so multiple later steps (scope checks, the handler) can read it
// without each consuming the io.Reader.
//
// On read failure it returns 400. After the read, c.Request.Body is
// re-armed with a fresh reader so handlers calling ShouldBindJSON Just Work.
func (h *Handlers) BufferJSONBody() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body == nil {
			c.Next()
			return
		}
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			RespondCoded(c, http.StatusBadRequest, "INVALID_BODY", "failed to read request body")
			c.Abort()
			return
		}
		_ = c.Request.Body.Close()
		c.Set(bufferedBodyKey, body)
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
		c.Next()
	}
}

// PathFromBody reads `key` (a top-level JSON string field) from the buffered
// request body. Returns "" if the body was not buffered, parse fails, or the
// key is absent. Callers should treat "" as "no path constraint from body".
func PathFromBody(c *gin.Context, key string) string {
	v, ok := c.Get(bufferedBodyKey)
	if !ok {
		return ""
	}
	body, ok := v.([]byte)
	if !ok || len(body) == 0 {
		return ""
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	rv, ok := raw[key]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(rv, &s); err != nil {
		return ""
	}
	return s
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
