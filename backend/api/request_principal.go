package api

import (
	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/connect"
)

// RequestPrincipal is the auth-source-agnostic carrier for a scoped request.
//
// Both MyLifeDB Connect (OAuth bearer tokens) and the Integrations layer
// (webhook/WebDAV/S3 long-lived credentials) authenticate the same way as
// far as the scope-enforcement middleware is concerned: they produce a
// connect.ScopeSet that gates the request. The producer attaches a
// RequestPrincipal to the gin context; RequireConnectScope and friends
// read from here instead of from a Connect-specific Token.
//
// PrincipalID identifies the row that authenticated (Connect client_id, or
// integration credential id). It is used for audit / structured logs only,
// not for the auth decision.
//
// AuditFn, if non-nil, is invoked on every gated request after the decision
// is reached. It runs in a goroutine so handlers don't block on the write.
type RequestPrincipal struct {
	Scopes      connect.ScopeSet
	PrincipalID string
	AuditFn     func(method, urlPath string, status int, scopeFamily string)
}

const requestPrincipalKey = "requestPrincipal"

// setRequestPrincipal attaches a principal to the request context. Called by
// the per-source auth middleware (Connect bearer, webhook bearer, WebDAV
// basic-auth, S3 SigV4) once the credential is verified.
func setRequestPrincipal(c *gin.Context, p *RequestPrincipal) {
	c.Set(requestPrincipalKey, p)
}

// RequestPrincipalFromContext returns the resolved principal, or (nil, false)
// for owner-session / unauthenticated requests.
func RequestPrincipalFromContext(c *gin.Context) (*RequestPrincipal, bool) {
	v, ok := c.Get(requestPrincipalKey)
	if !ok {
		return nil, false
	}
	p, ok := v.(*RequestPrincipal)
	if !ok || p == nil {
		return nil, false
	}
	return p, true
}
