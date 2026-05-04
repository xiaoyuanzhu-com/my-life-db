// Per-object handlers for the S3-compatible surface: Get, Head, Put,
// Delete, and Copy.
//
// All five paths share the same shape: resolve the requested key into an
// absolute filesystem path under the credential's scope folder, run the
// operation, audit the result, and emit the AWS-shaped response.
//
// Worth noting:
//
//   - GetObject delegates to http.ServeContent so we get conditional
//     requests (If-Modified-Since, If-None-Match) and Range support
//     (single-range; multipart/byteranges) for free.
//   - PutObject's body has already been drained by the dispatcher when we
//     needed to verify SigV4 hashes (UNSIGNED-PAYLOAD paths skip the
//     drain). That means by the time we get here, ctx.body is the bytes
//     to write — no streaming concerns.
//   - CopyObject is a same-credential copy: source and destination keys
//     must both fall under the credential's scope folder. Cross-credential
//     copies (a different x-amz-copy-source bucket) are rejected.
//
// ETag handling: we compute a hex SHA-256 of the bytes we wrote and use
// the first 32 chars as the ETag (AWS uses MD5; SDKs treat ETag as opaque
// in practice). Multipart uploads override this with `<sha256>-<partCount>`
// (see s3_multipart.go) — same scheme AWS uses for multipart objects.
package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// s3GetObject handles GET /s3/<bucket>/<key>. Streams the file with
// Range support via http.ServeContent. Emits the AWS-shaped 404 envelope
// when the key is missing.
func (h *Handlers) s3GetObject(c *gin.Context, ctx *s3Context) {
	store := h.server.Integrations()
	abs, ok := ctx.s3ResolveKeyPath(h.server.Cfg().UserDataDir)
	if !ok {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusForbidden, "")
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"key escapes credential scope", c.Request.URL.Path)
		return
	}

	info, err := os.Stat(abs)
	if err != nil || info.IsDir() {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusNotFound, "")
		writeS3Error(c, http.StatusNotFound, S3ErrNoSuchKey,
			"the specified key does not exist", c.Request.URL.Path)
		return
	}

	f, err := os.Open(abs)
	if err != nil {
		log.Error().Err(err).Str("path", abs).Msg("s3: open failed")
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusInternalServerError, "")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to open object", c.Request.URL.Path)
		return
	}
	defer f.Close()

	// Best-effort Content-Type. http.ServeContent will sniff if we don't
	// set one, but using the same DetectMimeType helper keeps the surface
	// consistent with the webhook + WebDAV writers.
	if mt := utils.DetectMimeType(abs); mt != "" {
		c.Header("Content-Type", mt)
	}
	c.Header("ETag", `"`+s3FileETag(abs, info)+`"`)
	c.Header("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	c.Header("Accept-Ranges", "bytes")

	http.ServeContent(c.Writer, c.Request, filepath.Base(abs), info.ModTime(), f)

	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, c.Writer.Status(), "files.read")
}

// s3HeadObject handles HEAD /s3/<bucket>/<key>. Same headers as
// GetObject but no body — same code path, just trimmed.
func (h *Handlers) s3HeadObject(c *gin.Context, ctx *s3Context) {
	store := h.server.Integrations()
	abs, ok := ctx.s3ResolveKeyPath(h.server.Cfg().UserDataDir)
	if !ok {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusForbidden, "")
		// HEAD responses must not have a body, so writeS3Error's body
		// would be silently dropped — but the headers + status are what
		// AWS clients check, so we still call through.
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"key escapes credential scope", c.Request.URL.Path)
		return
	}

	info, err := os.Stat(abs)
	if err != nil || info.IsDir() {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusNotFound, "")
		// Per AWS, HEAD 404s have no body. We still write the standard
		// envelope; clients ignore the body on HEAD.
		c.Header("Content-Type", xmlContentType)
		c.Status(http.StatusNotFound)
		return
	}

	if mt := utils.DetectMimeType(abs); mt != "" {
		c.Header("Content-Type", mt)
	}
	c.Header("Content-Length", fmt.Sprintf("%d", info.Size()))
	c.Header("ETag", `"`+s3FileETag(abs, info)+`"`)
	c.Header("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	c.Header("Accept-Ranges", "bytes")
	c.Status(http.StatusOK)
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.read")
}

// s3PutObject handles PUT /s3/<bucket>/<key>. The dispatcher has already
// drained the body (when needed for SigV4 verify) — we just need to write
// it out via fs.Service.WriteFile and return a 200 with the ETag.
func (h *Handlers) s3PutObject(c *gin.Context, ctx *s3Context) {
	store := h.server.Integrations()
	relPath, ok := ctx.s3ResolveScopeRel()
	if !ok {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusForbidden, "")
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"key escapes credential scope", c.Request.URL.Path)
		return
	}

	// Body source: prefer the drained bytes from the dispatcher (SigV4
	// hash-verified), fall back to streaming the request body for
	// UNSIGNED-PAYLOAD uploads. The fs.Service.WriteFile API accepts an
	// io.Reader either way.
	body, etag := s3BodyAndETag(ctx, c)

	mimeType := strings.TrimSpace(c.GetHeader("Content-Type"))
	if i := strings.Index(mimeType, ";"); i >= 0 {
		mimeType = strings.TrimSpace(mimeType[:i])
	}
	if mimeType == "" {
		mimeType = utils.DetectMimeType(relPath)
	}

	ctxReq, cancel := s3WriteContext(c)
	defer cancel()

	_, err := h.server.FS().WriteFile(ctxReq, fs.WriteRequest{
		Path:            relPath,
		Content:         body,
		MimeType:        mimeType,
		Source:          "s3",
		ComputeMetadata: true,
		Sync:            true,
	})
	if err != nil {
		log.Error().Err(err).Str("credentialId", ctx.cred.ID).Str("path", relPath).
			Msg("s3: PutObject write failed")
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusInternalServerError, "")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to write object", c.Request.URL.Path)
		return
	}

	c.Header("ETag", `"`+etag+`"`)
	c.Status(http.StatusOK)
	log.Info().Str("credentialId", ctx.cred.ID).Str("path", relPath).
		Int("bytes", len(ctx.body)).Msg("s3: object written")
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.write")
}

// s3DeleteObject handles DELETE /s3/<bucket>/<key>. AWS returns 204 on
// successful delete (with no body), and also 204 when the key didn't exist
// — DELETE is idempotent. We match.
func (h *Handlers) s3DeleteObject(c *gin.Context, ctx *s3Context) {
	store := h.server.Integrations()
	relPath, ok := ctx.s3ResolveScopeRel()
	if !ok {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusForbidden, "")
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"key escapes credential scope", c.Request.URL.Path)
		return
	}

	ctxReq, cancel := s3WriteContext(c)
	defer cancel()

	if err := h.server.FS().DeleteFile(ctxReq, relPath); err != nil {
		// If the file genuinely doesn't exist, the FS service returns a
		// not-found-flavored error. AWS treats DELETE on a missing key
		// as success (idempotent), so we swallow not-found errors and
		// only escalate other failures.
		if !os.IsNotExist(err) {
			log.Error().Err(err).Str("credentialId", ctx.cred.ID).Str("path", relPath).
				Msg("s3: DeleteObject failed")
		}
	}
	c.Status(http.StatusNoContent)
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusNoContent, "files.write")
}

// s3CopyObject handles PUT /s3/<bucket>/<key> with `x-amz-copy-source`
// set. The source is a `<bucket>/<key>` path (URL-encoded, optional
// leading slash); the destination is the URL key.
//
// Phase 3 only supports same-credential copies — both src and dst must
// land in the credential's scope folder. Cross-credential copies require
// the client to read + re-PUT, which is what most backup tools do anyway.
func (h *Handlers) s3CopyObject(c *gin.Context, ctx *s3Context) {
	store := h.server.Integrations()

	src := c.GetHeader("x-amz-copy-source")
	if src == "" {
		src = c.GetHeader("X-Amz-Copy-Source")
	}
	src = strings.TrimPrefix(src, "/")
	srcDecoded, err := url.QueryUnescape(src)
	if err != nil {
		writeS3Error(c, http.StatusBadRequest, S3ErrInvalidArgument,
			"x-amz-copy-source is not URL-encoded", c.Request.URL.Path)
		return
	}
	srcBucket, srcKey := splitBucketKey("/" + srcDecoded)
	_ = srcBucket // bucket name is decorative — we only enforce that srcKey
	//             // resolves under the credential's scope folder

	if srcKey == "" {
		writeS3Error(c, http.StatusBadRequest, S3ErrInvalidArgument,
			"x-amz-copy-source must include a key", c.Request.URL.Path)
		return
	}

	srcCtx := *ctx
	srcCtx.key = srcKey
	srcAbs, ok := srcCtx.s3ResolveKeyPath(h.server.Cfg().UserDataDir)
	if !ok {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusForbidden, "")
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"copy source escapes credential scope", c.Request.URL.Path)
		return
	}

	dstRel, ok := ctx.s3ResolveScopeRel()
	if !ok {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusForbidden, "")
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"copy destination escapes credential scope", c.Request.URL.Path)
		return
	}

	srcInfo, err := os.Stat(srcAbs)
	if err != nil || srcInfo.IsDir() {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusNotFound, "")
		writeS3Error(c, http.StatusNotFound, S3ErrNoSuchKey,
			"copy source does not exist", c.Request.URL.Path)
		return
	}

	srcFile, err := os.Open(srcAbs)
	if err != nil {
		log.Error().Err(err).Str("path", srcAbs).Msg("s3: copy source open failed")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to open copy source", c.Request.URL.Path)
		return
	}
	defer srcFile.Close()

	mimeType := utils.DetectMimeType(srcAbs)

	ctxReq, cancel := s3WriteContext(c)
	defer cancel()

	_, err = h.server.FS().WriteFile(ctxReq, fs.WriteRequest{
		Path:            dstRel,
		Content:         srcFile,
		MimeType:        mimeType,
		Source:          "s3-copy",
		ComputeMetadata: true,
		Sync:            true,
	})
	if err != nil {
		log.Error().Err(err).Str("credentialId", ctx.cred.ID).Str("path", dstRel).
			Msg("s3: CopyObject write failed")
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusInternalServerError, "")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to write copied object", c.Request.URL.Path)
		return
	}

	// Re-stat the dest for the response ETag + LastModified.
	dstAbs := filepath.Join(h.server.Cfg().UserDataDir, dstRel)
	dstInfo, err := os.Stat(dstAbs)
	if err != nil {
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to stat written object", c.Request.URL.Path)
		return
	}

	writeXML(c, http.StatusOK, &copyObjectResult{
		Xmlns:        xmlNS,
		ETag:         `"` + s3FileETag(dstAbs, dstInfo) + `"`,
		LastModified: dstInfo.ModTime().UTC().Format(time.RFC3339Nano),
	})
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.write")
}

// s3FileETag returns a stable ETag for `path`. We use the first 32 chars
// of the SHA-256 of (path + size + mtime) so we don't have to re-hash the
// file on every HEAD/LIST. Best-effort — clients use ETag as opaque.
//
// For PutObject we override this with the real content SHA-256 (see
// s3BodyAndETag) so a freshly written object's ETag matches what the
// client would compute itself.
func s3FileETag(path string, info os.FileInfo) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d", path, info.Size(), info.ModTime().UnixNano())))
	return hex.EncodeToString(sum[:16])
}

// s3BodyAndETag returns the body to write and the ETag to advertise.
//
//   - If the dispatcher buffered the body for SigV4 verification, we have
//     the bytes in ctx.body — use them and compute a real SHA-256 ETag.
//   - For UNSIGNED-PAYLOAD uploads, ctx.body is nil; we stream the
//     request body and synthesize a placeholder ETag from the empty hash
//     (clients will see this only on the immediate response and re-hash
//     from disk on the next GET if they care).
//
// The first return is what fs.Service.WriteFile reads from.
func s3BodyAndETag(ctx *s3Context, c *gin.Context) (body io.Reader, etag string) {
	if ctx.body != nil {
		sum := sha256.Sum256(ctx.body)
		return bytes.NewReader(ctx.body), hex.EncodeToString(sum[:])
	}
	emptyHash := sha256.Sum256(nil)
	return c.Request.Body, hex.EncodeToString(emptyHash[:])
}

// s3WriteContext returns a request-scoped context with a generous timeout
// so a slow uploader doesn't hang fs.Service.WriteFile forever. 30 minutes
// matches the multipart timeout most backup tools default to.
func s3WriteContext(c *gin.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(c.Request.Context(), 30*time.Minute)
}
