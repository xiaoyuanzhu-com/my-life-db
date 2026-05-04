// Multipart upload for the S3-compatible surface.
//
// Wire shape:
//
//	POST   /s3/<bucket>/<key>?uploads                 (CreateMultipartUpload)
//	PUT    /s3/<bucket>/<key>?partNumber=N&uploadId=U (UploadPart)
//	POST   /s3/<bucket>/<key>?uploadId=U              (CompleteMultipartUpload)
//	DELETE /s3/<bucket>/<key>?uploadId=U              (AbortMultipartUpload)
//
// On disk, parts stage at:
//
//	APP_DATA_DIR/.s3-multipart/<uploadId>/<part-number>.bin
//	APP_DATA_DIR/.s3-multipart/<uploadId>/manifest.json
//
// The manifest persists the (credential id, scope path, key) triple so a
// CompleteMultipartUpload from a fresh process can recover and write the
// final object to the right place. AbortMultipartUpload deletes the whole
// directory.
//
// Cleanup:
//   - AbortMultipartUpload removes the upload directory.
//   - CompleteMultipartUpload removes the upload directory after the
//     final write succeeds.
//   - There is NO background sweeper in Phase 3. Orphan upload
//     directories survive a server restart and have to be cleaned up
//     manually (`rm -rf APP_DATA_DIR/.s3-multipart/`). Phase 4 adds a
//     periodic sweeper (configurable TTL).
//
// Why on-disk staging instead of buffering in memory: typical multipart
// uploads (restic, large rclone copies) hit 5-100 GB total per upload,
// which would OOM even a beefy server. Per-part files keep memory bounded
// to whatever the SigV4 dispatcher buffers (s3MaxBodyBytes per request).
package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/utils"
)

// s3MultipartDir returns the staging directory for one upload.
func s3MultipartDir(appDataDir, uploadID string) string {
	return filepath.Join(appDataDir, ".s3-multipart", uploadID)
}

// s3MultipartManifest is the on-disk record of where a multipart upload
// is supposed to land. Persisted at manifest.json inside the upload's
// staging dir so a fresh process can complete the upload after a restart.
type s3MultipartManifest struct {
	UploadID     string    `json:"uploadId"`
	CredentialID string    `json:"credentialId"`
	ScopePath    string    `json:"scopePath"` // scope-relative folder, e.g. "health/apple/raw"
	Key          string    `json:"key"`       // object key, e.g. "2026/foo.json"
	MimeType     string    `json:"mimeType,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
}

// s3CreateMultipartUpload handles POST /s3/<bucket>/<key>?uploads.
// Mints an upload id, persists a manifest, and returns the
// InitiateMultipartUploadResult XML.
func (h *Handlers) s3CreateMultipartUpload(c *gin.Context, ctx *s3Context) {
	store := h.server.Integrations()

	if _, ok := ctx.s3ResolveScopeRel(); !ok {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusForbidden, "")
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"key escapes credential scope", c.Request.URL.Path)
		return
	}

	uploadID := uuid.NewString()
	dir := s3MultipartDir(h.server.Cfg().AppDataDir, uploadID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Error().Err(err).Str("dir", dir).Msg("s3: failed to create multipart staging dir")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to initialize multipart upload", c.Request.URL.Path)
		return
	}

	mimeType := strings.TrimSpace(c.GetHeader("Content-Type"))
	if i := strings.Index(mimeType, ";"); i >= 0 {
		mimeType = strings.TrimSpace(mimeType[:i])
	}

	manifest := s3MultipartManifest{
		UploadID:     uploadID,
		CredentialID: ctx.cred.ID,
		ScopePath:    ctx.scopePath,
		Key:          ctx.key,
		MimeType:     mimeType,
		CreatedAt:    time.Now().UTC(),
	}
	mf, err := os.Create(filepath.Join(dir, "manifest.json"))
	if err != nil {
		log.Error().Err(err).Str("dir", dir).Msg("s3: failed to create manifest")
		_ = os.RemoveAll(dir)
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to write manifest", c.Request.URL.Path)
		return
	}
	if err := json.NewEncoder(mf).Encode(&manifest); err != nil {
		_ = mf.Close()
		_ = os.RemoveAll(dir)
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to encode manifest", c.Request.URL.Path)
		return
	}
	_ = mf.Close()

	writeXML(c, http.StatusOK, &initiateMultipartUploadResult{
		Xmlns:    xmlNS,
		Bucket:   ctx.bucketName,
		Key:      ctx.key,
		UploadID: uploadID,
	})
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.write")
}

// s3UploadPart handles PUT /s3/<bucket>/<key>?partNumber=N&uploadId=U.
// Writes the part to disk under the upload's staging directory and
// returns the ETag of that part.
func (h *Handlers) s3UploadPart(c *gin.Context, ctx *s3Context, q url.Values) {
	store := h.server.Integrations()

	uploadID := q.Get("uploadId")
	partNumStr := q.Get("partNumber")
	partNum, err := strconv.Atoi(partNumStr)
	if err != nil || partNum < 1 || partNum > 10000 {
		writeS3Error(c, http.StatusBadRequest, S3ErrInvalidArgument,
			"partNumber must be an integer between 1 and 10000", c.Request.URL.Path)
		return
	}

	dir := s3MultipartDir(h.server.Cfg().AppDataDir, uploadID)
	manifest, err := s3ReadManifest(dir)
	if err != nil {
		writeS3Error(c, http.StatusNotFound, S3ErrNoSuchUpload,
			"the specified upload does not exist", c.Request.URL.Path)
		return
	}

	// Belt-and-suspenders: confirm the upload belongs to this credential.
	if manifest.CredentialID != ctx.cred.ID {
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"this upload does not belong to the calling credential", c.Request.URL.Path)
		return
	}

	partPath := filepath.Join(dir, fmt.Sprintf("%05d.bin", partNum))
	pf, err := os.Create(partPath)
	if err != nil {
		log.Error().Err(err).Str("path", partPath).Msg("s3: failed to create part file")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to stage part", c.Request.URL.Path)
		return
	}
	defer pf.Close()

	// Body source: drained bytes (SigV4-verified) or the raw stream
	// (UNSIGNED-PAYLOAD). Compute SHA-256 as we go so the part ETag is
	// real.
	hasher := sha256.New()
	var written int64
	if ctx.body != nil {
		hasher.Write(ctx.body)
		n, err := pf.Write(ctx.body)
		written = int64(n)
		if err != nil {
			writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
				"failed to write part", c.Request.URL.Path)
			return
		}
	} else {
		mw := io.MultiWriter(pf, hasher)
		n, err := io.Copy(mw, c.Request.Body)
		written = n
		if err != nil {
			writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
				"failed to write part", c.Request.URL.Path)
			return
		}
	}

	etag := hex.EncodeToString(hasher.Sum(nil))
	c.Header("ETag", `"`+etag+`"`)
	c.Status(http.StatusOK)

	log.Info().Str("credentialId", ctx.cred.ID).Str("uploadId", uploadID).
		Int("part", partNum).Int64("bytes", written).Msg("s3: part uploaded")
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.write")
}

// s3CompleteMultipartUpload handles POST /s3/<bucket>/<key>?uploadId=U.
// Reads the body's CompleteMultipartUpload XML, verifies the parts list
// matches what's on disk, concatenates the parts into the final object,
// then removes the staging directory.
//
// Concatenation streams part-files through fs.Service.WriteFile via a
// MultiReader so we never load the full object into memory.
func (h *Handlers) s3CompleteMultipartUpload(c *gin.Context, ctx *s3Context, q url.Values) {
	store := h.server.Integrations()

	uploadID := q.Get("uploadId")
	dir := s3MultipartDir(h.server.Cfg().AppDataDir, uploadID)
	manifest, err := s3ReadManifest(dir)
	if err != nil {
		writeS3Error(c, http.StatusNotFound, S3ErrNoSuchUpload,
			"the specified upload does not exist", c.Request.URL.Path)
		return
	}
	if manifest.CredentialID != ctx.cred.ID {
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"this upload does not belong to the calling credential", c.Request.URL.Path)
		return
	}

	// Body is XML — parse the CompleteMultipartUpload envelope. The
	// dispatcher already drained it for SigV4, so ctx.body is what we
	// want; fall back to req.Body for UNSIGNED-PAYLOAD.
	var bodyBytes []byte
	if ctx.body != nil {
		bodyBytes = ctx.body
	} else {
		bodyBytes, err = io.ReadAll(io.LimitReader(c.Request.Body, 1<<20))
		if err != nil {
			writeS3Error(c, http.StatusBadRequest, S3ErrInvalidRequest,
				"failed to read CompleteMultipartUpload body", c.Request.URL.Path)
			return
		}
	}

	var req completeMultipartUpload
	if err := xmlUnmarshalLenient(bodyBytes, &req); err != nil {
		writeS3Error(c, http.StatusBadRequest, S3ErrInvalidRequest,
			"failed to parse CompleteMultipartUpload body: "+err.Error(),
			c.Request.URL.Path)
		return
	}
	if len(req.Parts) == 0 {
		writeS3Error(c, http.StatusBadRequest, S3ErrInvalidRequest,
			"CompleteMultipartUpload body must list at least one part",
			c.Request.URL.Path)
		return
	}

	// AWS requires parts to be in ascending PartNumber order.
	for i := 1; i < len(req.Parts); i++ {
		if req.Parts[i].PartNumber <= req.Parts[i-1].PartNumber {
			writeS3Error(c, http.StatusBadRequest, S3ErrInvalidPartOrder,
				"parts must be listed in ascending PartNumber order",
				c.Request.URL.Path)
			return
		}
	}

	// Open every part file in order; bail if any are missing.
	var (
		readers []io.Reader
		closers []io.Closer
	)
	defer func() {
		for _, cl := range closers {
			_ = cl.Close()
		}
	}()
	for _, p := range req.Parts {
		path := filepath.Join(dir, fmt.Sprintf("%05d.bin", p.PartNumber))
		f, err := os.Open(path)
		if err != nil {
			writeS3Error(c, http.StatusBadRequest, S3ErrInvalidPart,
				fmt.Sprintf("part %d not found", p.PartNumber), c.Request.URL.Path)
			return
		}
		readers = append(readers, f)
		closers = append(closers, f)
	}

	// Stream the concatenated parts into the destination. Resolve the
	// scope-relative path from the manifest, not from the request — the
	// manifest is the source of truth for where this upload was supposed
	// to land.
	relPath := strings.TrimPrefix(filepath.ToSlash(filepath.Join(manifest.ScopePath, manifest.Key)), "/")
	mimeType := manifest.MimeType
	if mimeType == "" {
		mimeType = utils.DetectMimeType(relPath)
	}

	ctxReq, cancel := s3WriteContext(c)
	defer cancel()

	_, err = h.server.FS().WriteFile(ctxReq, fs.WriteRequest{
		Path:            relPath,
		Content:         io.MultiReader(readers...),
		MimeType:        mimeType,
		Source:          "s3-multipart",
		ComputeMetadata: true,
		Sync:            true,
	})
	if err != nil {
		log.Error().Err(err).Str("credentialId", ctx.cred.ID).Str("path", relPath).
			Msg("s3: CompleteMultipartUpload write failed")
		writeS3Error(c, http.StatusInternalServerError, S3ErrInternalError,
			"failed to write final object", c.Request.URL.Path)
		return
	}

	// Best-effort cleanup of the staging dir. Failure here means a
	// leftover folder; we log and continue (the manual cleanup hint in
	// the package doc still applies).
	if err := os.RemoveAll(dir); err != nil {
		log.Warn().Err(err).Str("dir", dir).Msg("s3: failed to clean up multipart staging dir")
	}

	// ETag for the final object: hex SHA-256 of all part ETags
	// concatenated, then "-N" — same scheme AWS uses.
	hasher := sha256.New()
	for _, p := range req.Parts {
		// Strip surrounding quotes the client likely sent.
		hasher.Write([]byte(strings.Trim(p.ETag, `"`)))
	}
	etag := hex.EncodeToString(hasher.Sum(nil)) + "-" + strconv.Itoa(len(req.Parts))

	writeXML(c, http.StatusOK, &completeMultipartUploadResult{
		Xmlns:    xmlNS,
		Location: "/s3/" + ctx.bucketName + "/" + url.PathEscape(manifest.Key),
		Bucket:   ctx.bucketName,
		Key:      manifest.Key,
		ETag:     `"` + etag + `"`,
	})
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.write")
}

// s3AbortMultipartUpload handles DELETE /s3/<bucket>/<key>?uploadId=U.
// Deletes the staging directory; absence is success (idempotent).
func (h *Handlers) s3AbortMultipartUpload(c *gin.Context, ctx *s3Context, q url.Values) {
	store := h.server.Integrations()

	uploadID := q.Get("uploadId")
	dir := s3MultipartDir(h.server.Cfg().AppDataDir, uploadID)

	// Confirm the manifest belongs to this credential before nuking; if
	// the manifest doesn't exist, treat as success (already cleaned up).
	if manifest, err := s3ReadManifest(dir); err == nil {
		if manifest.CredentialID != ctx.cred.ID {
			writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
				"this upload does not belong to the calling credential",
				c.Request.URL.Path)
			return
		}
	}

	if err := os.RemoveAll(dir); err != nil {
		log.Warn().Err(err).Str("dir", dir).Msg("s3: failed to remove multipart staging dir")
	}
	c.Status(http.StatusNoContent)
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusNoContent, "files.write")
}

// s3ReadManifest reads + decodes the manifest.json sitting at the root of
// an upload's staging directory.
func s3ReadManifest(dir string) (*s3MultipartManifest, error) {
	f, err := os.Open(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var m s3MultipartManifest
	if err := json.NewDecoder(f).Decode(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

// xmlUnmarshalLenient trims surrounding whitespace and decodes via
// encoding/xml. Wrapper exists so the call site stays one line and we
// can swap in a more permissive parser later if some client sends a
// wonky body shape.
func xmlUnmarshalLenient(body []byte, dst any) error {
	body = []byte(strings.TrimSpace(string(body)))
	return xml.Unmarshal(body, dst)
}

// _ keeps gin in the import list; the dispatcher injects the gin context
// into every handler signature here.
var _ = gin.H{}
