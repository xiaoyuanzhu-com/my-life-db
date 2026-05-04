// Webhook ingest surface for the integrations layer.
//
// Wire shape:
//
//	POST /webhook/<credential-id>/<subpath>
//	PUT  /webhook/<credential-id>/<subpath>
//
// Auth on every request:
//  1. Pull the bearer token from `Authorization: Bearer <token>` (preferred)
//     or `?token=<token>` (fallback for senders that can't set headers —
//     iOS Shortcuts, IFTTT, some browsers acting as testbeds).
//  2. Look up the credential by the URL `:credentialId`. Reject if unknown,
//     revoked, or not protocol=webhook.
//  3. Bcrypt-verify the presented secret against the stored hash.
//  4. Attach a RequestPrincipal carrying the credential's scope to the gin
//     context so the same RequireConnectScope middleware that gates Connect
//     bearer tokens enforces "files.write:<scope-path>" against
//     "<scope-path>/<subpath>".
//
// Body handling:
//   - Raw body (any Content-Type that is NOT multipart/form-data) writes one
//     file at `<scope-path>/<subpath>`. Filename is the trailing path
//     component of `subpath`.
//   - multipart/form-data writes one file per part, using the part filename
//     when present (otherwise the form fieldname). The path prefix becomes
//     `<scope-path>/<subpath>/<filename>`. (Pass `subpath=""` to land them
//     directly under the scope root.)
//
// Mounted only when `settings.Integrations.Surfaces.Webhook == true`. When
// the toggle is off the route is not registered at all (404), minimizing
// the attack surface for users who don't need the webhook surface.
package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/xiaoyuanzhu-com/my-life-db/connect"
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/integrations"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// Cap on a single raw-body request. 100 MB matches the documented webhook
// ceiling; multipart uploads are bounded by the same limit on the gin side
// via MaxMultipartMemory + this LimitReader on each part.
const webhookMaxBodyBytes = 100 << 20 // 100 MB

// resolveCredentialBearer extracts (credentialID, presentedSecret) from the
// request, looks up an active webhook credential by id, and bcrypt-verifies
// the secret. Returns the resolved credential on success.
//
// Errors are surface-flat (HTTP 401 — opaque "invalid credential") so a
// caller cannot distinguish "no such id" from "wrong secret" via the
// response. Anything more specific would help an attacker enumerate ids.
func resolveCredentialBearer(c *gin.Context, store *integrations.Store, credentialID string) (*integrations.Credential, error) {
	presented := bearerOrQueryToken(c)
	if presented == "" {
		return nil, errors.New("missing bearer token")
	}
	if credentialID == "" {
		return nil, errors.New("missing credential id")
	}

	cred, err := store.LookupActiveByID(credentialID)
	if err != nil {
		return nil, fmt.Errorf("credential lookup failed: %w", err)
	}
	if cred == nil || cred.Protocol != integrations.ProtoWebhook {
		return nil, errors.New("invalid credential")
	}

	hash, err := store.VerifyHash(cred.ID)
	if err != nil {
		return nil, fmt.Errorf("credential hash fetch failed: %w", err)
	}
	if hash == "" || !integrations.VerifySecret(hash, presented) {
		return nil, errors.New("invalid credential")
	}
	return cred, nil
}

// bearerOrQueryToken pulls the token from `Authorization: Bearer …` first,
// then from `?token=…`. The dedicated extractBearer in connect_middleware.go
// uses `?connect_access_token=` (Connect's name); webhook senders use
// `?token=` per the design doc (and standard webhook ergonomics).
func bearerOrQueryToken(c *gin.Context) string {
	if h := c.GetHeader("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	if t := strings.TrimSpace(c.Query("token")); t != "" {
		return t
	}
	return ""
}

// WebhookIngest handles POST/PUT /webhook/:credentialId/*subpath.
//
// On success: writes one or more files into the credential's scope folder
// and returns 201 Created with `{ "data": { "path": "/scope/.../file" } }`
// (the path of the most recent write — multipart returns the last part).
//
// On failure: standard error envelope via RespondCoded / RespondBadRequest.
func (h *Handlers) WebhookIngest(c *gin.Context) {
	store := h.server.Integrations()
	credentialID := c.Param("credentialId")

	cred, err := resolveCredentialBearer(c, store, credentialID)
	if err != nil {
		// Single-shape 401 — see resolveCredentialBearer comment.
		RespondCoded(c, http.StatusUnauthorized, "AUTH_INVALID_TOKEN",
			"webhook credential is missing, invalid, or revoked")
		return
	}

	// Parse the credential's scope into a ScopeSet so the existing
	// scope-enforcement machinery can gate the request. Validation already
	// happened at credential-create time, so failure here is a corrupted
	// row — surface as 500 rather than 400.
	scopes, err := connect.ParseScopes(cred.Scope)
	if err != nil {
		log.Error().Err(err).Str("credentialId", cred.ID).Str("scope", cred.Scope).
			Msg("webhook: stored credential scope failed to parse")
		RespondInternalError(c, "credential is misconfigured")
		return
	}

	// Build the scope-prefix string from the (single) scope on this
	// credential. The webhook design pins the credential to ONE folder;
	// we use that folder as the path prefix and reject anything that
	// path-cleans outside it.
	scopePath := integrations.PickScopePath(scopes)
	if scopePath == "" {
		log.Error().Str("credentialId", cred.ID).Msg("webhook: credential has no path scope")
		RespondInternalError(c, "credential is misconfigured")
		return
	}

	clientIP := c.ClientIP()

	// Attach the principal so RequireConnectScope-style enforcement (and
	// CheckConnectScope, if a future caller wants to use it inline) sees
	// the credential's scopes. Audit goes to integration_audit, not
	// connect_audit.
	credIDCopy := cred.ID
	setRequestPrincipal(c, &RequestPrincipal{
		Scopes:      scopes,
		PrincipalID: credIDCopy,
		AuditFn: func(method, urlPath string, status int, scopeFamily string) {
			store.RecordAudit(credIDCopy, clientIP, method, urlPath, status, scopeFamily)
		},
	})

	// Best-effort touch — non-fatal if the DB blip swallows it.
	store.TouchLastUsed(cred.ID, clientIP)

	subpath := strings.TrimPrefix(c.Param("subpath"), "/")

	// Multipart: each part lands as one file under
	// `<scope-path>/<subpath>/<part-filename>`. Single-body: one file at
	// `<scope-path>/<subpath>` (subpath required, since the URL must name
	// the destination filename).
	if strings.HasPrefix(c.GetHeader("Content-Type"), "multipart/form-data") {
		h.webhookHandleMultipart(c, cred, scopePath, subpath)
		return
	}
	h.webhookHandleRawBody(c, cred, scopePath, subpath)
}

// webhookHandleRawBody writes the request body to one file at
// `<scopePath>/<subpath>`. `subpath` must be non-empty (it names the file).
func (h *Handlers) webhookHandleRawBody(c *gin.Context, cred *integrations.Credential, scopePath, subpath string) {
	if subpath == "" {
		RespondBadRequest(c, "subpath is required for non-multipart uploads (it names the destination file)")
		return
	}

	resolved, ok := resolveAndCheckPath(c, h, cred, scopePath, subpath)
	if !ok {
		return
	}

	// Hard-cap the body to webhookMaxBodyBytes. fs.Service.WriteFile reads
	// from the io.Reader; limiting it here means we never page in a 10 GB
	// payload from a misconfigured sender.
	limited := io.LimitReader(c.Request.Body, webhookMaxBodyBytes+1)

	mimeType := c.GetHeader("Content-Type")
	if i := strings.Index(mimeType, ";"); i >= 0 {
		mimeType = strings.TrimSpace(mimeType[:i])
	}
	if mimeType == "" {
		mimeType = utils.DetectMimeType(resolved)
	}

	// Use the request-scoped context so a sender disconnect aborts the
	// write — fs.Service.WriteFile honors ctx cancellation.
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Minute)
	defer cancel()
	result, err := h.server.FS().WriteFile(ctx, fs.WriteRequest{
		Path:            resolved,
		Content:         limited,
		MimeType:        mimeType,
		Source:          "webhook",
		ComputeMetadata: true,
		Sync:            true,
	})
	if err != nil {
		log.Error().Err(err).Str("credentialId", cred.ID).Str("path", resolved).
			Msg("webhook: WriteFile failed")
		RespondInternalError(c, "failed to write file")
		return
	}

	log.Info().
		Str("credentialId", cred.ID).
		Str("path", resolved).
		Bool("isNew", result.IsNew).
		Msg("webhook: file written")

	RespondCreated(c, gin.H{"path": "/" + resolved}, "/raw/"+resolved)
}

// webhookHandleMultipart writes one file per multipart part to
// `<scopePath>/<subpath>/<filename>`. `subpath` may be empty (parts land
// directly under the scope folder).
func (h *Handlers) webhookHandleMultipart(c *gin.Context, cred *integrations.Credential, scopePath, subpath string) {
	// MaxMultipartMemory caps the in-memory portion of multipart parsing;
	// the rest spills to a tempfile. Set to the full ceiling so small
	// payloads don't touch disk.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, webhookMaxBodyBytes)

	form, err := c.MultipartForm()
	if err != nil {
		RespondBadRequest(c, "failed to parse multipart form: "+err.Error())
		return
	}
	defer form.RemoveAll()

	if len(form.File) == 0 {
		RespondBadRequest(c, "multipart form has no file parts")
		return
	}

	var lastResolved string
	written := 0
	for fieldname, parts := range form.File {
		for _, part := range parts {
			filename := strings.TrimSpace(part.Filename)
			if filename == "" {
				filename = fieldname
			}
			// Reject parts whose filename would escape — better to fail
			// fast than land a partial batch.
			if filename == "" || strings.Contains(filename, "/") || strings.Contains(filename, `\`) {
				RespondBadRequest(c, "multipart part has missing or path-bearing filename: "+fieldname)
				return
			}

			combined := joinSubpath(subpath, filename)
			resolved, ok := resolveAndCheckPath(c, h, cred, scopePath, combined)
			if !ok {
				return
			}

			if err := h.webhookWriteOnePart(c, cred, part, resolved); err != nil {
				log.Error().Err(err).Str("credentialId", cred.ID).Str("path", resolved).
					Msg("webhook: multipart part write failed")
				RespondInternalError(c, "failed to write file")
				return
			}
			lastResolved = resolved
			written++
		}
	}

	log.Info().
		Str("credentialId", cred.ID).
		Int("partsWritten", written).
		Msg("webhook: multipart upload complete")

	RespondCreated(c, gin.H{"path": "/" + lastResolved, "count": written}, "/raw/"+lastResolved)
}

// webhookWriteOnePart writes one multipart.FileHeader to `resolved` via
// fs.Service.WriteFile. Caller has already done scope checking.
func (h *Handlers) webhookWriteOnePart(c *gin.Context, cred *integrations.Credential, part *multipart.FileHeader, resolved string) error {
	src, err := part.Open()
	if err != nil {
		return fmt.Errorf("open part: %w", err)
	}
	defer src.Close()

	mimeType := part.Header.Get("Content-Type")
	if i := strings.Index(mimeType, ";"); i >= 0 {
		mimeType = strings.TrimSpace(mimeType[:i])
	}
	if mimeType == "" {
		mimeType = utils.DetectMimeType(resolved)
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Minute)
	defer cancel()
	_, err = h.server.FS().WriteFile(ctx, fs.WriteRequest{
		Path:            resolved,
		Content:         src,
		MimeType:        mimeType,
		Source:          "webhook",
		ComputeMetadata: true,
		Sync:            true,
	})
	return err
}

// resolveAndCheckPath joins scopePath + subpath, normalizes the result,
// confirms it's still rooted under scopePath, then runs the scope check
// via CheckConnectScope (which fires the audit hook attached to the
// principal). Returns (resolved, true) on success. On failure, it has
// already written the error response — caller returns immediately.
func resolveAndCheckPath(c *gin.Context, h *Handlers, cred *integrations.Credential, scopePath, subpath string) (string, bool) {
	combined := joinSubpath(scopePath, subpath)
	cleaned := path.Clean("/" + combined)
	// Enforce containment after Clean. `..` collapses lexically here so
	// the prefix check is sufficient.
	prefix := path.Clean("/" + scopePath)
	if cleaned != prefix && !strings.HasPrefix(cleaned, prefix+"/") {
		RespondCoded(c, http.StatusForbidden, "FORBIDDEN",
			"resolved path escapes credential scope")
		return "", false
	}

	// CheckConnectScope reads the principal we attached above and runs
	// the family + path check. files.write because every webhook write
	// is a write.
	if !h.CheckConnectScope(c, "files.write", cleaned) {
		return "", false
	}
	return strings.TrimPrefix(cleaned, "/"), true
}

// joinSubpath joins two URL-style path segments with a single slash,
// trimming leading/trailing slashes so callers can pass either style.
// Empty segments are skipped.
func joinSubpath(a, b string) string {
	a = strings.Trim(a, "/")
	b = strings.Trim(b, "/")
	switch {
	case a == "" && b == "":
		return ""
	case a == "":
		return b
	case b == "":
		return a
	}
	return a + "/" + b
}

