package api

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/connect"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// MyLifeDB Connect — OAuth 2.1 (PKCE) authorization for third-party apps.
// See backend/connect/types.go for the trust model and storage layer.
//
// Endpoint map:
//   GET  /api/connect/authorize/preview        public  — parses + validates an authorize request, upserts the client.
//   POST /api/connect/consent                  owner   — approves a request; returns a redirect_to.
//   POST /connect/token                        public  — code → token + refresh rotation.
//   POST /connect/revoke                       public  — RFC 7009 token revocation.
//   GET  /.well-known/oauth-authorization-server public — discovery doc.
//   GET  /api/connect/clients                  owner   — list of connected apps.
//   DELETE /api/connect/clients/:id            owner   — revoke an app (cascades grants/tokens; keeps audit until next sweep).
//   GET  /api/connect/clients/:id/audit        owner   — recent activity for an app.
//
// The actual consent UI is the SPA route /connect/authorize, served by the
// frontend's SPA fallback. The SPA's job: read the URL params, call the
// /preview endpoint to render the consent screen, then POST /consent.

// authorizeRequest captures every parameter we accept on /connect/authorize.
// The SPA echoes them back to /api/connect/consent so we can re-validate
// without server-side state — keeps the consent flow stateless.
type authorizeRequest struct {
	ResponseType        string `form:"response_type" json:"response_type"`
	ClientID            string `form:"client_id" json:"client_id"`
	RedirectURI         string `form:"redirect_uri" json:"redirect_uri"`
	Scope               string `form:"scope" json:"scope"`
	State               string `form:"state" json:"state"`
	CodeChallenge       string `form:"code_challenge" json:"code_challenge"`
	CodeChallengeMethod string `form:"code_challenge_method" json:"code_challenge_method"`
	AppName             string `form:"app_name" json:"app_name"`         // self-declared display name
	AppIcon             string `form:"app_icon" json:"app_icon"`         // self-declared icon URL (optional)
}

// validate runs syntactic checks. Semantic checks (subset-of-existing-grant)
// happen later.
func (r *authorizeRequest) validate() (connect.ScopeSet, error) {
	if r.ResponseType != "code" {
		return nil, errString("response_type must be \"code\"")
	}
	if r.ClientID == "" {
		return nil, errString("client_id is required")
	}
	if r.AppName == "" {
		return nil, errString("app_name is required (self-declared display name)")
	}
	if r.RedirectURI == "" {
		return nil, errString("redirect_uri is required")
	}
	if _, err := url.Parse(r.RedirectURI); err != nil {
		return nil, errString("redirect_uri is not a valid URL")
	}
	if r.CodeChallengeMethod != "S256" {
		return nil, errString("code_challenge_method must be S256")
	}
	if r.CodeChallenge == "" {
		return nil, errString("code_challenge is required")
	}
	scopes, err := connect.ParseScopes(r.Scope)
	if err != nil {
		return nil, err
	}
	if len(scopes) == 0 {
		return nil, errString("scope is required (at least one capability)")
	}
	return scopes, nil
}

// AuthorizePreview parses + validates an /authorize request and returns
// the metadata the consent UI needs to render. It also upserts the client
// row so the row exists by the time the user clicks "approve".
//
// GET /api/connect/authorize/preview?response_type=code&client_id=...&...
func (h *Handlers) ConnectAuthorizePreview(c *gin.Context) {
	var req authorizeRequest
	if err := c.ShouldBindQuery(&req); err != nil {
		RespondBadRequest(c, "invalid query: "+err.Error())
		return
	}
	scopes, err := req.validate()
	if err != nil {
		RespondBadRequest(c, err.Error())
		return
	}

	store := h.server.Connect()
	if err := store.UpsertClient(req.ClientID, req.AppName, req.AppIcon, req.RedirectURI); err != nil {
		log.Error().Err(err).Str("client_id", req.ClientID).Msg("connect: upsert client failed")
		RespondInternalError(c, "failed to record client")
		return
	}
	client, err := store.GetClient(req.ClientID)
	if err != nil || client == nil {
		RespondInternalError(c, "client lookup failed")
		return
	}

	// Compute "new scopes" — the subset of `scopes` not already covered by
	// an existing grant. The consent screen highlights these. If the entire
	// request is a subset of an existing grant, we return canSilentApprove=true
	// and the SPA can skip the consent screen and POST /consent directly.
	existing, err := store.GetGrant(req.ClientID)
	if err != nil {
		log.Error().Err(err).Msg("connect: grant lookup failed")
		RespondInternalError(c, "grant lookup failed")
		return
	}
	var (
		newScopes      []string
		grantedScopes  []string
		canSilent      bool
	)
	if existing == nil {
		for _, s := range scopes {
			newScopes = append(newScopes, s.String())
		}
	} else {
		canSilent = connect.IsSubset(scopes, existing.Scopes)
		for _, s := range scopes {
			if !existing.Scopes.Allows(s.Family, s.Path) {
				newScopes = append(newScopes, s.String())
			}
		}
		for _, s := range existing.Scopes {
			grantedScopes = append(grantedScopes, s.String())
		}
	}

	requested := make([]string, 0, len(scopes))
	for _, s := range scopes {
		requested = append(requested, s.String())
	}

	RespondData(c, gin.H{
		"client": gin.H{
			"id":       client.ID,
			"name":     client.Name,
			"iconUrl":  client.IconURL,
			"verified": client.Verified,
		},
		"requestedScopes":   requested,
		"grantedScopes":     grantedScopes,
		"newScopes":         newScopes,
		"canSilentApprove":  canSilent,
		"redirectUri":       req.RedirectURI,
	})
}

// consentBody is what the consent UI POSTs: the full original request plus
// the user's decision. We re-validate the request rather than trusting any
// server-side ephemeral state.
type consentBody struct {
	authorizeRequest
	Approve bool `json:"approve"`
}

// ConnectConsent records the owner's decision and, on approval, mints a
// one-time authz code. Returns a `redirect_to` URL the SPA should
// `window.location.assign` to (the third-party app's redirect_uri with
// ?code=&state= or ?error=&state=).
//
// POST /api/connect/consent
func (h *Handlers) ConnectConsent(c *gin.Context) {
	var body consentBody
	if err := c.ShouldBindJSON(&body); err != nil {
		RespondBadRequest(c, "invalid body: "+err.Error())
		return
	}
	scopes, err := body.validate()
	if err != nil {
		RespondBadRequest(c, err.Error())
		return
	}

	store := h.server.Connect()

	// Owner denied → redirect with error=access_denied.
	if !body.Approve {
		u := buildRedirect(body.RedirectURI, map[string]string{
			"error": "access_denied",
			"state": body.State,
		})
		RespondData(c, gin.H{"redirectTo": u})
		return
	}

	// Persist the grant (unioned with any existing).
	if err := store.UpsertGrant(body.ClientID, scopes); err != nil {
		log.Error().Err(err).Msg("connect: upsert grant failed")
		RespondInternalError(c, "failed to save grant")
		return
	}

	// Mint a one-time authz code.
	rawCode, err := connect.RandomToken(32)
	if err != nil {
		RespondInternalError(c, "failed to generate code")
		return
	}
	now := time.Now()
	codeRow := connect.AuthzCode{
		CodeHash:            connect.HashToken(rawCode),
		ClientID:            body.ClientID,
		RedirectURI:         body.RedirectURI,
		Scopes:              scopes,
		CodeChallenge:       body.CodeChallenge,
		CodeChallengeMethod: body.CodeChallengeMethod,
		ExpiresAt:           now.Add(connect.AuthzCodeTTL),
		CreatedAt:           now,
	}
	if err := store.CreateCode(codeRow); err != nil {
		log.Error().Err(err).Msg("connect: create code failed")
		RespondInternalError(c, "failed to create authorization code")
		return
	}

	u := buildRedirect(body.RedirectURI, map[string]string{
		"code":  rawCode,
		"state": body.State,
	})
	RespondData(c, gin.H{"redirectTo": u})
}

// ConnectToken handles POST /connect/token — the form-encoded OAuth 2.1
// token endpoint. Two grants are supported:
//   - grant_type=authorization_code (with code_verifier; PKCE replaces client secret)
//   - grant_type=refresh_token       (rotation: old refresh is revoked, new pair returned)
//
// On success: { access_token, refresh_token, token_type, expires_in, scope }.
// On error  : { error, error_description } per RFC 6749.
func (h *Handlers) ConnectToken(c *gin.Context) {
	if err := c.Request.ParseForm(); err != nil {
		oauthFormError(c, http.StatusBadRequest, "invalid_request", "could not parse form body")
		return
	}
	grantType := c.PostForm("grant_type")
	switch grantType {
	case "authorization_code":
		h.connectTokenFromCode(c)
	case "refresh_token":
		h.connectTokenFromRefresh(c)
	default:
		oauthFormError(c, http.StatusBadRequest, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token")
	}
}

func (h *Handlers) connectTokenFromCode(c *gin.Context) {
	code := c.PostForm("code")
	clientID := c.PostForm("client_id")
	redirectURI := c.PostForm("redirect_uri")
	codeVerifier := c.PostForm("code_verifier")
	if code == "" || clientID == "" || redirectURI == "" || codeVerifier == "" {
		oauthFormError(c, http.StatusBadRequest, "invalid_request",
			"code, client_id, redirect_uri, code_verifier are required")
		return
	}

	store := h.server.Connect()
	row, err := store.ConsumeCode(connect.HashToken(code))
	if err != nil {
		log.Error().Err(err).Msg("connect: consume code failed")
		oauthFormError(c, http.StatusInternalServerError, "server_error", "internal error")
		return
	}
	if row == nil {
		oauthFormError(c, http.StatusBadRequest, "invalid_grant", "code is invalid, expired, or already used")
		return
	}
	if row.ClientID != clientID {
		oauthFormError(c, http.StatusBadRequest, "invalid_grant", "code was not issued to this client")
		return
	}
	if row.RedirectURI != redirectURI {
		oauthFormError(c, http.StatusBadRequest, "invalid_grant", "redirect_uri mismatch")
		return
	}
	if err := connect.VerifyPKCE(codeVerifier, row.CodeChallenge, row.CodeChallengeMethod); err != nil {
		oauthFormError(c, http.StatusBadRequest, "invalid_grant", "PKCE verification failed: "+err.Error())
		return
	}

	issued, err := h.issueTokenPair(row.ClientID, row.Scopes, "")
	if err != nil {
		log.Error().Err(err).Msg("connect: issue token pair failed")
		oauthFormError(c, http.StatusInternalServerError, "server_error", "failed to issue tokens")
		return
	}
	c.JSON(http.StatusOK, tokenResponseJSON(issued))
}

func (h *Handlers) connectTokenFromRefresh(c *gin.Context) {
	refresh := c.PostForm("refresh_token")
	clientID := c.PostForm("client_id")
	if refresh == "" || clientID == "" {
		oauthFormError(c, http.StatusBadRequest, "invalid_request",
			"refresh_token and client_id are required")
		return
	}

	store := h.server.Connect()
	hash := connect.HashToken(refresh)
	row, err := store.LookupActiveToken(hash)
	if err != nil {
		oauthFormError(c, http.StatusInternalServerError, "server_error", "internal error")
		return
	}
	if row == nil {
		// Could be: never existed, expired, or revoked. If a previously valid
		// refresh shows up after revocation, that's a replay — kill the chain
		// (best-effort; the LookupActiveToken miss already prevented issuance).
		_ = store.RevokeChain(hash)
		oauthFormError(c, http.StatusBadRequest, "invalid_grant", "refresh_token is invalid, expired, or revoked")
		return
	}
	if row.Kind != connect.KindRefresh {
		oauthFormError(c, http.StatusBadRequest, "invalid_grant", "token is not a refresh token")
		return
	}
	if row.ClientID != clientID {
		oauthFormError(c, http.StatusBadRequest, "invalid_grant", "refresh_token was not issued to this client")
		return
	}

	// Revoke the old refresh as part of rotation, then issue a new pair
	// linked via parent_hash. The new refresh's parent is the old hash;
	// any future reuse of the old hash will trigger RevokeChain above.
	if err := store.RevokeToken(hash); err != nil {
		log.Error().Err(err).Msg("connect: revoke old refresh failed")
	}
	issued, err := h.issueTokenPair(row.ClientID, row.Scopes, hash)
	if err != nil {
		log.Error().Err(err).Msg("connect: refresh issue failed")
		oauthFormError(c, http.StatusInternalServerError, "server_error", "failed to issue tokens")
		return
	}
	store.TouchGrant(row.ClientID)
	c.JSON(http.StatusOK, tokenResponseJSON(issued))
}

// issueTokenPair persists an access token + refresh token and returns the
// raw values to hand back to the client.
func (h *Handlers) issueTokenPair(clientID string, scopes connect.ScopeSet, parentRefreshHash string) (*connect.IssuedToken, error) {
	store := h.server.Connect()
	now := time.Now()

	rawAccess, err := connect.RandomToken(32)
	if err != nil {
		return nil, err
	}
	rawRefresh, err := connect.RandomToken(32)
	if err != nil {
		return nil, err
	}

	if err := store.CreateToken(connect.Token{
		Hash:      connect.HashToken(rawAccess),
		Kind:      connect.KindAccess,
		ClientID:  clientID,
		Scopes:    scopes,
		ExpiresAt: now.Add(connect.AccessTokenTTL),
		CreatedAt: now,
	}); err != nil {
		return nil, err
	}
	if err := store.CreateToken(connect.Token{
		Hash:       connect.HashToken(rawRefresh),
		Kind:       connect.KindRefresh,
		ClientID:   clientID,
		Scopes:     scopes,
		ParentHash: parentRefreshHash,
		ExpiresAt:  now.Add(connect.RefreshTokenTTL),
		CreatedAt:  now,
	}); err != nil {
		return nil, err
	}

	return &connect.IssuedToken{
		AccessToken:      rawAccess,
		RefreshToken:     rawRefresh,
		AccessExpiresIn:  int(connect.AccessTokenTTL.Seconds()),
		RefreshExpiresIn: int(connect.RefreshTokenTTL.Seconds()),
		Scopes:           scopes,
	}, nil
}

// ConnectRevoke is the RFC 7009 revocation endpoint. Always returns 200
// even if the token doesn't exist — RFC 7009 §2.2 ("invalid tokens do not
// cause an error response").
//
// POST /connect/revoke   (form-encoded: token=...&token_type_hint=...)
func (h *Handlers) ConnectRevoke(c *gin.Context) {
	if err := c.Request.ParseForm(); err != nil {
		c.Status(http.StatusOK)
		return
	}
	tok := c.PostForm("token")
	if tok == "" {
		c.Status(http.StatusOK)
		return
	}
	hash := connect.HashToken(tok)
	store := h.server.Connect()
	row, _ := store.LookupActiveToken(hash)
	if row != nil && row.Kind == connect.KindRefresh {
		_ = store.RevokeChain(hash)
	} else {
		_ = store.RevokeToken(hash)
	}
	c.Status(http.StatusOK)
}

// ConnectMetadata serves the OAuth 2.1 authorization-server discovery doc
// at /.well-known/oauth-authorization-server. Apps use it to find endpoints
// without hardcoding paths.
func (h *Handlers) ConnectMetadata(c *gin.Context) {
	scheme := "http"
	if c.Request.TLS != nil || c.GetHeader("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	issuer := scheme + "://" + c.Request.Host
	c.JSON(http.StatusOK, gin.H{
		"issuer":                            issuer,
		"authorization_endpoint":            issuer + "/connect/authorize",
		"token_endpoint":                    issuer + "/connect/token",
		"revocation_endpoint":               issuer + "/connect/revoke",
		"response_types_supported":          []string{"code"},
		"grant_types_supported":             []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":  []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"}, // public clients with PKCE
		"scopes_supported":                  []string{"files.read", "files.write"},
	})
}

// ConnectListClients returns every client this instance has ever seen,
// joined with their grant. Owner-authenticated.
//
// GET /api/connect/clients
func (h *Handlers) ConnectListClients(c *gin.Context) {
	rows, err := h.server.Connect().ListClients()
	if err != nil {
		log.Error().Err(err).Msg("connect: list clients failed")
		RespondInternalError(c, "failed to list clients")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		var scopes []string
		var grantedAt *int64
		var lastUsedAt *int64
		if r.Grant != nil {
			for _, s := range r.Grant.Scopes {
				scopes = append(scopes, s.String())
			}
			t := r.Grant.GrantedAt.Unix()
			grantedAt = &t
			if r.Grant.LastUsedAt != nil {
				u := r.Grant.LastUsedAt.Unix()
				lastUsedAt = &u
			}
		}
		out = append(out, gin.H{
			"id":           r.Client.ID,
			"name":         r.Client.Name,
			"iconUrl":      r.Client.IconURL,
			"verified":     r.Client.Verified,
			"firstSeenAt":  r.Client.FirstSeenAt.Unix(),
			"lastSeenAt":   r.Client.LastSeenAt.Unix(),
			"scopes":       scopes,
			"grantedAt":    grantedAt,
			"lastUsedAt":   lastUsedAt,
		})
	}
	RespondList(c, out, nil)
}

// ConnectRevokeClient deletes a client + cascades grants/codes/tokens.
// DELETE /api/connect/clients/:id
func (h *Handlers) ConnectRevokeClient(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		RespondBadRequest(c, "client id is required")
		return
	}
	store := h.server.Connect()
	// Revoke tokens first (so any in-flight requests fail) before we
	// cascade-delete the row.
	if err := store.RevokeClientTokens(id); err != nil {
		log.Error().Err(err).Msg("connect: revoke tokens failed")
	}
	if err := store.DeleteClient(id); err != nil {
		log.Error().Err(err).Msg("connect: delete client failed")
		RespondInternalError(c, "failed to revoke client")
		return
	}
	RespondNoContent(c)
}

// ConnectClientAudit returns recent audit rows for one client.
// GET /api/connect/clients/:id/audit?limit=N
func (h *Handlers) ConnectClientAudit(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		RespondBadRequest(c, "client id is required")
		return
	}
	limit := 100
	if v := c.Query("limit"); v != "" {
		// Best-effort; ListAudit clamps the value.
		var n int
		_, _ = fmtSscan(v, &n)
		if n > 0 {
			limit = n
		}
	}
	rows, err := h.server.Connect().ListAudit(id, limit)
	if err != nil {
		log.Error().Err(err).Msg("connect: list audit failed")
		RespondInternalError(c, "failed to list audit")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		out = append(out, gin.H{
			"id":       r.ID,
			"ts":       r.Ts.Unix(),
			"method":   r.Method,
			"path":     r.Path,
			"status":   r.Status,
			"scope":    r.Scope,
			"clientId": r.ClientID,
		})
	}
	RespondList(c, out, nil)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// errString is a tiny helper for plain-text validation errors.
func errString(s string) error { return &simpleErr{s} }

type simpleErr struct{ msg string }

func (e *simpleErr) Error() string { return e.msg }

// buildRedirect appends params to a redirect URI, preserving any existing
// query string on the URI itself.
func buildRedirect(base string, params map[string]string) string {
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	q := u.Query()
	for k, v := range params {
		if v == "" {
			continue
		}
		q.Set(k, v)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// oauthFormError writes the RFC 6749 §5.2 error response shape.
func oauthFormError(c *gin.Context, status int, code, description string) {
	c.JSON(status, gin.H{
		"error":             code,
		"error_description": description,
	})
}

// tokenResponseJSON shapes the issued token into the OAuth wire format.
func tokenResponseJSON(t *connect.IssuedToken) gin.H {
	return gin.H{
		"access_token":      t.AccessToken,
		"refresh_token":     t.RefreshToken,
		"token_type":        "Bearer",
		"expires_in":        t.AccessExpiresIn,
		"refresh_expires_in": t.RefreshExpiresIn,
		"scope":             strings.Join(scopeStrings(t.Scopes), " "),
	}
}

func scopeStrings(ss connect.ScopeSet) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = s.String()
	}
	return out
}

// fmtSscan is a tiny shim around fmt.Sscan that doesn't bring in the import
// at the top of the file (we already use stdlib elsewhere). Kept tiny so
// the parsing logic is obvious.
func fmtSscan(s string, n *int) (int, error) {
	// Inline parse — avoid pulling in fmt for one Sscan call.
	if s == "" {
		return 0, nil
	}
	v := 0
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch < '0' || ch > '9' {
			return i, errString("non-digit")
		}
		v = v*10 + int(ch-'0')
	}
	*n = v
	return len(s), nil
}
