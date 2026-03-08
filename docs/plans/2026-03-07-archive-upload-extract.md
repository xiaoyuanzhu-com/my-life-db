# Archive Upload & Extract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a user uploads an archive file (zip, tar.gz, 7z, rar, etc.), the server automatically extracts its contents into the destination folder instead of saving the archive.

**Architecture:** Add archive detection and extraction to the existing upload finalization flow. A new `archive.go` file in `backend/api/` uses `mholt/archives` to identify and extract archives. The existing `FinalizeUpload` and `SimpleUpload` handlers call the new extraction logic when they detect an archive file. Each extracted file goes through `fs.WriteFile()` for metadata, DB registration, and digest processing.

**Tech Stack:** Go, `github.com/mholt/archives` (unified archive library), existing `fs.WriteFile()` pipeline

---

### Task 1: Add `mholt/archives` dependency

**Files:**
- Modify: `backend/go.mod`

**Step 1: Add the dependency**

Run (from the worktree's `backend/` directory):
```bash
cd backend && go get github.com/mholt/archives
```

**Step 2: Verify it installed**

Run:
```bash
grep mholt backend/go.mod
```
Expected: A line like `github.com/mholt/archives v0.x.x`

**Step 3: Commit**

```bash
git add backend/go.mod backend/go.sum
git commit -m "deps: add mholt/archives for archive extraction support"
```

---

### Task 2: Create `archive.go` with detection and extraction logic

**Files:**
- Create: `backend/api/archive.go`
- Create: `backend/api/archive_test.go`

**Step 1: Write the test file**

```go
// backend/api/archive_test.go
package api

import (
	"testing"
)

func TestIsArchiveFile(t *testing.T) {
	tests := []struct {
		filename string
		want     bool
	}{
		// Supported archive formats
		{"photos.zip", true},
		{"backup.tar", true},
		{"backup.tar.gz", true},
		{"backup.tgz", true},
		{"backup.tar.bz2", true},
		{"backup.tbz2", true},
		{"backup.tar.xz", true},
		{"backup.txz", true},
		{"backup.tar.zst", true},
		{"backup.7z", true},
		{"backup.rar", true},

		// Case insensitive
		{"Photos.ZIP", true},
		{"Backup.TAR.GZ", true},
		{"archive.Rar", true},

		// Not archives
		{"photo.jpg", false},
		{"document.pdf", false},
		{"notes.md", false},
		{"data.json", false},
		{"video.mp4", false},
		{"", false},

		// Tricky filenames
		{"my.zip.bak", false},
		{"zipfile.txt", false},
		{"archive.tar.gz.old", false},
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			got := isArchiveFile(tt.filename)
			if got != tt.want {
				t.Errorf("isArchiveFile(%q) = %v, want %v", tt.filename, got, tt.want)
			}
		})
	}
}

func TestIsJunkArchiveEntry(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		// Junk entries
		{"__MACOSX/file.txt", true},
		{"__MACOSX/._photo.jpg", true},
		{".DS_Store", true},
		{"subdir/.DS_Store", true},
		{"Thumbs.db", true},
		{"subdir/Thumbs.db", true},

		// Valid entries
		{"readme.md", false},
		{"src/main.go", false},
		{"photos/vacation/IMG_001.jpg", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := isJunkArchiveEntry(tt.path)
			if got != tt.want {
				t.Errorf("isJunkArchiveEntry(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestIsSafeArchivePath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		// Safe paths
		{"readme.md", true},
		{"src/main.go", true},
		{"photos/vacation/IMG_001.jpg", true},

		// Unsafe paths (zip-slip)
		{"../etc/passwd", false},
		{"foo/../../etc/passwd", false},
		{"/etc/passwd", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := isSafeArchivePath(tt.path)
			if got != tt.want {
				t.Errorf("isSafeArchivePath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}
```

**Step 2: Run tests to verify they fail**

Run:
```bash
cd backend && go test -v ./api/ -run "TestIsArchiveFile|TestIsJunkArchiveEntry|TestIsSafeArchivePath"
```
Expected: FAIL — functions not defined

**Step 3: Write `archive.go`**

```go
// backend/api/archive.go
package api

import (
	"bytes"
	"context"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/mholt/archives"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// archiveExtensions lists all supported archive file extensions (lowercase).
var archiveExtensions = map[string]bool{
	".zip":     true,
	".tar":     true,
	".tar.gz":  true,
	".tgz":     true,
	".tar.bz2": true,
	".tbz2":    true,
	".tar.xz":  true,
	".txz":     true,
	".tar.zst": true,
	".7z":      true,
	".rar":     true,
}

// isArchiveFile checks if a filename has a supported archive extension.
func isArchiveFile(filename string) bool {
	lower := strings.ToLower(filename)

	// Check compound extensions first (e.g., .tar.gz before .gz)
	for ext := range archiveExtensions {
		if strings.HasSuffix(lower, ext) {
			// Make sure it's a real extension, not part of the base name.
			// e.g., "my.zip.bak" should NOT match ".zip"
			prefix := lower[:len(lower)-len(ext)]
			if prefix == "" || prefix[len(prefix)-1] == '/' || prefix[len(prefix)-1] == '.' {
				return true
			}
			// For compound extensions like .tar.gz, the char before must end the basename
			// For simple extensions like .zip, the prefix just needs to be non-empty
			if !strings.Contains(ext, ".tar.") && ext[0] == '.' {
				return true
			}
			if strings.HasPrefix(ext, ".tar.") || ext == ".tar" {
				return true
			}
		}
	}
	return false
}

// isJunkArchiveEntry returns true for OS-generated junk files that should be
// skipped during extraction (macOS metadata, Windows thumbs, etc.).
func isJunkArchiveEntry(path string) bool {
	// __MACOSX resource fork directory
	if strings.HasPrefix(path, "__MACOSX/") || path == "__MACOSX" {
		return true
	}

	base := filepath.Base(path)

	// macOS .DS_Store
	if base == ".DS_Store" {
		return true
	}

	// Windows Thumbs.db
	if base == "Thumbs.db" {
		return true
	}

	return false
}

// isSafeArchivePath validates that an archive entry path is safe to extract
// (prevents zip-slip attacks and rejects absolute paths).
func isSafeArchivePath(path string) bool {
	if path == "" {
		return false
	}

	// Reject absolute paths
	if filepath.IsAbs(path) {
		return false
	}

	// Reject paths with ".." components
	cleaned := filepath.Clean(path)
	if strings.HasPrefix(cleaned, "..") {
		return false
	}

	return true
}

// extractArchive extracts the contents of an archive file into the destination
// directory. Each extracted file is processed through fs.WriteFile() for
// metadata computation, DB registration, and digest processing.
//
// Returns the list of relative paths (from UserDataDir) that were created.
func (h *Handlers) extractArchive(ctx context.Context, archivePath, destRelDir string) ([]uploadFileResult, error) {
	// Open the archive file
	f, err := os.Open(archivePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Identify the archive format
	format, stream, err := archives.Identify(ctx, filepath.Base(archivePath), f)
	if err != nil {
		return nil, err
	}

	// Check it's an extractor
	ex, ok := format.(archives.Extractor)
	if !ok {
		return nil, fmt.Errorf("identified format %T does not support extraction", format)
	}

	cfg := config.Get()
	var results []uploadFileResult

	// Extract each file
	err = ex.Extract(ctx, stream, func(ctx context.Context, fi archives.FileInfo) error {
		nameInArchive := fi.NameInArchive

		// Skip directories
		if fi.IsDir() {
			return nil
		}

		// Skip junk entries
		if isJunkArchiveEntry(nameInArchive) {
			log.Debug().Str("entry", nameInArchive).Msg("archive extract: skipping junk entry")
			return nil
		}

		// Validate path safety
		if !isSafeArchivePath(nameInArchive) {
			log.Warn().Str("entry", nameInArchive).Msg("archive extract: skipping unsafe path")
			return nil
		}

		// Build the destination relative path
		relPath := filepath.Join(destRelDir, nameInArchive)

		// Ensure parent directory exists
		parentDir := filepath.Join(cfg.UserDataDir, filepath.Dir(relPath))
		if err := os.MkdirAll(parentDir, 0755); err != nil {
			log.Error().Err(err).Str("dir", parentDir).Msg("archive extract: failed to create parent directory")
			return nil // Skip this file, continue extracting
		}

		// Open the file from the archive
		rc, err := fi.Open()
		if err != nil {
			log.Error().Err(err).Str("entry", nameInArchive).Msg("archive extract: failed to open entry")
			return nil // Skip this file, continue extracting
		}
		defer rc.Close()

		// Detect MIME type from extension
		mimeType := mime.TypeByExtension(filepath.Ext(nameInArchive))

		// If extension-based detection fails, try reading first 512 bytes
		if mimeType == "" {
			buf := make([]byte, 512)
			n, _ := rc.Read(buf)
			if n > 0 {
				mimeType = http.DetectContentType(buf[:n])
				// Create a new reader that includes the bytes we already read
				rc = io.NopCloser(io.MultiReader(bytes.NewReader(buf[:n]), rc))
			}
		}

		// Write through fs.WriteFile()
		result, err := h.server.FS().WriteFile(ctx, fs.WriteRequest{
			Path:            relPath,
			Content:         rc,
			MimeType:        mimeType,
			Source:          "upload",
			ComputeMetadata: true,
			Sync:            true,
		})
		if err != nil {
			log.Error().Err(err).Str("path", relPath).Msg("archive extract: failed to write file")
			return nil // Skip this file, continue extracting
		}

		status := "created"
		if !result.IsNew {
			status = "updated"
		}

		log.Info().
			Str("path", relPath).
			Str("entry", nameInArchive).
			Str("status", status).
			Msg("archive extract: file extracted")

		results = append(results, uploadFileResult{Path: relPath, Status: status})
		return nil
	})

	if err != nil {
		return results, err
	}

	return results, nil
}
```

**Note:** Add `"fmt"` to the imports.

**Step 4: Run the unit tests to verify they pass**

Run:
```bash
cd backend && go test -v ./api/ -run "TestIsArchiveFile|TestIsJunkArchiveEntry|TestIsSafeArchivePath"
```
Expected: PASS

**Step 5: Verify the code compiles**

Run:
```bash
cd backend && go build ./...
```
Expected: Success

**Step 6: Commit**

```bash
git add backend/api/archive.go backend/api/archive_test.go
git commit -m "feat: add archive detection and extraction logic

Uses mholt/archives to support zip, tar, tar.gz, tar.bz2, tar.xz,
tar.zst, 7z, and rar formats. Includes zip-slip prevention and junk
file filtering (__MACOSX, .DS_Store, Thumbs.db)."
```

---

### Task 3: Integrate archive extraction into `FinalizeUpload`

**Files:**
- Modify: `backend/api/upload.go` — `FinalizeUpload` method (around line 104-265)

**Step 1: Add archive handling after the file is written**

In `FinalizeUpload`, after the existing `h.server.FS().WriteFile()` call (around line 214-221) and before the "Clean up TUS upload files" section, add archive detection and extraction. The key change is: if the uploaded file is an archive, instead of keeping it, extract its contents and delete the archive.

Find the loop body in `FinalizeUpload` that processes each upload (starting around line 148). Replace the section from the `// Open uploaded file for reading` comment (line 205) through the `paths = append(paths, destPath)` / `results = append(results, ...)` lines (around line 243) with:

```go
		// Check if this is an archive file — extract instead of keeping
		if isArchiveFile(filename) {
			log.Info().
				Str("path", destPath).
				Str("filename", filename).
				Msg("upload is an archive, extracting contents")

			// Extract archive contents into the destination directory
			extractResults, err := h.extractArchive(c.Request.Context(), srcPath, destination)

			// Clean up TUS upload files (archive itself)
			os.Remove(srcPath)
			os.Remove(srcPath + ".info")

			if err != nil {
				log.Error().Err(err).Str("path", destPath).Msg("archive extraction failed")
				// If some files were extracted before the error, still include them
			}

			for _, r := range extractResults {
				paths = append(paths, r.Path)
				results = append(results, r)
			}

			log.Info().
				Int("filesExtracted", len(extractResults)).
				Str("archive", filename).
				Msg("archive extraction complete")

			continue
		}

		// --- existing non-archive upload code below (Open uploaded file, WriteFile, etc.) ---
```

**Step 2: Verify the code compiles**

Run:
```bash
cd backend && go build ./...
```
Expected: Success

**Step 3: Commit**

```bash
git add backend/api/upload.go
git commit -m "feat: extract archive files in FinalizeUpload (TUS uploads)

When a TUS upload is finalized and the file is a supported archive
format, extract its contents into the destination instead of keeping
the archive file."
```

---

### Task 4: Integrate archive extraction into `SimpleUpload`

**Files:**
- Modify: `backend/api/upload.go` — `SimpleUpload` method (around line 267-369)

**Step 1: Add archive handling after the file is written**

In `SimpleUpload`, the current flow is: read body → dedup check → `WriteFile()`. For archives, we need to: write the archive to a temp file → extract → delete temp file.

After the dedup check (around line 325), before the existing `WriteFile` call, add archive handling:

```go
	if isArchiveFile(filename) {
		log.Info().
			Str("filename", filename).
			Str("destination", dir).
			Msg("simple upload is an archive, extracting contents")

		// Write archive to a temp file for extraction
		tmpFile, err := os.CreateTemp("", "mld-archive-*")
		if err != nil {
			log.Error().Err(err).Msg("simple upload: failed to create temp file for archive")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to process archive"})
			return
		}
		tmpPath := tmpFile.Name()
		defer os.Remove(tmpPath)

		if _, err := io.Copy(tmpFile, bytes.NewReader(bodyBytes)); err != nil {
			tmpFile.Close()
			log.Error().Err(err).Msg("simple upload: failed to write archive to temp file")
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to process archive"})
			return
		}
		tmpFile.Close()

		// Extract
		extractResults, err := h.extractArchive(c.Request.Context(), tmpPath, dir)
		if err != nil {
			log.Error().Err(err).Msg("simple upload: archive extraction failed")
			// If partial extraction, still return what we got
		}

		if len(extractResults) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "No files extracted from archive"})
			return
		}

		var allPaths []string
		var allResults []uploadFileResult
		for _, r := range extractResults {
			allPaths = append(allPaths, r.Path)
			allResults = append(allResults, r)
		}

		// Notify UI
		if dir == "inbox" || dir == "" || dir == "." {
			h.server.Notifications().NotifyInboxChanged()
		} else {
			h.server.Notifications().NotifyLibraryChanged(allPaths[0], "upload")
		}

		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"path":    allPaths[0],
			"paths":   allPaths,
			"results": allResults,
		})
		return
	}
```

Place this block **before** the existing dedup/WriteFile logic (after reading `bodyBytes` and computing `incomingHash`, before the `dedup := utils.DeduplicateFileWithHash(...)` call). This way archives take a completely separate code path and skip the single-file dedup logic.

**Step 2: Verify the code compiles**

Run:
```bash
cd backend && go build ./...
```
Expected: Success

**Step 3: Commit**

```bash
git add backend/api/upload.go
git commit -m "feat: extract archive files in SimpleUpload

When a small file uploaded via simple PUT is a supported archive,
write to temp file, extract contents, and delete the archive."
```

---

### Task 5: Manual integration test

**Step 1: Create a test zip file**

Run:
```bash
mkdir -p /tmp/test-archive && echo "hello" > /tmp/test-archive/hello.txt && echo "world" > /tmp/test-archive/world.txt && cd /tmp/test-archive && zip /tmp/test-upload.zip hello.txt world.txt
```

**Step 2: Build and start the server**

Run (from the worktree):
```bash
cd backend && go build . && ./my-life-db
```
(Or confirm the dev server is already running and restart it with the new code.)

**Step 3: Upload the zip via curl**

Run:
```bash
curl -X PUT \
  -H "Content-Type: application/zip" \
  --data-binary @/tmp/test-upload.zip \
  "http://localhost:12345/api/upload/simple/inbox/test-upload.zip"
```

Expected response: JSON with `paths` containing `inbox/hello.txt` and `inbox/world.txt` (not `inbox/test-upload.zip`).

**Step 4: Verify the files exist**

Check that `hello.txt` and `world.txt` exist in the inbox, and `test-upload.zip` does NOT exist.

**Step 5: Clean up test files**

```bash
rm /tmp/test-upload.zip && rm -rf /tmp/test-archive
```

---

### Task 6: Run full test suite and verify no regressions

**Step 1: Run Go tests**

Run:
```bash
cd backend && go test -v ./...
```
Expected: All tests PASS

**Step 2: Run Go vet**

Run:
```bash
cd backend && go vet ./...
```
Expected: No issues

**Step 3: Verify frontend still builds (no changes, but sanity check)**

Run:
```bash
cd frontend && npm run typecheck && npm run build
```
Expected: Success
