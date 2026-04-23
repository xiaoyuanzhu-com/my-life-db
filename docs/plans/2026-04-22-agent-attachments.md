# Agent Session Attachments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users attach files (any type, up to 1 GB, multiple per message) in both the new-session and active-session composers. Files are staged server-side and referenced in the prompt via the existing `@<absolute-path>` file-tag convention.

**Architecture:** Two new REST endpoints (`POST`/`DELETE /api/agent/attachments`) stage and remove uploads under `APP_DATA_DIR/tmp/agent-uploads/<uploadID>/`. An hourly janitor goroutine on the `Server` sweeps entries older than 30 days. The composer tracks attachments as local UI state (chips with an X affordance) and, on send, appends ` @<absolutePath>` per attachment to the prompt text. No changes to `POST /api/agent/sessions`, the WebSocket send-prompt frame, `agentMgr.CreateSession`, or message persistence.

**Tech Stack:** Go 1.25 + Gin + zerolog (backend), React 19 + TypeScript + assistant-ui (frontend).

**Design doc:** `docs/plans/2026-04-22-agent-attachments-design.md`

**Working directory:** `.worktrees/agent-attachments-design/` (already set up from brainstorming).

**Conventions reminders:**
- Go: `snake_case.go`, `h.server.Cfg().AppDataDir` to access the app data dir, `log.Info()` for visible logs.
- Frontend: `kebab-case.tsx`, `useMutation` / `useQuery` from `@tanstack/react-query` where relevant, semantic Tailwind colors (`bg-background`, `text-muted-foreground`, etc.), no borders where a gap suffices.
- Commits: conventional (`feat:`, `test:`, `refactor:`). Don't push until explicitly told.

---

## Task 1: Upload handler — failing test

**Files:**
- Create: `backend/api/agent_attachments_test.go`

**Step 1: Write the failing test**

```go
package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// newAttachmentsHandler builds a minimal handler for attachment tests that
// reads/writes under the given tmpDir, independent of the full Server struct.
func newAttachmentsHandler(tmpDir string) *attachmentsHandler {
	return &attachmentsHandler{appDataDir: tmpDir}
}

func TestUploadAttachment_HappyPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()
	h := newAttachmentsHandler(tmpDir)

	// Build a multipart request with field "file"
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	fw, err := mw.CreateFormFile("file", "hello.txt")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := fw.Write([]byte("hi there")); err != nil {
		t.Fatalf("write: %v", err)
	}
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/agent/attachments", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()

	r := gin.New()
	r.POST("/api/agent/attachments", h.UploadAttachment)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}

	var resp struct {
		UploadID     string `json:"uploadID"`
		AbsolutePath string `json:"absolutePath"`
		Filename     string `json:"filename"`
		Size         int64  `json:"size"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.UploadID == "" {
		t.Fatal("empty uploadID")
	}
	if resp.Filename != "hello.txt" {
		t.Fatalf("filename = %q", resp.Filename)
	}
	if resp.Size != 8 {
		t.Fatalf("size = %d", resp.Size)
	}

	wantDir := filepath.Join(tmpDir, "tmp", "agent-uploads", resp.UploadID)
	wantPath := filepath.Join(wantDir, "hello.txt")
	if resp.AbsolutePath != wantPath {
		t.Fatalf("absolutePath = %q, want %q", resp.AbsolutePath, wantPath)
	}

	data, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatalf("read saved file: %v", err)
	}
	if string(data) != "hi there" {
		t.Fatalf("saved contents = %q", string(data))
	}
}

func TestUploadAttachment_MissingFile(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()
	h := newAttachmentsHandler(tmpDir)

	// Empty multipart (no "file" field)
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/agent/attachments", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()

	r := gin.New()
	r.POST("/api/agent/attachments", h.UploadAttachment)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", w.Code, w.Body.String())
	}
}

func TestUploadAttachment_FilenameSanitized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()
	h := newAttachmentsHandler(tmpDir)

	// A malicious filename containing path traversal should not escape the
	// upload dir. Go's filepath.Base handles this; we assert the filename in
	// the response is the base name only.
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	fw, _ := mw.CreateFormFile("file", "../../etc/passwd")
	fw.Write([]byte("x"))
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/agent/attachments", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()

	r := gin.New()
	r.POST("/api/agent/attachments", h.UploadAttachment)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}

	var resp struct {
		Filename     string `json:"filename"`
		AbsolutePath string `json:"absolutePath"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Filename != "passwd" {
		t.Fatalf("filename = %q, expected base name only", resp.Filename)
	}
	// Saved path should be inside tmpDir/tmp/agent-uploads/*
	rootPrefix := filepath.Join(tmpDir, "tmp", "agent-uploads") + string(filepath.Separator)
	if !strings.HasPrefix(resp.AbsolutePath, rootPrefix) {
		t.Fatalf("absolutePath escaped root: %q", resp.AbsolutePath)
	}
}
```

**Step 2: Run the test to verify it fails**

```bash
cd backend && go test ./api/ -run TestUploadAttachment -v
```

Expected: compile error — `attachmentsHandler` / `UploadAttachment` do not exist.

---

## Task 2: Upload handler — implement

**Files:**
- Create: `backend/api/agent_attachments.go`

**Step 1: Implement the handler**

```go
package api

import (
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// maxAttachmentSize is the per-file upload cap (1 GiB).
// Enforced via http.MaxBytesReader so oversized requests get 413 cheaply
// before we try to parse them.
const maxAttachmentSize = 1 << 30

// attachmentsHandler owns the on-disk staging area for agent attachments.
// It's a small inner helper so its logic can be unit-tested without wiring
// the full Server. Production usage goes through the Handlers shim below.
type attachmentsHandler struct {
	appDataDir string
}

// UploadAttachment handles POST /api/agent/attachments.
// Stages a single multipart file at APP_DATA_DIR/tmp/agent-uploads/<uuid>/<filename>
// and returns the absolute path + metadata.
func (a *attachmentsHandler) UploadAttachment(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAttachmentSize)

	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing or invalid 'file' field: " + err.Error()})
		return
	}
	if fileHeader.Size > maxAttachmentSize {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file exceeds 1 GiB limit"})
		return
	}

	// Sanitize filename — strip any path components the client provided.
	filename := filepath.Base(fileHeader.Filename)
	if filename == "" || filename == "." || filename == string(filepath.Separator) {
		filename = "file"
	}

	uploadID := uuid.New().String()
	destDir := filepath.Join(a.appDataDir, "tmp", "agent-uploads", uploadID)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		log.Error().Err(err).Str("dir", destDir).Msg("agent-attachments: mkdir failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create staging dir"})
		return
	}
	destPath := filepath.Join(destDir, filename)

	src, err := fileHeader.Open()
	if err != nil {
		os.RemoveAll(destDir)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to open upload: " + err.Error()})
		return
	}
	defer src.Close()

	dst, err := os.Create(destPath)
	if err != nil {
		os.RemoveAll(destDir)
		log.Error().Err(err).Str("path", destPath).Msg("agent-attachments: create failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to stage file"})
		return
	}
	written, err := io.Copy(dst, src)
	closeErr := dst.Close()
	if err != nil || closeErr != nil {
		os.RemoveAll(destDir)
		log.Error().Err(err).Err(closeErr).Str("path", destPath).Msg("agent-attachments: write failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file"})
		return
	}

	log.Info().
		Str("uploadID", uploadID).
		Str("filename", filename).
		Int64("size", written).
		Msg("agent-attachments: upload staged")

	c.JSON(http.StatusOK, gin.H{
		"uploadID":     uploadID,
		"absolutePath": destPath,
		"filename":     filename,
		"size":         written,
		"contentType":  fileHeader.Header.Get("Content-Type"),
	})
}

// UploadAgentAttachment is the production shim used by the real router.
// Delegates to the inner handler with the server-configured app data dir.
func (h *Handlers) UploadAgentAttachment(c *gin.Context) {
	inner := &attachmentsHandler{appDataDir: h.server.Cfg().AppDataDir}
	inner.UploadAttachment(c)
}
```

**Step 2: Run tests to verify they pass**

```bash
cd backend && go test ./api/ -run TestUploadAttachment -v
```

Expected: 3 tests PASS.

**Step 3: Commit**

```bash
git add backend/api/agent_attachments.go backend/api/agent_attachments_test.go
git commit -m "feat(agent): add upload handler for session attachments"
```

---

## Task 3: Delete handler — failing test

**Files:**
- Modify: `backend/api/agent_attachments_test.go`

**Step 1: Append tests**

```go
func TestDeleteAttachment_Happy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()
	h := newAttachmentsHandler(tmpDir)

	// Seed a fake upload dir
	uploadID := "deadbeef-1111-2222-3333-444455556666"
	dir := filepath.Join(tmpDir, "tmp", "agent-uploads", uploadID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "foo.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/agent/attachments/"+uploadID, nil)
	w := httptest.NewRecorder()
	r := gin.New()
	r.DELETE("/api/agent/attachments/:uploadID", h.DeleteAttachment)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("dir still exists: err=%v", err)
	}
}

func TestDeleteAttachment_Missing_IsIdempotent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()
	h := newAttachmentsHandler(tmpDir)

	req := httptest.NewRequest(http.MethodDelete, "/api/agent/attachments/does-not-exist", nil)
	w := httptest.NewRecorder()
	r := gin.New()
	r.DELETE("/api/agent/attachments/:uploadID", h.DeleteAttachment)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestDeleteAttachment_TraversalRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()
	h := newAttachmentsHandler(tmpDir)

	// A crafted uploadID with path separators must not escape the root.
	// The handler should treat it as invalid and return 400.
	req := httptest.NewRequest(http.MethodDelete, "/api/agent/attachments/..%2F..", nil)
	w := httptest.NewRecorder()
	r := gin.New()
	r.DELETE("/api/agent/attachments/:uploadID", h.DeleteAttachment)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}
```

**Step 2: Run to verify it fails**

```bash
cd backend && go test ./api/ -run TestDeleteAttachment -v
```

Expected: compile error — `DeleteAttachment` does not exist.

---

## Task 4: Delete handler — implement

**Files:**
- Modify: `backend/api/agent_attachments.go`

**Step 1: Append handler**

```go
// DeleteAttachment handles DELETE /api/agent/attachments/:uploadID.
// Removes the staged directory. Idempotent — returns 204 whether or not
// the dir existed. Rejects uploadIDs that contain path separators.
func (a *attachmentsHandler) DeleteAttachment(c *gin.Context) {
	uploadID := c.Param("uploadID")
	if uploadID == "" || uploadID == "." || uploadID == ".." ||
		filepath.Base(uploadID) != uploadID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid uploadID"})
		return
	}

	dir := filepath.Join(a.appDataDir, "tmp", "agent-uploads", uploadID)
	if err := os.RemoveAll(dir); err != nil {
		log.Error().Err(err).Str("uploadID", uploadID).Msg("agent-attachments: delete failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete"})
		return
	}

	log.Info().Str("uploadID", uploadID).Msg("agent-attachments: upload deleted")
	c.Status(http.StatusNoContent)
}

// DeleteAgentAttachment is the production shim used by the real router.
func (h *Handlers) DeleteAgentAttachment(c *gin.Context) {
	inner := &attachmentsHandler{appDataDir: h.server.Cfg().AppDataDir}
	inner.DeleteAttachment(c)
}
```

**Step 2: Run tests**

```bash
cd backend && go test ./api/ -run TestDeleteAttachment -v
```

Expected: 3 tests PASS.

**Step 3: Commit**

```bash
git add backend/api/agent_attachments.go backend/api/agent_attachments_test.go
git commit -m "feat(agent): add delete handler for staged attachments"
```

---

## Task 5: Wire routes

**Files:**
- Modify: `backend/api/routes.go` (inside the `agentRoutes` group, near line 162 after the existing session/share routes)

**Step 1: Add the two routes**

Find the `agentRoutes := r.Group("/api/agent", ...)` block (around line 149). After the `DELETE /sessions/:id/share` line, add:

```go
		// Ephemeral attachments for agent prompts (1 GB cap per file).
		// Files stage under APP_DATA_DIR/tmp/agent-uploads/<uploadID>/
		// and are swept by a background janitor after 30 days.
		agentRoutes.POST("/attachments", h.UploadAgentAttachment)
		agentRoutes.DELETE("/attachments/:uploadID", h.DeleteAgentAttachment)
```

**Step 2: Build**

```bash
cd backend && go build .
```

Expected: success.

**Step 3: Smoke test locally**

```bash
cd backend && go run . &
# wait a second, then:
curl -sS -F "file=@/etc/hosts" http://localhost:12345/api/agent/attachments
```

Expected: JSON with `uploadID`, `absolutePath`, `filename=hosts`. Then:

```bash
ls $(echo APP_DATA_DIR)/tmp/agent-uploads/
```

Expected: one directory named by the returned uploadID, containing `hosts`.

Kill the server when done.

**Step 4: Commit**

```bash
git add backend/api/routes.go
git commit -m "feat(agent): wire attachment upload/delete routes"
```

---

## Task 6: Janitor — failing test

**Files:**
- Create: `backend/api/agent_attachments_janitor_test.go`

**Step 1: Write the test**

```go
package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSweepAgentAttachments(t *testing.T) {
	tmpDir := t.TempDir()
	root := filepath.Join(tmpDir, "tmp", "agent-uploads")

	// Seed three upload dirs:
	//   old:    mtime 40 days ago  → should be deleted
	//   recent: mtime 5 days ago   → should be kept
	//   brand:  mtime now          → should be kept
	old := filepath.Join(root, "old")
	recent := filepath.Join(root, "recent")
	brand := filepath.Join(root, "brand")
	for _, d := range []string{old, recent, brand} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("seed %s: %v", d, err)
		}
		if err := os.WriteFile(filepath.Join(d, "f.txt"), []byte("x"), 0o644); err != nil {
			t.Fatalf("seed file: %v", err)
		}
	}

	now := time.Now()
	if err := os.Chtimes(old, now.Add(-40*24*time.Hour), now.Add(-40*24*time.Hour)); err != nil {
		t.Fatalf("chtimes old: %v", err)
	}
	if err := os.Chtimes(recent, now.Add(-5*24*time.Hour), now.Add(-5*24*time.Hour)); err != nil {
		t.Fatalf("chtimes recent: %v", err)
	}

	removed, err := SweepAgentAttachments(tmpDir, 30*24*time.Hour)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old dir should be deleted")
	}
	if _, err := os.Stat(recent); err != nil {
		t.Fatalf("recent dir should be kept: %v", err)
	}
	if _, err := os.Stat(brand); err != nil {
		t.Fatalf("brand dir should be kept: %v", err)
	}
}

func TestSweepAgentAttachments_RootMissing(t *testing.T) {
	// No root dir yet — sweep should be a no-op, not an error.
	tmpDir := t.TempDir()
	removed, err := SweepAgentAttachments(tmpDir, 30*24*time.Hour)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if removed != 0 {
		t.Fatalf("removed = %d", removed)
	}
}
```

**Step 2: Run to verify it fails**

```bash
cd backend && go test ./api/ -run TestSweepAgentAttachments -v
```

Expected: compile error — `SweepAgentAttachments` does not exist.

---

## Task 7: Janitor — implement sweep function

**Files:**
- Create: `backend/api/agent_attachments_janitor.go`

**Step 1: Implement**

```go
package api

import (
	"os"
	"path/filepath"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// SweepAgentAttachments deletes attachment staging directories older than
// maxAge. Returns the count of removed directories.
//
// Safe to call concurrently with live uploads/deletes — it operates at the
// directory level and never touches an in-progress upload's files directly.
// If the root doesn't exist yet, it's a no-op.
func SweepAgentAttachments(appDataDir string, maxAge time.Duration) (int, error) {
	root := filepath.Join(appDataDir, "tmp", "agent-uploads")
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	cutoff := time.Now().Add(-maxAge)
	removed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		info, err := os.Stat(dir)
		if err != nil {
			log.Error().Err(err).Str("dir", dir).Msg("agent-attachments: stat failed during sweep")
			continue
		}
		if info.ModTime().Before(cutoff) {
			if err := os.RemoveAll(dir); err != nil {
				log.Error().Err(err).Str("dir", dir).Msg("agent-attachments: remove failed during sweep")
				continue
			}
			removed++
		}
	}
	if removed > 0 {
		log.Info().Int("removed", removed).Dur("maxAge", maxAge).Msg("agent-attachments: sweep complete")
	}
	return removed, nil
}
```

**Step 2: Run tests**

```bash
cd backend && go test ./api/ -run TestSweepAgentAttachments -v
```

Expected: 2 tests PASS.

**Step 3: Commit**

```bash
git add backend/api/agent_attachments_janitor.go backend/api/agent_attachments_janitor_test.go
git commit -m "feat(agent): add sweeper for stale attachment uploads"
```

---

## Task 8: Janitor — hook into Server

**Files:**
- Modify: `backend/server/server.go` (inside `Server.Start()` — or wherever other background goroutines start)

**Step 1: Find the right spot**

Run:

```bash
grep -n "go s\\.\\|goroutine\\|shutdownCtx" backend/server/server.go | head -20
```

Look for existing background-goroutine launches in `Start()` or `New()`. The janitor should start in `Start()` (so it runs when the server is actually serving) and exit when `shutdownCtx` is cancelled.

**Step 2: Add the goroutine**

Add near the other background goroutine starts in `Start()`:

```go
	// Background sweeper: delete attachment staging dirs older than 30 days.
	// Imported here rather than in api/ to keep background-worker lifecycle
	// owned by the Server.
	go s.runAttachmentsJanitor()
```

Then add the method (anywhere after the existing methods in this file):

```go
// runAttachmentsJanitor runs hourly while the server is up, sweeping
// APP_DATA_DIR/tmp/agent-uploads/ for entries older than 30 days.
func (s *Server) runAttachmentsJanitor() {
	const (
		interval = 1 * time.Hour
		maxAge   = 30 * 24 * time.Hour
	)

	// Run once at startup so a long-stopped server still cleans up.
	if _, err := api.SweepAgentAttachments(s.cfg.AppDataDir, maxAge); err != nil {
		log.Error().Err(err).Msg("agent-attachments: initial sweep failed")
	}

	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-s.shutdownCtx.Done():
			return
		case <-t.C:
			if _, err := api.SweepAgentAttachments(s.cfg.AppDataDir, maxAge); err != nil {
				log.Error().Err(err).Msg("agent-attachments: sweep failed")
			}
		}
	}
}
```

**Caveat:** `server` → `api` is a new import direction. Check current import graph first:

```bash
grep -rn '"github.com/xiaoyuanzhu-com/my-life-db/api"' backend/server/
```

If `server` already imports `api` somewhere, add it normally. If not, and it would cause a cycle (because `api` imports `server`), move `SweepAgentAttachments` to a neutral package — e.g., put the file at `backend/server/agent_attachments_janitor.go` and change the package from `api` to `server` (adjust the test path too). Prefer the cleaner import direction; if that means moving the sweep into `server`, do that and update Task 6/7 accordingly.

**Step 3: Build**

```bash
cd backend && go build .
```

Expected: success.

**Step 4: Smoke test**

Start the server:

```bash
cd backend && go run .
```

Look for the initial log line `agent-attachments: sweep complete` (only fires if something was actually removed — so on a clean setup you won't see it; that's fine). No errors in the output.

Kill the server.

**Step 5: Commit**

```bash
git add backend/server/server.go  # plus any files moved
git commit -m "feat(agent): start hourly sweep of stale attachments"
```

---

## Task 9: Frontend — upload client helper

**Files:**
- Create: `frontend/app/lib/agent-attachments.ts`

**Step 1: Write the helper**

```ts
/**
 * Client for the agent-session attachment API.
 *
 * Attachments are ephemeral files staged server-side under
 * APP_DATA_DIR/tmp/agent-uploads/<uploadID>/. They are referenced in the
 * outgoing prompt via `@<absolutePath>` (the same convention as the
 * existing @-file-tag). A server-side janitor deletes staged files older
 * than 30 days.
 */

import { fetchWithRefresh } from "~/lib/fetch-with-refresh"

export interface Attachment {
  uploadID: string
  absolutePath: string
  filename: string
  size: number
  contentType?: string
}

export async function uploadAgentAttachment(
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<Attachment> {
  // fetch() doesn't expose upload progress, so use XHR when a progress
  // callback is needed. Falls back to fetchWithRefresh for the no-progress
  // case (keeps auth refresh behavior consistent).
  if (!onProgress) {
    const fd = new FormData()
    fd.append("file", file)
    const res = await fetchWithRefresh("/api/agent/attachments", {
      method: "POST",
      body: fd,
      signal,
    })
    if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    return res.json()
  }

  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", "/api/agent/attachments")
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) } catch (e) { reject(e) }
      } else {
        reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText}`))
      }
    }
    xhr.onerror = () => reject(new Error("network error"))
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"))
    signal?.addEventListener("abort", () => xhr.abort())
    const fd = new FormData()
    fd.append("file", file)
    xhr.send(fd)
  })
}

export async function deleteAgentAttachment(uploadID: string): Promise<void> {
  const res = await fetchWithRefresh(`/api/agent/attachments/${encodeURIComponent(uploadID)}`, {
    method: "DELETE",
  })
  if (!res.ok && res.status !== 204) throw new Error(`delete failed: ${res.status}`)
}
```

**Step 2: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add frontend/app/lib/agent-attachments.ts
git commit -m "feat(agent): add attachment API client helpers"
```

---

## Task 10: Frontend — attachments state hook

**Files:**
- Create: `frontend/app/hooks/use-agent-attachments.ts`

**Step 1: Write the hook**

```ts
/**
 * useAgentAttachments — composer-local state for staged attachments.
 *
 * Each Attachment goes through: uploading → ready | error. The hook owns
 * the XHR lifecycle (including abort on remove) and fires a server-side
 * DELETE when a chip is removed or the hook unmounts with pending chips.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  uploadAgentAttachment,
  deleteAgentAttachment,
  type Attachment,
} from "~/lib/agent-attachments"

export type AttachmentState =
  | { status: "uploading"; progress: number; file: File }
  | { status: "ready"; attachment: Attachment }
  | { status: "error"; error: string; file: File }

export interface StagedAttachment {
  /** Client-side id, stable across state transitions. */
  clientID: string
  state: AttachmentState
}

export function useAgentAttachments() {
  const [items, setItems] = useState<StagedAttachment[]>([])
  const abortersRef = useRef(new Map<string, AbortController>())

  const addFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      const clientID = crypto.randomUUID()
      setItems((prev) => [
        ...prev,
        { clientID, state: { status: "uploading", progress: 0, file } },
      ])
      const ac = new AbortController()
      abortersRef.current.set(clientID, ac)

      try {
        const attachment = await uploadAgentAttachment(
          file,
          (pct) => {
            setItems((prev) =>
              prev.map((it) =>
                it.clientID === clientID && it.state.status === "uploading"
                  ? { ...it, state: { ...it.state, progress: pct } }
                  : it,
              ),
            )
          },
          ac.signal,
        )
        setItems((prev) =>
          prev.map((it) =>
            it.clientID === clientID ? { clientID, state: { status: "ready", attachment } } : it,
          ),
        )
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return
        setItems((prev) =>
          prev.map((it) =>
            it.clientID === clientID
              ? { clientID, state: { status: "error", error: String(err), file } }
              : it,
          ),
        )
      } finally {
        abortersRef.current.delete(clientID)
      }
    }
  }, [])

  const remove = useCallback(async (clientID: string) => {
    const ac = abortersRef.current.get(clientID)
    ac?.abort()
    abortersRef.current.delete(clientID)

    let uploadID: string | undefined
    setItems((prev) => {
      const it = prev.find((i) => i.clientID === clientID)
      if (it?.state.status === "ready") uploadID = it.state.attachment.uploadID
      return prev.filter((i) => i.clientID !== clientID)
    })
    if (uploadID) {
      try { await deleteAgentAttachment(uploadID) } catch (e) {
        console.warn("[agent-attachments] delete on remove failed", e)
      }
    }
  }, [])

  /** Called by the composer after a successful send to clear the strip. */
  const clear = useCallback(() => {
    // Don't call DELETE — these files were just sent to the agent and may
    // still be referenced. The 30-day janitor will clean up.
    abortersRef.current.forEach((ac) => ac.abort())
    abortersRef.current.clear()
    setItems([])
  }, [])

  /** Ready attachments, in order — used by the composer on send. */
  const readyAttachments = items.flatMap((it) =>
    it.state.status === "ready" ? [it.state.attachment] : [],
  )
  const hasPending = items.some((it) => it.state.status !== "ready")

  // Best-effort cleanup on unmount: abort in-flight uploads and DELETE any
  // staged-but-not-sent attachments so we don't leak tmp files when the
  // user navigates away with chips still in the strip.
  useEffect(() => {
    return () => {
      abortersRef.current.forEach((ac) => ac.abort())
      for (const it of items) {
        if (it.state.status === "ready") {
          deleteAgentAttachment(it.state.attachment.uploadID).catch(() => {})
        }
      }
    }
    // Intentionally runs only on unmount; `items` is captured via ref access pattern above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { items, readyAttachments, hasPending, addFiles, remove, clear }
}
```

**Step 2: Typecheck + lint**

```bash
cd frontend && npm run typecheck && npm run lint
```

Expected: no errors.

**Step 3: Commit**

```bash
git add frontend/app/hooks/use-agent-attachments.ts
git commit -m "feat(agent): add useAgentAttachments composer state hook"
```

---

## Task 11: Frontend — chip + strip components

**Files:**
- Create: `frontend/app/components/agent/attachment-chip.tsx`
- Create: `frontend/app/components/agent/attachment-strip.tsx`

**Step 1: Write the chip**

```tsx
import { XIcon, FileIcon, ImageIcon, Loader2 } from "lucide-react"
import { cn } from "~/lib/utils"
import type { StagedAttachment } from "~/hooks/use-agent-attachments"

interface Props {
  item: StagedAttachment
  onRemove: () => void
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function AttachmentChip({ item, onRemove }: Props) {
  const s = item.state
  const filename =
    s.status === "ready" ? s.attachment.filename :
    s.status === "uploading" ? s.file.name :
    s.file.name
  const size =
    s.status === "ready" ? s.attachment.size :
    s.file.size
  const isImage =
    (s.status === "ready" && s.attachment.contentType?.startsWith("image/")) ||
    (s.status !== "ready" && s.file.type.startsWith("image/"))

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md bg-muted/70 px-2 py-1 text-xs max-w-[240px]",
        s.status === "error" && "bg-destructive/10 text-destructive",
      )}
      title={filename}
    >
      {s.status === "uploading" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : isImage ? (
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate">{filename}</span>
      <span className="text-muted-foreground/70 shrink-0">
        {s.status === "uploading" ? `${s.progress}%` : humanSize(size)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label={`Remove ${filename}`}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}
```

**Step 2: Write the strip**

```tsx
import type { StagedAttachment } from "~/hooks/use-agent-attachments"
import { AttachmentChip } from "./attachment-chip"

interface Props {
  items: StagedAttachment[]
  onRemove: (clientID: string) => void
}

export function AttachmentStrip({ items, onRemove }: Props) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-(--composer-padding) pt-2">
      {items.map((item) => (
        <AttachmentChip
          key={item.clientID}
          item={item}
          onRemove={() => onRemove(item.clientID)}
        />
      ))}
    </div>
  )
}
```

**Step 3: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add frontend/app/components/agent/attachment-chip.tsx frontend/app/components/agent/attachment-strip.tsx
git commit -m "feat(agent): add attachment chip + strip components"
```

---

## Task 12: Frontend — integrate into Composer (UI + drag-and-drop)

**Files:**
- Modify: `frontend/app/components/assistant-ui/thread.tsx` (the `Composer` component, around line 436)

**Step 1: Wire the hook + strip + "+" button + drag-and-drop**

At the top of the `Composer` component, add:

```tsx
import { PlusIcon } from "lucide-react"  // add to the existing lucide-react import
import { useAgentAttachments } from "~/hooks/use-agent-attachments"
import { AttachmentStrip } from "~/components/agent/attachment-strip"
```

Inside `Composer`, after the existing `useAgentContext()` destructure:

```tsx
  const attachments = useAgentAttachments()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const onFilesPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) attachments.addFiles(files)
    // Clear so selecting the same file again re-triggers change.
    e.target.value = ""
  }
```

Expose the attachments state to the shell by threading it through an existing prop of `ComposerPrimitive.Root` is not straightforward — instead, stash `attachments.readyAttachments` on a ref and read it from the send intercept (Task 13). For now, export a stable callback via a ref:

```tsx
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
```

Render the strip between `ConnectionStatusBanner` and the existing input/options row (look for the `<div className="flex flex-col gap-2 p-(--composer-padding)">` block and prepend `<AttachmentStrip ... />` right above it):

```tsx
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
```

Add the "+" button to the existing left-side action cluster (next to `<ComposerOptionsMenu />` and the `FolderPicker`). Inside the `<div className="flex items-center gap-1">` that already wraps `<ComposerOptionsMenu />`:

```tsx
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="size-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground flex items-center justify-center"
                aria-label="Attach file"
                title="Attach file"
              >
                <PlusIcon className="size-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={onFilesPicked}
              />
```

Wrap the `<ComposerPrimitive.Root>` opening div in drag-and-drop listeners:

```tsx
    <ComposerPrimitive.Root
      className="aui-composer-root relative flex w-full flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault()
          setIsDragging(true)
        }
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault()
          attachments.addFiles(Array.from(e.dataTransfer.files))
        }
        setIsDragging(false)
      }}
    >
```

Add a drop-target visual below the existing children (just inside the shell div):

```tsx
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-(--composer-radius) bg-primary/10 text-sm font-medium text-primary">
            Drop to attach
          </div>
        )}
```

**Step 2: Disable Send while uploads are pending**

The existing `ComposerPrimitive.Send` auto-disables when the composer text is empty, but not when attachments are uploading. Wrap the send button's rendering with a check, or rely on `hasPending` to gate a disabled state:

Look for the `<AuiIf condition={(s) => !s.thread.isRunning}>` block containing `<ComposerPrimitive.Send asChild>`. Replace the `TooltipIconButton` with one that has `disabled={attachments.hasPending}` (or conditionally renders the disabled variant).

Exact diff depends on how `TooltipIconButton` handles `disabled`; if it passes through to the underlying button, a simple `disabled={attachments.hasPending}` prop works.

**Step 3: Typecheck + lint + build**

```bash
cd frontend && npm run typecheck && npm run lint && npm run build
```

Expected: no errors.

**Step 4: Commit**

```bash
git add frontend/app/components/assistant-ui/thread.tsx
git commit -m "feat(agent): add attach button, strip, and drag-and-drop to composer"
```

---

## Task 13: Frontend — inject `@<path>` on send (new-session path)

**Files:**
- Modify: `frontend/app/routes/agent.tsx` — `createSessionWithMessage` (around line 801)
- Modify: `frontend/app/components/assistant-ui/thread.tsx` — the composer's `onSubmit` / send intercept

**Step 1: Surface readyAttachments out of the composer**

The cleanest seam is to reuse the existing `onSend` path from `useAgentRuntime`. The runtime currently passes `message` as a plain string. Change the call site so the composer can pass an optional list of attachment paths along with it.

Look at how the runtime invokes send for *new-session* (search for `onSend` in `frontend/app/hooks/use-agent-runtime.ts`). It should end up calling the function passed by `agent.tsx` as `createSessionWithMessage`. Route the attachment paths through that seam:

- In `thread.tsx`'s `Composer`, intercept the submit event before it reaches the runtime and build the final message text:

```tsx
  const buildMessageWithAttachments = (text: string) => {
    const paths = attachmentsRef.current.readyAttachments.map((a) => `@${a.absolutePath}`)
    if (paths.length === 0) return text
    return [text.trim(), ...paths].filter(Boolean).join(" ")
  }
```

- Intercept `ComposerPrimitive.Send` — wrap the default Send button in a regular button that calls `composerRuntime.send(buildMessageWithAttachments(composerText))` and then `attachments.clear()`. Or — if assistant-ui exposes an `onSubmit` on the Root — use that.

  Pick whichever integration point already exists in this codebase; don't introduce a parallel send path. The easiest seam is usually to subscribe to the runtime's "message sent" event and rewrite the outgoing text before it's serialized, but if that's not available here, an explicit wrapper button is fine.

**Step 2: Verify the new-session path**

Open the app, create a new session, attach a small text file, type "Can you summarize this?", send. Inspect the resulting user-message bubble — it should show `Can you summarize this? @/abs/path/to/.../hello.txt`.

Verify on the backend that `go run .` logs a send with the augmented prompt text (the agent manager already logs `messageLen` — this should now include the `@<path>` tokens).

**Step 3: Verify the follow-up path**

In the same session, attach another file and send a follow-up. Same behavior.

**Step 4: Commit**

```bash
git add frontend/app/routes/agent.tsx frontend/app/components/assistant-ui/thread.tsx
git commit -m "feat(agent): inject @<path> for attachments into outgoing prompts"
```

---

## Task 14: Documentation

**Files:**
- Modify: `../my-life-db-docs/` — add/update a section under **API** or **Components** describing the attachment flow.

**Step 1: Add a short doc**

Create (or append to an existing agent doc):

```markdown
## Agent session attachments

Users can attach ephemeral files to any agent prompt via the composer. Files
are staged at `APP_DATA_DIR/tmp/agent-uploads/<uploadID>/<filename>` and
referenced in the prompt using the `@<absolutePath>` file-tag convention
that Claude Code already supports.

### API

- `POST /api/agent/attachments` (multipart, field `file`, 1 GiB cap) →
  `{ uploadID, absolutePath, filename, size, contentType }`
- `DELETE /api/agent/attachments/:uploadID` → `204` (idempotent)

### Cleanup

A background janitor sweeps the staging root every hour and removes
directories with mtime older than 30 days. No DB bookkeeping.

### Permission-mode caveat

Attachments require the agent session to be in a mode that allows reading
absolute paths outside its working directory. The app defaults
(`bypassPermissions` for Claude Code, `full-access` for Codex) cover this.
Switching a session to a stricter mode will cause the agent's Read tool to
fail on staged paths.
```

**Step 2: Commit**

```bash
cd ../my-life-db-docs
git add <the edited file>
git commit -m "docs(agent): describe session attachment flow"
```

(The docs repo is separate per top-level `CLAUDE.md` — commit there independently.)

---

## Task 15: Final verification

**Step 1: Backend — full test + vet**

```bash
cd backend && go vet ./... && go test ./... -v
```

Expected: all green.

**Step 2: Frontend — full pipeline**

```bash
cd frontend && npm run typecheck && npm run lint && npm run build
```

Expected: all green.

**Step 3: Full-stack smoke**

Build and run:

```bash
cd frontend && npm run build && cd ../backend && go run .
```

Scenarios:

1. **New-session with single attachment:** navigate to `/agent`, open new-session composer, click "+" and pick a small PDF. Chip appears, shows 100%, transitions to ready. Type "summarize this", send. User bubble shows text + `@<path>`. Agent responds and uses its Read tool on the path.
2. **Drag-and-drop multiple files:** drag 2 files onto the composer, both chips appear in order, one is an image (shows ImageIcon), one is text (shows FileIcon). Send — both paths appear in the message.
3. **Remove before send:** attach a file, then click X on the chip. Chip disappears. Verify backend: `ls $APP_DATA_DIR/tmp/agent-uploads/` should no longer contain that uploadID.
4. **1 GB limit:** try uploading a 1.5 GB file (`dd if=/dev/zero of=/tmp/big bs=1M count=1500`). Chip goes to error state; no file on disk.
5. **Active-session follow-up:** in an existing session, attach a file and send a follow-up. Same behavior as new-session.
6. **Stricter permission mode (optional):** switch the session to Claude's `default` mode, attach a file, send. The agent's Read tool should fail with a permission error — that's expected, documented behavior.

**Step 4: Report**

If all pass, prompt the user per project workflow:

> Ready to commit, push, and clean up?

Wait for the user's **"go"** before pushing. Follow the **Remote (linux)** flow in `CLAUDE.md`:

```bash
cd .worktrees/agent-attachments-design
git fetch origin && git rebase origin/main
git push origin feat/agent-attachments-design:main

cd /home/xiaoyuanzhu/my-life-db/data/projects/MyLifeDB/my-life-db
git pull --rebase origin main
git worktree remove .worktrees/agent-attachments-design
git branch -d feat/agent-attachments-design
```

---

## Risks and open questions

- **Gin multipart body size:** Gin's default `MaxMultipartMemory` is 32 MiB — this is the in-memory threshold, not the total request size limit. `http.MaxBytesReader` in the handler caps the total at 1 GiB. Verify by smoke-testing a ~500 MB file; adjust if Gin truncates.
- **Package layout for the janitor:** `server` importing `api` may introduce a cycle; Task 8 gives the fallback of moving `SweepAgentAttachments` into the `server` package.
- **Send seam in assistant-ui:** Task 13 depends on an interception point in the `@assistant-ui/react` runtime. If there's no clean hook, consider a more invasive rewrite at the `createSessionWithMessage` and WebSocket-send boundaries instead. Do whatever the codebase already favors — don't fight the library.
- **Auth on upload endpoints:** the plan assumes `/api/agent/*` is gated by an auth middleware already. Verify by checking `routes.go` — the group line (~149) should show `r.Group("/api/agent", authMiddleware)` or similar. If not, surface the gap rather than silently ignoring it.
