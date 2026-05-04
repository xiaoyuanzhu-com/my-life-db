// Startup garbage collection for stale S3 multipart staging directories.
//
// Why on startup (not as a recurring janitor): multipart uploads only
// pile up in three scenarios — (1) a client started an upload and
// crashed before completing or aborting, (2) the server was killed
// mid-upload, (3) a client deliberately abandoned the upload. All three
// are rare on a personal-server install. A one-shot sweep at boot is
// enough to keep the staging directory bounded over time and avoids
// adding another always-on goroutine.
//
// The check is "manifest.json mtime older than maxAge" — manifest.json
// is written once at CreateMultipartUpload and never touched again, so
// its mtime is a precise stand-in for "this upload was abandoned this
// long ago". For uploads that never even reached the manifest write
// (truly broken clients), the directory itself has an old mtime; we
// fall back to the directory mtime when the manifest is missing.
//
// Lives in the server package (not api) so server.New can call it
// directly without inverting the import direction. Mirrors the layout
// of agent_attachments_janitor.go.
package server

import (
	"os"
	"path/filepath"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// multipartStagingDirName mirrors the literal used by api/s3_multipart.go
// for the staging root. Kept in sync by hand — there's no shared
// constant because s3_multipart.go composes the path with filepath.Join
// rather than via a named const.
const multipartStagingDirName = ".s3-multipart"

// multipartStagingMaxAge is the default cutoff for stale upload dirs.
// One week is generous: AWS itself rejects parts older than the
// CreateMultipartUpload's lifecycle window (typically 7 days), and most
// clients abort or complete within minutes of starting.
const multipartStagingMaxAge = 7 * 24 * time.Hour

// GarbageCollectMultipartStaging walks <appDataDir>/.s3-multipart/ and
// removes any subdirectory whose manifest.json (or, missing that, the
// directory itself) is older than maxAge.
//
// Returns the number of staging dirs removed and any non-nil error from
// the directory walk. Per-upload removal failures are logged but do not
// abort the sweep — one bad row should not prevent cleaning the rest.
//
// Safe to call on a system where the staging root doesn't exist yet
// (returns 0, nil).
func GarbageCollectMultipartStaging(appDataDir string, maxAge time.Duration) (int, error) {
	stagingRoot := filepath.Join(appDataDir, multipartStagingDirName)
	entries, err := os.ReadDir(stagingRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	cutoff := time.Now().Add(-maxAge)

	cleaned := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(stagingRoot, e.Name())
		ts, ok := stagingMtime(dir)
		if !ok {
			// Couldn't stat anything in this dir — leave it alone
			// rather than risk deleting something we can't reason
			// about. The next sweep will see it again.
			continue
		}
		if ts.After(cutoff) {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			log.Warn().Err(err).Str("dir", dir).
				Msg("multipart-gc: failed to remove stale staging dir")
			continue
		}
		cleaned++
	}

	if cleaned > 0 {
		log.Info().Int("count", cleaned).
			Msgf("GC'd %d stale multipart staging dirs", cleaned)
	}
	return cleaned, nil
}

// stagingMtime returns the time we should compare against `cutoff` for
// one staging directory. Prefer manifest.json's mtime (precise — it's
// written once and never updated); fall back to the directory's own
// mtime when the manifest doesn't exist (broken half-init).
func stagingMtime(dir string) (time.Time, bool) {
	if info, err := os.Stat(filepath.Join(dir, "manifest.json")); err == nil {
		return info.ModTime(), true
	}
	if info, err := os.Stat(dir); err == nil {
		return info.ModTime(), true
	}
	return time.Time{}, false
}
