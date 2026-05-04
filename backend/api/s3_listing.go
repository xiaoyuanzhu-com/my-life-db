// Bucket-level handlers for the S3-compatible surface: ListBuckets,
// ListObjectsV2, HeadBucket, CreateBucket.
//
// In our model the credential is pinned to a single scope folder and
// "the bucket" is decorative — but clients still call ListBuckets
// (rclone needs it to populate its connection picker, restic checks it
// at startup), so we always return exactly one bucket whose name matches
// what the dispatcher computed.
//
// ListObjectsV2 walks the credential's scope folder. We support:
//   - prefix       (filters Contents to keys starting with the prefix)
//   - delimiter    (typically "/" — collapses sub-paths into CommonPrefixes)
//   - max-keys     (capped at 1000 per AWS)
//   - continuation-token / start-after (opaque cursor pagination)
//
// We do NOT support encoding-type=url; clients that ask for it get the
// same XML they would get without it (raw keys, not URL-encoded). rclone
// and restic both work fine with this; if a future client breaks we can
// add the encoding.
package api

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// s3MaxListKeys is AWS's documented cap on max-keys for ListObjectsV2.
// Clients can request fewer; requesting more gets clamped silently.
const s3MaxListKeys = 1000

// s3DefaultListKeys is what we emit when the client doesn't set max-keys.
// AWS's default is also 1000 but most clients pick smaller values; we use
// 1000 to match AWS so behavior is consistent.
const s3DefaultListKeys = 1000

// s3ListBuckets handles GET /s3/. Always returns exactly one bucket
// whose name is bucketNameForScope(credential.scope.path). The
// CreationDate is the credential's CreatedAt — there's no separate
// "bucket created" event in our model.
func (h *Handlers) s3ListBuckets(c *gin.Context, ctx *s3Context) {
	store := h.server.Integrations()
	body := &listAllMyBucketsResult{
		Xmlns: xmlNS,
		Owner: s3Owner{
			ID:          ctx.cred.ID,
			DisplayName: ctx.cred.Name,
		},
		Buckets: s3BucketList{
			Bucket: []s3Bucket{
				{
					Name:         ctx.bucketName,
					CreationDate: ctx.cred.CreatedAt.UTC().Format(time.RFC3339Nano),
				},
			},
		},
	}
	writeXML(c, http.StatusOK, body)
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.read")
}

// s3HeadBucket handles HEAD /s3/<bucket>/. Returns 200 if the bucket name
// matches the credential's bucket; 404 otherwise. AWS clients use this
// to verify the bucket exists before issuing PUT/GET.
func (h *Handlers) s3HeadBucket(c *gin.Context, ctx *s3Context) {
	store := h.server.Integrations()
	requested, _ := splitBucketKey(c.Param("path"))
	if requested != ctx.bucketName {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusNotFound, "")
		c.Header("Content-Type", xmlContentType)
		c.Status(http.StatusNotFound)
		return
	}
	c.Status(http.StatusOK)
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.read")
}

// s3CreateBucket handles PUT /s3/<bucket>/. Returns 200 (success) if the
// requested bucket name matches the credential's bucket — bucket already
// exists by virtue of the credential — and rejects all other names with
// AccessDenied. Some clients (rclone in --s3-bucket-acl modes, restic
// init) call CreateBucket on startup; matching the credential's name
// makes those flows succeed without us actually creating anything.
func (h *Handlers) s3CreateBucket(c *gin.Context, ctx *s3Context, requested string) {
	store := h.server.Integrations()
	if requested != ctx.bucketName {
		store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
			c.Request.URL.Path, http.StatusForbidden, "")
		writeS3Error(c, http.StatusForbidden, S3ErrAccessDenied,
			"this credential cannot create the requested bucket; only "+ctx.bucketName+" is accessible",
			c.Request.URL.Path)
		return
	}
	c.Header("Location", "/s3/"+ctx.bucketName+"/")
	c.Status(http.StatusOK)
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.write")
}

// s3ListObjectsV2 handles GET /s3/<bucket>/?list-type=2 (and bare
// GET /s3/<bucket>/, which we treat the same — most modern SDKs send V2
// without explicitly setting list-type, and the response shape works for
// both V1 and V2 clients).
//
// Walks the credential's scope folder via filepath.Walk, applies prefix /
// delimiter filtering, then truncates to max-keys with an opaque cursor.
// The cursor is just the last emitted key, base64-url encoded.
func (h *Handlers) s3ListObjectsV2(c *gin.Context, ctx *s3Context, q url.Values) {
	store := h.server.Integrations()

	prefix := q.Get("prefix")
	delimiter := q.Get("delimiter")
	startAfter := q.Get("start-after")
	contToken := q.Get("continuation-token")

	maxKeys := s3DefaultListKeys
	if mk := q.Get("max-keys"); mk != "" {
		if n, err := strconv.Atoi(mk); err == nil && n > 0 {
			if n > s3MaxListKeys {
				n = s3MaxListKeys
			}
			maxKeys = n
		}
	}

	// Resolve the absolute path of the credential's scope folder.
	scopeRoot := filepath.Join(h.server.Cfg().UserDataDir, ctx.scopePath)

	// Decode the continuation token. The token is base64-url(lastKey);
	// invalid tokens are tolerated (we treat them as no-cursor) so a
	// client can't break the listing by sending garbage.
	resumeAfter := ""
	if contToken != "" {
		if dec, err := base64.URLEncoding.DecodeString(contToken); err == nil {
			resumeAfter = string(dec)
		}
	}
	if resumeAfter == "" && startAfter != "" {
		resumeAfter = startAfter
	}

	// Walk the scope folder, accumulate matching keys + common prefixes.
	var (
		contents       []s3ObjectEntry
		commonPrefixes = map[string]struct{}{}
		truncated      bool
		nextCursor     string
	)

	keys := s3WalkKeys(scopeRoot)
	sort.Strings(keys)

	for _, k := range keys {
		// Apply prefix filter.
		if prefix != "" && !strings.HasPrefix(k, prefix) {
			continue
		}
		// Apply continuation cursor.
		if resumeAfter != "" && k <= resumeAfter {
			continue
		}
		// Apply delimiter folding. If the suffix-after-prefix contains
		// the delimiter, the key collapses into a CommonPrefix entry
		// and the underlying object is suppressed.
		if delimiter != "" {
			rest := strings.TrimPrefix(k, prefix)
			if i := strings.Index(rest, delimiter); i >= 0 {
				cp := prefix + rest[:i+len(delimiter)]
				commonPrefixes[cp] = struct{}{}
				continue
			}
		}

		if len(contents) >= maxKeys {
			truncated = true
			nextCursor = base64.URLEncoding.EncodeToString([]byte(contents[len(contents)-1].Key))
			break
		}

		// Stat the file for size + mtime. Skip on stat failure (file
		// disappeared between walk and stat — race with a concurrent
		// delete; just omit it).
		abs := filepath.Join(scopeRoot, k)
		info, err := os.Stat(abs)
		if err != nil {
			continue
		}
		contents = append(contents, s3ObjectEntry{
			Key:          k,
			LastModified: info.ModTime().UTC().Format(time.RFC3339Nano),
			ETag:         `"` + s3FileETag(abs, info) + `"`,
			Size:         info.Size(),
			StorageClass: "STANDARD",
		})
	}

	// Materialize CommonPrefixes (sorted) for stable output.
	cpList := make([]s3CommonPrefix, 0, len(commonPrefixes))
	for p := range commonPrefixes {
		cpList = append(cpList, s3CommonPrefix{Prefix: p})
	}
	sort.Slice(cpList, func(i, j int) bool { return cpList[i].Prefix < cpList[j].Prefix })

	body := &listBucketResultV2{
		Xmlns:                 xmlNS,
		Name:                  ctx.bucketName,
		Prefix:                prefix,
		Delimiter:             delimiter,
		KeyCount:              len(contents) + len(cpList),
		MaxKeys:               maxKeys,
		IsTruncated:           truncated,
		ContinuationToken:     contToken,
		NextContinuationToken: nextCursor,
		StartAfter:            startAfter,
		Contents:              contents,
		CommonPrefixes:        cpList,
	}

	writeXML(c, http.StatusOK, body)
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.read")
}

// s3ListMultipartUploads handles GET /s3/<bucket>/?uploads. Returns an
// empty list — we don't expose in-flight multipart uploads to the
// listing endpoint (clients track their own upload ids). Some tools
// call this on startup; we emit a valid (empty) response so they don't
// trip over a 501.
func (h *Handlers) s3ListMultipartUploads(c *gin.Context, ctx *s3Context) {
	store := h.server.Integrations()
	body := &listMultipartUploadsResult{
		Xmlns:       xmlNS,
		Bucket:      ctx.bucketName,
		MaxUploads:  s3DefaultListKeys,
		IsTruncated: false,
	}
	writeXML(c, http.StatusOK, body)
	store.RecordAudit(ctx.cred.ID, ctx.clientIP, c.Request.Method,
		c.Request.URL.Path, http.StatusOK, "files.read")
}

// s3WalkKeys walks `root` and returns the relative key for every regular
// file underneath it. Folders are not emitted (S3 has no directories).
// Walk errors on individual entries are skipped; a fully-broken root
// returns an empty slice (the empty listing is a valid S3 response).
func s3WalkKeys(root string) []string {
	var keys []string
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		// Normalize separators for cross-platform consistency. S3 keys
		// use forward slashes regardless of host OS.
		rel = filepath.ToSlash(rel)
		keys = append(keys, rel)
		return nil
	})
	return keys
}

// _ keeps gin in the import list when this file is read in isolation.
var _ = gin.H{}
