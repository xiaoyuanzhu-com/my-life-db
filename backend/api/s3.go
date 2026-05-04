// S3-compatible ingest surface for the integrations layer.
//
// Wire shape:
//
//	GET     /s3/                                       (ListBuckets)
//	GET     /s3/<bucket>/                              (ListObjectsV2)
//	HEAD    /s3/<bucket>/                              (HeadBucket)
//	PUT     /s3/<bucket>/                              (CreateBucket — no-op stub)
//	GET     /s3/<bucket>/<key>                         (GetObject; supports Range)
//	HEAD    /s3/<bucket>/<key>                         (HeadObject)
//	PUT     /s3/<bucket>/<key>                         (PutObject; or CopyObject if x-amz-copy-source)
//	DELETE  /s3/<bucket>/<key>                         (DeleteObject)
//	POST    /s3/<bucket>/<key>?uploads                 (CreateMultipartUpload)
//	PUT     /s3/<bucket>/<key>?partNumber=N&uploadId=… (UploadPart)
//	POST    /s3/<bucket>/<key>?uploadId=…              (CompleteMultipartUpload)
//	DELETE  /s3/<bucket>/<key>?uploadId=…              (AbortMultipartUpload)
//	GET     /s3/<bucket>/?uploads                      (ListMultipartUploads — empty stub)
//
// Auth on every request:
//  1. Parse SigV4 from `Authorization: AWS4-HMAC-SHA256 …` header (preferred)
//     or from a pre-signed URL query (`X-Amz-Algorithm=AWS4-HMAC-SHA256`).
//  2. Look up the credential by `(protocol=s3, public_id=<access-key-id>)`.
//     The access key id is the credential's mlda_/AKIA_MLD_ public id.
//  3. Verify the SigV4 signature against the credential's bcrypt-stored secret.
//     For PUT/POST/DELETE we drain the body up to s3MaxBodyBytes so we can
//     hash-verify (when `x-amz-content-sha256` is a hex digest); for paths
//     marked UNSIGNED-PAYLOAD we trust the auth and let the body stream into
//     the destination.
//  4. On failure: respond with an AWS-shaped XML error envelope so SDKs can
//     branch on the code (SignatureDoesNotMatch, InvalidAccessKeyId, etc.).
//
// Bucket abstraction:
//   - The `<bucket>` segment is decorative — the credential is pinned to a
//     single scope folder, and that folder is the only namespace this
//     credential can address. We accept any bucket name; the resolved
//     filesystem root is `userDataRoot + scopePath`.
//   - ListBuckets emits exactly one bucket whose name is the slash-escaped
//     scope path (e.g. scope `/health/apple/raw` → bucket `health-apple-raw`).
//     This name has no semantic meaning beyond being a stable label clients
//     can use in their config.
//
// Scope check:
//   - Phase 0's Store.Create rejects credentials with !=1 scope. The
//     credential carries exactly one of files.read:/p or files.write:/p.
//   - Read verbs (GET, HEAD) are allowed for any path-scoped credential.
//   - Write verbs (PUT, DELETE, POST) require files.write; a read-only
//     credential is rejected with 403 / AccessDenied before the request
//     reaches any filesystem code.
//
// Audit:
//   - One integration_audit row per request. Method = HTTP verb, path = the
//     key (post-bucket-strip), scope_family = "files.read" or "files.write"
//     on success and "" on denial.
//
// Mounted only when `settings.Integrations.Surfaces.S3 == true`. When the
// toggle is off the route is not registered at all (404 by default),
// minimizing the attack surface for users who don't need the S3 surface.
package api

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/xiaoyuanzhu-com/my-life-db/connect"
	"github.com/xiaoyuanzhu-com/my-life-db/integrations"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// s3MaxBodyBytes caps a single PutObject / UploadPart body when we have to
// buffer it for SHA-256 verification. 5 GB matches AWS's documented single-
// object PUT limit (clients should multipart anything larger). Multipart
// part uploads are subject to the same per-request cap.
const s3MaxBodyBytes int64 = 5 << 30 // 5 GB

// s3Context carries the resolved auth state for a single S3 request, threaded
// through the per-op handlers in s3_objects.go / s3_listing.go / s3_multipart.go.
//
// We pass this struct around (rather than re-pulling pieces from the gin
// context each time) so the per-op handlers stay simple — they get a fully
// resolved credential, scope path, and request body (already drained when
// applicable) and emit responses.
type s3Context struct {
	cred       *integrations.Credential
	scopes     connect.ScopeSet
	scopePath  string // e.g. "health/apple/raw" (no leading slash)
	bucketName string // decorative; always equal to bucketNameForScope(scopePath)
	key        string // post-bucket-strip; "" for bucket-level ops, "foo/bar.txt" for object-level
	body       []byte // drained body bytes (only set when we needed to verify SHA-256)
	clientIP   string
}

// bucketNameForScope turns a scope path into the decorative bucket name we
// expose via ListBuckets. Slashes become dashes; leading/trailing dashes
// trimmed. Examples:
//
//	"/health/apple/raw"  → "health-apple-raw"
//	"/notes"             → "notes"
//	"/"                  → "root"
func bucketNameForScope(scopePath string) string {
	trimmed := strings.Trim(scopePath, "/")
	if trimmed == "" {
		return "root"
	}
	return strings.ReplaceAll(trimmed, "/", "-")
}

// s3VerbFamily maps HTTP method → required scope family.
//
// GET / HEAD → files.read; everything else → files.write. Same convention
// the WebDAV surface uses; mirrors AWS's behavior of treating Get* / List*
// as reads and everything else as writes.
func s3VerbFamily(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead:
		return "files.read"
	default:
		return "files.write"
	}
}

// S3Handler is the gin entrypoint for /s3/*path. Authenticates via SigV4,
// scope-checks against the credential's single scope, then dispatches to
// per-op handlers based on the HTTP method + query parameters.
//
// Why one big dispatcher: the S3 wire protocol overloads HTTP methods
// based on (1) presence of bucket vs key in the URL and (2) reserved query
// keys (`?uploads`, `?uploadId`, `?list-type=2`). Routing this in gin's
// router would require dozens of brittle Param-matching rules; a single
// dispatcher with a flat switch is much easier to reason about.
func (h *Handlers) S3Handler(c *gin.Context) {
	store := h.server.Integrations()

	// ---- Auth ----------------------------------------------------------
	parsed, err := h.s3ParseAuth(c)
	if err != nil {
		log.Debug().Err(err).Msg("s3: auth parse failed")
		writeS3Error(c, http.StatusForbidden, S3ErrAuthorizationHeaderMalformed,
			"failed to parse SigV4 authorization", c.Request.URL.Path)
		return
	}

	cred, err := store.LookupActiveByPublicID(integrations.ProtoS3, parsed.AccessKeyID)
	if err != nil {
		log.Error().Err(err).Msg("s3: credential lookup failed")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"credential lookup failed", c.Request.URL.Path)
		return
	}
	if cred == nil || cred.Protocol != integrations.ProtoS3 {
		writeS3Error(c, http.StatusForbidden, S3ErrInvalidAccessKeyID,
			"the AWS access key id you provided does not exist in our records",
			c.Request.URL.Path)
		return
	}

	hash, err := store.VerifyHash(cred.ID)
	if err != nil || hash == "" {
		writeS3Error(c, http.StatusForbidden, S3ErrInvalidAccessKeyID,
			"the AWS access key id you provided does not exist in our records",
			c.Request.URL.Path)
		return
	}

	// We store the bcrypt hash, but SigV4 needs the raw secret to derive
	// the signing key. The integrations layer addresses this by deriving
	// the bcrypt-checked secret in two stages: the request carries the
	// raw secret (SigV4 derived) which we then bcrypt-verify against the
	// stored hash. For S3 we instead reverse the flow — recompute the
	// SigV4 expected signature using the stored hash as the signing
	// secret directly; that means the "secret" effectively IS the bcrypt
	// hash for SigV4 purposes. This is acceptable because the hash has
	// the same secrecy properties as the secret (never leaves the DB)
	// and is deterministic input to the SigV4 derivation.
	//
	// Concretely, we feed `hash` straight to verifySignature as the
	// `secretKey` argument — both the client and the server agree on
	// using the bcrypt hash as the signing key. The client gets the
	// hash at credential-creation time (it's returned in the same
	// IssuedCredential payload alongside the raw secret).
	//
	// NOTE: this design means leaking the bcrypt hash is equivalent to
	// leaking the raw secret for S3 use. The hash is still bcrypt-strong
	// against offline guessing of the raw secret if it ever leaks.
	body, err := h.s3MaybeDrainBody(c, parsed.Presigned)
	if err != nil {
		writeS3Error(c, http.StatusBadRequest, S3ErrEntityTooLarge,
			err.Error(), c.Request.URL.Path)
		return
	}

	if err := verifySignature(c.Request, parsed, hash, body); err != nil {
		log.Debug().Err(err).Str("credentialId", cred.ID).Msg("s3: signature verify failed")
		// Streaming SigV4 surfaces specifically as XAmzContentSHA256Mismatch
		// so SDK error handling can spot the unsupported mode and retry
		// with a different chunking strategy.
		if strings.Contains(err.Error(), "streaming SigV4 not supported") {
			writeS3Error(c, http.StatusBadRequest, S3ErrXAmzContentSHA256Mismatch,
				"streaming SigV4 (STREAMING-AWS4-HMAC-SHA256-PAYLOAD) is not supported by this server; use --s3-upload-cutoff=0 or --s3-disable-checksum",
				c.Request.URL.Path)
			return
		}
		writeS3Error(c, http.StatusForbidden, S3ErrSignatureDoesNotMatch,
			"the request signature we calculated does not match the signature you provided",
			c.Request.URL.Path)
		return
	}

	// ---- Scope resolution ---------------------------------------------
	scopes, err := connect.ParseScopes(cred.Scope)
	if err != nil {
		log.Error().Err(err).Str("credentialId", cred.ID).Str("scope", cred.Scope).
			Msg("s3: stored credential scope failed to parse")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"credential is misconfigured", c.Request.URL.Path)
		return
	}
	scopePath := integrations.PickScopePath(scopes)
	if scopePath == "" {
		log.Error().Str("credentialId", cred.ID).Msg("s3: credential has no path scope")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"credential is misconfigured", c.Request.URL.Path)
		return
	}

	method := c.Request.Method
	scopeFamily := s3VerbFamily(method)
	clientIP := c.ClientIP()

	// Write-verb gate: a read-only credential cannot mutate.
	if scopeFamily == "files.write" {
		if !integrations.ScopesAllowFamily(scopes, "files.write") {
			store.RecordAudit(cred.ID, clientIP, method, c.Request.URL.Path, http.StatusForbidden, "")
			writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
				"this credential is read-only", c.Request.URL.Path)
			return
		}
	}

	// ---- Bucket + key extraction --------------------------------------
	bucket, key := splitBucketKey(c.Param("path"))
	scopeBucket := bucketNameForScope(strings.TrimPrefix(scopePath, "/"))

	// Best-effort touch — non-fatal if the DB blip swallows it.
	store.TouchLastUsed(cred.ID, clientIP)

	ctx := &s3Context{
		cred:       cred,
		scopes:     scopes,
		scopePath:  strings.TrimPrefix(scopePath, "/"),
		bucketName: scopeBucket,
		key:        key,
		body:       body,
		clientIP:   clientIP,
	}

	// ---- Dispatch -----------------------------------------------------
	q := c.Request.URL.Query()
	switch {
	// Bucket-level: GET /s3/ → ListBuckets
	case bucket == "" && key == "":
		if method != http.MethodGet {
			h.s3MethodNotAllowed(c, ctx, method)
			return
		}
		h.s3ListBuckets(c, ctx)

	// Bucket-level: /s3/<bucket>/
	case bucket != "" && key == "":
		switch method {
		case http.MethodGet:
			if q.Has("uploads") {
				h.s3ListMultipartUploads(c, ctx)
				return
			}
			// list-type=2 is the V2 listing protocol; we only implement V2.
			// V1 callers (no list-type) get a V2-shaped response, which is
			// what most modern SDKs send in practice.
			h.s3ListObjectsV2(c, ctx, q)
		case http.MethodHead:
			h.s3HeadBucket(c, ctx)
		case http.MethodPut:
			// CreateBucket on the credential's bucket is a no-op success;
			// the bucket already "exists" by virtue of the credential
			// being scoped to a folder. CreateBucket on any other name
			// is rejected.
			h.s3CreateBucket(c, ctx, bucket)
		default:
			h.s3MethodNotAllowed(c, ctx, method)
		}

	// Object-level: /s3/<bucket>/<key>
	case bucket != "" && key != "":
		switch method {
		case http.MethodGet:
			h.s3GetObject(c, ctx)
		case http.MethodHead:
			h.s3HeadObject(c, ctx)
		case http.MethodPut:
			// CopyObject is signaled by the x-amz-copy-source header.
			if c.GetHeader("x-amz-copy-source") != "" || c.GetHeader("X-Amz-Copy-Source") != "" {
				h.s3CopyObject(c, ctx)
				return
			}
			// UploadPart is signaled by `?partNumber=N&uploadId=…`.
			if q.Has("uploadId") && q.Has("partNumber") {
				h.s3UploadPart(c, ctx, q)
				return
			}
			h.s3PutObject(c, ctx)
		case http.MethodPost:
			if q.Has("uploads") {
				h.s3CreateMultipartUpload(c, ctx)
				return
			}
			if q.Has("uploadId") {
				h.s3CompleteMultipartUpload(c, ctx, q)
				return
			}
			h.s3MethodNotAllowed(c, ctx, method)
		case http.MethodDelete:
			if q.Has("uploadId") {
				h.s3AbortMultipartUpload(c, ctx, q)
				return
			}
			h.s3DeleteObject(c, ctx)
		default:
			h.s3MethodNotAllowed(c, ctx, method)
		}

	default:
		h.s3MethodNotAllowed(c, ctx, method)
	}
}

// s3ParseAuth pulls a parsed SigV4 request out of either the Authorization
// header or the presigned-URL query parameters. Returns an error if neither
// is present or the parse fails.
func (h *Handlers) s3ParseAuth(c *gin.Context) (*sigV4Request, error) {
	if authz := c.GetHeader("Authorization"); strings.HasPrefix(authz, sigV4Algorithm+" ") {
		return parseAuthorizationHeader(authz, c.GetHeader("X-Amz-Date"))
	}
	if c.Query("X-Amz-Algorithm") == sigV4Algorithm {
		return parsePresignedQuery(c.Request.URL.Query())
	}
	return nil, errAuthMissing
}

// errAuthMissing is the sentinel for "no SigV4 of any kind on this request".
// Surfaces as AuthorizationHeaderMalformed in the error response.
var errAuthMissing = errAuth("missing SigV4 authentication (no Authorization header and no X-Amz-Algorithm query)")

// errAuth is a minimal error type for surface-internal sentinels.
type errAuth string

func (e errAuth) Error() string { return string(e) }

// s3MaybeDrainBody reads the request body into memory if-and-only-if we
// need to hash-verify it. Specifically:
//
//   - Presigned URLs: the spec uses UNSIGNED-PAYLOAD, so we never need the
//     body for verification — return (nil, nil).
//   - Header auth with x-amz-content-sha256 = UNSIGNED-PAYLOAD or
//     STREAMING-AWS4-HMAC-SHA256-PAYLOAD: same — no body hash needed.
//   - Header auth with a hex SHA-256: drain so verifySignature can compare.
//
// `s3MaxBodyBytes` caps the buffer; clients that want larger uploads must
// use multipart (which has its own per-part limit).
func (h *Handlers) s3MaybeDrainBody(c *gin.Context, presigned bool) ([]byte, error) {
	if presigned {
		return nil, nil
	}
	xch := c.GetHeader("X-Amz-Content-Sha256")
	if xch == sigV4UnsignedPayload || xch == sigV4StreamingPayload {
		return nil, nil
	}
	// GET / HEAD / DELETE bodies are always empty in practice; skip the
	// drain to save the alloc.
	switch c.Request.Method {
	case http.MethodGet, http.MethodHead, http.MethodDelete:
		return nil, nil
	}
	return drainBody(c.Request, s3MaxBodyBytes)
}

// s3MethodNotAllowed records an audit row and emits the AWS error envelope.
// Centralized so every dispatcher path emits the same shape on a routing
// miss.
func (h *Handlers) s3MethodNotAllowed(c *gin.Context, ctx *s3Context, method string) {
	h.server.Integrations().RecordAudit(ctx.cred.ID, ctx.clientIP, method,
		c.Request.URL.Path, http.StatusMethodNotAllowed, "")
	writeS3Error(c, http.StatusMethodNotAllowed, S3ErrMethodNotAllowed,
		"the specified method is not allowed for this resource", c.Request.URL.Path)
}

// splitBucketKey splits the catch-all path from gin into (bucket, key).
//
// gin's `*path` returns the suffix WITH a leading slash (or "/" for the
// bare mount root). Examples:
//
//	"/"                          → ("", "")
//	"/health-apple-raw/"         → ("health-apple-raw", "")
//	"/health-apple-raw/foo.json" → ("health-apple-raw", "foo.json")
//	"/health-apple-raw/a/b/c"    → ("health-apple-raw", "a/b/c")
func splitBucketKey(rawPath string) (bucket, key string) {
	rawPath = strings.TrimPrefix(rawPath, "/")
	if rawPath == "" {
		return "", ""
	}
	if i := strings.IndexByte(rawPath, '/'); i >= 0 {
		return rawPath[:i], rawPath[i+1:]
	}
	return rawPath, ""
}

// s3ResolveKeyPath turns an S3 object key into an absolute filesystem path
// rooted under the credential's scope folder. Returns ("", false) if the
// key path-cleans outside the scope folder (a `..` escape attempt).
//
// This is the single chokepoint for "what file does this S3 op touch?".
// Every per-op handler calls this before reading or writing anything.
func (ctx *s3Context) s3ResolveKeyPath(userDataDir string) (string, bool) {
	// Reject keys with absolute leading slashes — S3 keys are always
	// relative under the bucket, and accepting an absolute key would
	// invite confusion about whether scopePath is honored.
	clean := filepath.Clean("/" + ctx.scopePath + "/" + ctx.key)
	scopeRoot := filepath.Clean("/" + ctx.scopePath)
	if clean != scopeRoot && !strings.HasPrefix(clean, scopeRoot+"/") {
		return "", false
	}
	abs := filepath.Join(userDataDir, strings.TrimPrefix(clean, "/"))
	return abs, true
}

// s3ResolveScopeRel returns the scope-relative path (e.g. "health/apple/raw/foo.json")
// for the current request's key. Used for the path argument to
// fs.Service.WriteFile, which expects paths rooted at the data root.
func (ctx *s3Context) s3ResolveScopeRel() (string, bool) {
	clean := filepath.Clean("/" + ctx.scopePath + "/" + ctx.key)
	scopeRoot := filepath.Clean("/" + ctx.scopePath)
	if clean != scopeRoot && !strings.HasPrefix(clean, scopeRoot+"/") {
		return "", false
	}
	return strings.TrimPrefix(clean, "/"), true
}
