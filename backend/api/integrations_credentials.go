package api

import (
	"github.com/gin-gonic/gin"

	"github.com/xiaoyuanzhu-com/my-life-db/integrations"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Owner-facing CRUD for non-OAuth integration credentials.
//
// Endpoints (mounted under /api/connect/credentials in routes.go — same
// "Connect" namespace because they live in the same conceptual category as
// /api/connect/clients, just with a different auth model):
//
//   GET    /api/connect/credentials              -- list non-revoked credentials
//   POST   /api/connect/credentials              -- mint a new credential (returns raw secret ONCE)
//   DELETE /api/connect/credentials/:id          -- soft-revoke a credential
//
// All three require owner-session auth (mounted inside the authenticated
// group in routes.go). Connect bearer tokens cannot manage credentials —
// the secrets they would mint would carry whatever scope the bearer holds,
// which is a privilege-escalation footgun.

// IntegrationListCredentials returns every non-revoked credential.
//
// GET /api/connect/credentials
func (h *Handlers) IntegrationListCredentials(c *gin.Context) {
	rows, err := h.server.Integrations().List()
	if err != nil {
		log.Error().Err(err).Msg("integrations: list credentials failed")
		RespondInternalError(c, "failed to list credentials")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, credentialToJSON(r, ""))
	}
	RespondList(c, out, nil)
}

// integrationCreateCredentialReq is the body of POST /api/connect/credentials.
type integrationCreateCredentialReq struct {
	Name     string `json:"name"`
	Protocol string `json:"protocol"` // "webhook" | "webdav" | "s3"
	Scope    string `json:"scope"`    // single Connect scope, e.g. "files.write:/health/apple/raw"
}

// IntegrationCreateCredential mints a new credential. The raw secret is
// included in the response exactly once — clients must capture it on screen
// and never request it again.
//
// POST /api/connect/credentials
func (h *Handlers) IntegrationCreateCredential(c *gin.Context) {
	var req integrationCreateCredentialReq
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondBadRequest(c, "invalid request body")
		return
	}
	proto, ok := parseProtocol(req.Protocol)
	if !ok {
		RespondBadRequest(c, "protocol must be 'webhook', 'webdav', or 's3'")
		return
	}
	issued, err := h.server.Integrations().Create(req.Name, proto, req.Scope)
	if err != nil {
		// Validation errors from Create (bad scope, missing name) are user-facing.
		// Distinguishing them from internal failures isn't worth a structured
		// error type yet; surface as 400 across the board.
		log.Error().Err(err).Msg("integrations: create credential failed")
		RespondBadRequest(c, err.Error())
		return
	}
	// 201 Created. Include the raw secret (and, where applicable, the
	// public id) — this is the ONE response that ever carries the secret.
	RespondCreated(c, credentialToJSON(issued.Credential, issued.Secret), "/api/connect/credentials/"+issued.ID)
}

// IntegrationCredentialAudit returns the most recent audit rows for one
// credential, newest first. Mirrors the shape of ConnectClientAudit so
// the frontend audit drawer can render either source with one component.
//
// GET /api/connect/credentials/:id/audit?limit=N&offset=N
//
// Defaults: limit=100, offset=0. Maximum limit=1000 (clamped server-side).
func (h *Handlers) IntegrationCredentialAudit(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		RespondBadRequest(c, "credential id is required")
		return
	}
	limit := 100
	if v := c.Query("limit"); v != "" {
		var n int
		_, _ = fmtSscan(v, &n)
		if n > 0 {
			limit = n
		}
	}
	offset := 0
	if v := c.Query("offset"); v != "" {
		var n int
		_, _ = fmtSscan(v, &n)
		if n > 0 {
			offset = n
		}
	}
	rows, err := h.server.Integrations().ListAudit(id, limit, offset)
	if err != nil {
		log.Error().Err(err).Msg("integrations: list audit failed")
		RespondInternalError(c, "failed to list audit")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"id":           r.ID,
			"credentialId": r.CredentialID,
			"ts":           r.Timestamp.Unix(),
			"ip":           r.IP,
			"method":       r.Method,
			"path":         r.Path,
			"status":       r.Status,
			"scopeFamily":  r.ScopeFamily,
		})
	}
	RespondList(c, out, nil)
}

// IntegrationRevokeCredential soft-deletes a credential. Idempotent.
//
// DELETE /api/connect/credentials/:id
func (h *Handlers) IntegrationRevokeCredential(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		RespondBadRequest(c, "credential id is required")
		return
	}
	if err := h.server.Integrations().Revoke(id); err != nil {
		log.Error().Err(err).Msg("integrations: revoke credential failed")
		RespondInternalError(c, "failed to revoke credential")
		return
	}
	RespondNoContent(c)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func parseProtocol(s string) (integrations.Protocol, bool) {
	switch s {
	case "webhook":
		return integrations.ProtoWebhook, true
	case "webdav":
		return integrations.ProtoWebDAV, true
	case "s3":
		return integrations.ProtoS3, true
	}
	return "", false
}

// credentialToJSON renders a Credential for the API. `rawSecret` is empty for
// list responses and populated only for the one create response that carries
// the secret.
func credentialToJSON(c integrations.Credential, rawSecret string) gin.H {
	out := gin.H{
		"id":           c.ID,
		"name":         c.Name,
		"protocol":     string(c.Protocol),
		"publicId":     c.PublicID,
		"secretPrefix": c.SecretPrefix,
		"scope":        c.Scope,
		"createdAt":    c.CreatedAt.Unix(),
	}
	if c.LastUsedAt != nil {
		out["lastUsedAt"] = c.LastUsedAt.Unix()
	} else {
		out["lastUsedAt"] = nil
	}
	if c.LastUsedIP != "" {
		out["lastUsedIp"] = c.LastUsedIP
	}
	if c.RevokedAt != nil {
		out["revokedAt"] = c.RevokedAt.Unix()
	}
	if rawSecret != "" {
		out["secret"] = rawSecret
	}
	return out
}
