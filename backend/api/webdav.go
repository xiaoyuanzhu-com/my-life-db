// Plain WebDAV file access for the backend's user data directory.
//
// Wire shape:
//
//	OPTIONS|GET|HEAD|PUT|DELETE|PROPFIND|PROPPATCH|MKCOL|COPY|MOVE|LOCK|UNLOCK
//	/webdav/*path
//
// Auth:
//   - The route is mounted under the standard AuthMiddleware, so behavior
//     tracks MLD_AUTH_MODE. In "none" mode every request is accepted; in
//     "password" mode the middleware accepts either an owner session cookie
//     (web UI) or HTTP Basic Auth (WebDAV clients like Finder, iOS Files,
//     rclone, Obsidian Remotely Save).
//   - No per-credential lookup, no scope checks. This is a legacy ingest
//     surface that uses the same trust model as the rest of the backend.
//
// Filesystem mapping:
//   - The handler serves files rooted at <USER_DATA_DIR>. A request to
//     `/webdav/notes/foo.md` reads/writes `<USER_DATA_DIR>/notes/foo.md`.
//   - The stdlib's `webdav.Dir` rejects `..` escapes for us.
//
// URL-prefix handling:
//   - gin's `*path` captures everything after `/webdav`. Before delegating
//     to `webdav.Handler`, we rewrite `c.Request.URL.Path` to that suffix
//     so the handler treats `/notes/foo.md` (not `/webdav/notes/foo.md`)
//     as the resource path. This keeps PROPFIND/MOVE/COPY targets correct.
//
// Locks:
//   - A single process-wide in-memory lock store (Server.WebDAVLocks).
//     Locks aren't durable across restarts — acceptable for personal-server
//     use, per design doc.
package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/webdav"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// webdavMaxBodyBytes caps a single request body. Generous (1 GB) so
// typical document/photo/video uploads from sync clients succeed; larger
// uploads should use the TUS surface.
const webdavMaxBodyBytes int64 = 1 << 30 // 1 GB

// WebDAVHandler is the gin entrypoint for /webdav/*path. Auth has already
// been enforced by AuthMiddleware; this handler just rewrites the path
// and delegates to a webdav.Handler rooted at USER_DATA_DIR.
func (h *Handlers) WebDAVHandler(c *gin.Context) {
	// Suffix is whatever follows /webdav in the request URL — gin's
	// catch-all `*path` returns it WITH the leading slash, e.g. a
	// request to `/webdav/notes/foo.md` yields `/notes/foo.md`. Falls
	// back to "/" so PROPFIND on the bare mount root (`/webdav`) still
	// hits the handler with a sensible path.
	suffix := c.Param("path")
	if suffix == "" {
		suffix = "/"
	}

	// Cap request body so a misconfigured client can't OOM us.
	if c.Request.Body != nil {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, webdavMaxBodyBytes)
	}

	// Build the filesystem rooted at USER_DATA_DIR. webdav.Dir refuses
	// `..` escapes for us, so this is the only access-control check
	// needed on the file path.
	fs := webdav.Dir(h.server.Cfg().UserDataDir)

	// Strip the /webdav prefix from the URL path before delegating, and
	// set Handler.Prefix to "" since we've already done the strip.
	originalPath := c.Request.URL.Path
	c.Request.URL.Path = suffix
	defer func() { c.Request.URL.Path = originalPath }()

	handler := &webdav.Handler{
		Prefix:     "",
		FileSystem: fs,
		LockSystem: h.server.WebDAVLocks(),
		Logger: func(req *http.Request, err error) {
			if err == nil {
				return
			}
			log.Debug().Err(err).
				Str("method", req.Method).Str("path", req.URL.Path).
				Msg("webdav: handler error")
		},
	}
	handler.ServeHTTP(c.Writer, c.Request)
}
