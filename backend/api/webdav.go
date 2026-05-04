// WebDAV ingest surface for the integrations layer.
//
// Wire shape:
//
//	OPTIONS|GET|HEAD|PUT|DELETE|PROPFIND|PROPPATCH|MKCOL|COPY|MOVE|LOCK|UNLOCK
//	/webdav/*path
//
// Auth on every request (HTTP Basic):
//  1. Pull (username, password) from `Authorization: Basic …`.
//  2. Look up the credential by `(protocol=webdav, public_id=username)`.
//     The username is the credential's mldav_… public id. Reject if
//     unknown or revoked.
//  3. Bcrypt-verify the password against the stored secret hash.
//  4. On failure: respond 401 with `WWW-Authenticate: Basic realm="MyLifeDB"`
//     and an empty body. Some sync clients (notably Finder) refuse to
//     prompt the user when the body is non-empty.
//  5. On success: build a per-request webdav.Handler whose FileSystem is
//     a scope-rooted webdav.Dir(filepath.Join(userDataRoot, scopePath)).
//     The chroot is enforced by giving the WebDAV layer a filesystem
//     rooted at the prefix; clients literally cannot see files outside
//     the scope folder, regardless of `..` segments.
//
// URL-prefix handling:
//   - The route is registered as `/webdav/*path`, so gin sets
//     c.Param("path") to the suffix (e.g. `/notes/2026/foo.md`).
//   - Before delegating to webdav.Handler, the request's URL.Path is
//     rewritten so the handler sees the suffix only — without this it
//     would treat `/webdav` as part of the resource name and confuse
//     PROPFIND/MOVE/COPY targets.
//   - We also set Handler.Prefix = "" since we've already stripped.
//
// Scope check:
//   - Phase 0's Store.Create rejects credentials with !=1 scope. The
//     credential carries exactly one of files.read:/p or files.write:/p.
//   - Read verbs (OPTIONS, GET, HEAD, PROPFIND) are always allowed for
//     any path-scoped credential.
//   - Write verbs (PUT, DELETE, PROPPATCH, MKCOL, COPY, MOVE, LOCK,
//     UNLOCK) require files.write; a read-only credential is rejected
//     with 403 before the request reaches the WebDAV layer.
//
// Audit:
//   - One integration_audit row per request. Method = HTTP verb,
//     path = the suffix (post-strip), scope_family = "files.read" for
//     safe verbs and "files.write" for the rest (or "" on denial).
//   - Captured via a gin.ResponseWriter wrapper so the row's status
//     reflects what the client actually saw.
//
// Mounted only when `settings.Integrations.Surfaces.WebDAV == true`. When
// the toggle is off the route is not registered at all (404), minimizing
// the attack surface for users who don't need the WebDAV surface.
package api

import (
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/webdav"

	"github.com/xiaoyuanzhu-com/my-life-db/connect"
	"github.com/xiaoyuanzhu-com/my-life-db/integrations"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// webdavMaxBodyBytes caps a single request body. Generous (1 GB) so
// typical document/photo/video uploads from sync clients (Obsidian
// Remotely Save, PhotoSync, etc.) succeed; larger uploads should use
// the TUS surface or an S3 client.
const webdavMaxBodyBytes int64 = 1 << 30 // 1 GB

// webdavReadVerbs lists the WebDAV verbs that only need files.read.
// Everything else (PUT, DELETE, PROPPATCH, MKCOL, COPY, MOVE, LOCK,
// UNLOCK) requires files.write.
var webdavReadVerbs = map[string]struct{}{
	http.MethodOptions: {},
	http.MethodGet:     {},
	http.MethodHead:    {},
	"PROPFIND":         {},
}

// WebDAVHandler is the gin entrypoint for /webdav/*path. Authenticates
// via HTTP Basic, scope-checks against the credential's single scope,
// then delegates to a per-request webdav.Handler rooted at the scope
// folder.
func (h *Handlers) WebDAVHandler(c *gin.Context) {
	store := h.server.Integrations()

	username, password, ok := basicAuth(c.Request)
	if !ok {
		webdavChallenge(c)
		return
	}

	cred, err := resolveWebDAVCredential(store, username, password)
	if err != nil || cred == nil {
		// Single-shape 401 — matches webhook's enumeration-resistant
		// response. Don't tell the client whether the username or the
		// password was wrong.
		webdavChallenge(c)
		return
	}

	// Per-credential rate limit. WebDAV clients (Finder, Obsidian
	// Remotely Save, etc.) honor a bare 429 with Retry-After; we send
	// a 1-second hint so well-behaved clients back off briefly.
	if !h.server.IntegrationsLimiter().Allow(cred.ID) {
		c.Header("Retry-After", "1")
		c.Status(http.StatusTooManyRequests)
		return
	}

	scopes, err := connect.ParseScopes(cred.Scope)
	if err != nil {
		log.Error().Err(err).Str("credentialId", cred.ID).Str("scope", cred.Scope).
			Msg("webdav: stored credential scope failed to parse")
		c.Status(http.StatusInternalServerError)
		return
	}

	scopePath := integrations.PickScopePath(scopes)
	if scopePath == "" {
		log.Error().Str("credentialId", cred.ID).Msg("webdav: credential has no path scope")
		c.Status(http.StatusInternalServerError)
		return
	}

	method := c.Request.Method
	scopeFamily := webdavRequiredFamily(method)
	clientIP := c.ClientIP()

	// Suffix is whatever follows /webdav in the request URL — gin's
	// catch-all `*path` returns it WITH the leading slash, e.g. a
	// request to `/webdav/notes/foo.md` yields `/notes/foo.md`. Falls
	// back to "/" so PROPFIND on the bare mount root (`/webdav`) still
	// hits the handler with a sensible path.
	suffix := c.Param("path")
	if suffix == "" {
		suffix = "/"
	}

	// Write-verb gate: a read-only credential cannot mutate.
	credIDCopy := cred.ID
	if scopeFamily == "files.write" {
		if !integrations.ScopesAllowFamily(scopes, "files.write") {
			store.RecordAudit(credIDCopy, clientIP, method, suffix, http.StatusForbidden, "")
			c.Status(http.StatusForbidden)
			return
		}
	}

	// Best-effort touch — non-fatal if the DB blip swallows it.
	store.TouchLastUsed(cred.ID, clientIP)

	// Cap request body so a misconfigured client can't OOM us.
	if c.Request.Body != nil {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, webdavMaxBodyBytes)
	}

	// Build the scope-rooted filesystem. webdav.Dir is a chroot — the
	// stdlib's webdav package refuses ".." escapes, so this is the only
	// access-control check we need on the file path.
	absScopePath := filepath.Join(h.server.Cfg().UserDataDir, scopePath)
	fs := webdav.Dir(absScopePath)

	// Strip the /webdav prefix from the URL path before delegating, and
	// set Handler.Prefix to "" since we've already done the strip
	// ourselves. (Setting Handler.Prefix = "/webdav" would also work,
	// but only when URL.Path still carries the prefix — which gin's
	// catch-all routing means we'd have to reconstruct.)
	originalPath := c.Request.URL.Path
	c.Request.URL.Path = suffix
	defer func() { c.Request.URL.Path = originalPath }()

	// Wrap the response writer so we can capture the status the client
	// actually saw (webdav.Handler writes the status itself; gin's
	// c.Writer.Status() picks it up).
	handler := &webdav.Handler{
		Prefix:     "",
		FileSystem: fs,
		LockSystem: h.server.WebDAVLocks(),
		Logger: func(req *http.Request, err error) {
			if err == nil {
				return
			}
			log.Debug().Err(err).Str("credentialId", credIDCopy).
				Str("method", req.Method).Str("path", req.URL.Path).
				Msg("webdav: handler error")
		},
	}
	handler.ServeHTTP(c.Writer, c.Request)

	// Audit the result. Use the status the writer ended up with —
	// webdav.Handler may have set anything from 200 to 507.
	auditFamily := scopeFamily
	if c.Writer.Status() >= 400 {
		auditFamily = ""
	}
	store.RecordAudit(credIDCopy, clientIP, method, suffix, c.Writer.Status(), auditFamily)
}

// resolveWebDAVCredential looks up a non-revoked WebDAV credential by
// `(protocol, public_id=username)`, then bcrypt-verifies the password.
// Returns (nil, nil) for any auth failure — the caller turns that into
// a single-shape 401. Never returns a partial credential on success.
func resolveWebDAVCredential(store *integrations.Store, username, password string) (*integrations.Credential, error) {
	if username == "" || password == "" {
		return nil, nil
	}
	cred, err := store.LookupActiveByPublicID(integrations.ProtoWebDAV, username)
	if err != nil {
		return nil, err
	}
	if cred == nil || cred.Protocol != integrations.ProtoWebDAV {
		return nil, nil
	}
	hash, err := store.VerifyHash(cred.ID)
	if err != nil {
		return nil, err
	}
	if hash == "" || !integrations.VerifySecret(hash, password) {
		return nil, nil
	}
	return cred, nil
}

// basicAuth parses an `Authorization: Basic …` header. Returns
// (user, pass, true) on success or ("", "", false) if the header is
// absent / malformed / empty. Constant-time-ish: a missing header is
// distinguishable from a malformed one only by `ok=false`; both shapes
// route to the same 401.
//
// (`net/http`'s req.BasicAuth() does the same parsing, but we keep the
// implementation explicit so the constant-time intent is visible.)
func basicAuth(r *http.Request) (user, pass string, ok bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Basic "
	if len(h) < len(prefix) || subtle.ConstantTimeCompare([]byte(h[:len(prefix)]), []byte(prefix)) != 1 {
		return "", "", false
	}
	raw, err := base64.StdEncoding.DecodeString(h[len(prefix):])
	if err != nil {
		return "", "", false
	}
	i := strings.IndexByte(string(raw), ':')
	if i < 0 {
		return "", "", false
	}
	return string(raw[:i]), string(raw[i+1:]), true
}

// webdavChallenge writes a WebDAV-shaped 401: empty body + Basic
// challenge so the client prompts the user for credentials.
func webdavChallenge(c *gin.Context) {
	c.Header("WWW-Authenticate", `Basic realm="MyLifeDB"`)
	c.Status(http.StatusUnauthorized)
}

// webdavRequiredFamily reports which scope family the given HTTP method
// requires. PROPFIND/OPTIONS/GET/HEAD are reads; everything else is a
// write.
func webdavRequiredFamily(method string) string {
	if _, ok := webdavReadVerbs[method]; ok {
		return "files.read"
	}
	return "files.write"
}

