# Agent Sessions Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ad-hoc storage areas (`AppDataDir/tmp/agent-uploads/<uploadID>/`, `USER_DATA_DIR/generated/<date>/`, `USER_DATA_DIR/.generated/`) with a single per-session layout `USER_DATA_DIR/sessions/<storage_id>/{uploads,generated}/` so all in-flight agent files live in one predictable place.

**Architecture:** A new `storage_id` (UUID) is allocated lazily — at the first upload, or at session create. It is stored on `agent_sessions` and reaches the agent via two channels: a `X-MLD-Session-Id` header on per-session MCP server config (used by image MCP tool to resolve write path), and an interpolated path in a per-session system prompt (used by Claude's `Write` tool for HTML render). Existing ACP session id stays as the row primary key — no rename, no frontend churn for IDs.

**Tech Stack:** Go 1.25 (Gin, SQLite, mattn/go-sqlite3, google/uuid, coder/acp-go-sdk), React 19 + TypeScript.

**Reference spec:** [docs/superpowers/specs/2026-04-28-agent-sessions-folder-design.md](../specs/2026-04-28-agent-sessions-folder-design.md)

---

### Task 1: DB migration — add `storage_id` column

**Files:**
- Create: `backend/db/migration_023_agent_session_storage_id.go`

- [ ] **Step 1: Write the migration file**

```go
package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     23,
		Description: "Add storage_id column to agent_sessions for the per-session files folder",
		Up: func(db *sql.DB) error {
			_, err := db.Exec(`ALTER TABLE agent_sessions ADD COLUMN storage_id TEXT NOT NULL DEFAULT ''`)
			return err
		},
	})
}
```

- [ ] **Step 2: Run on a fresh database to verify it applies**

Run: `cd backend && rm -rf .my-life-db && go run . &`, then `sleep 2 && sqlite3 .my-life-db/database.sqlite ".schema agent_sessions" | grep storage_id` and kill the server.
Expected: output contains `storage_id TEXT NOT NULL DEFAULT ''`

- [ ] **Step 3: Commit**

```bash
git add backend/db/migration_023_agent_session_storage_id.go
git commit -m "feat(db): add storage_id column to agent_sessions"
```

---

### Task 2: Persist `storage_id` through `CreateAgentSession` / `GetAgentSession`

**Files:**
- Modify: `backend/db/agent_sessions.go`

- [ ] **Step 1: Update `AgentSessionRecord` to include `StorageID`**

In [backend/db/agent_sessions.go](../../../backend/db/agent_sessions.go), add the field to `AgentSessionRecord`:

```go
type AgentSessionRecord struct {
	SessionID   string `json:"sessionId"`
	AgentType   string `json:"agentType"`
	WorkingDir  string `json:"workingDir"`
	Title       string `json:"title"`
	Source      string `json:"source"`
	AgentName   string `json:"agentName"`
	TriggerKind string `json:"triggerKind"`
	TriggerData string `json:"triggerData"`
	StorageID   string `json:"storageId"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
	ArchivedAt  *int64 `json:"archivedAt,omitempty"`
}
```

- [ ] **Step 2: Update `CreateAgentSession` to accept and persist `storageID`**

Change the function signature and SQL:

```go
func CreateAgentSession(sessionID, agentType, workingDir, title, source, agentName, triggerKind, triggerData, storageID string) error {
	now := NowMs()
	if source == "" {
		source = "user"
	}
	_, err := Run(
		`INSERT INTO agent_sessions (session_id, agent_type, working_dir, title, source, agent_name, trigger_kind, trigger_data, storage_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   agent_type = excluded.agent_type,
		   working_dir = excluded.working_dir,
		   title = CASE WHEN excluded.title != '' THEN excluded.title ELSE agent_sessions.title END,
		   source = excluded.source,
		   agent_name = excluded.agent_name,
		   trigger_kind = CASE WHEN excluded.trigger_kind != '' THEN excluded.trigger_kind ELSE agent_sessions.trigger_kind END,
		   trigger_data = CASE WHEN excluded.trigger_data != '' THEN excluded.trigger_data ELSE agent_sessions.trigger_data END,
		   storage_id = CASE WHEN excluded.storage_id != '' THEN excluded.storage_id ELSE agent_sessions.storage_id END,
		   updated_at = excluded.updated_at`,
		sessionID, agentType, workingDir, title, source, agentName, triggerKind, triggerData, storageID, now, now,
	)
	return err
}
```

- [ ] **Step 3: Update `GetAgentSession` to read `storage_id`**

```go
func GetAgentSession(sessionID string) (*AgentSessionRecord, error) {
	var r AgentSessionRecord
	var archivedAt sql.NullInt64
	err := GetDB().QueryRow(
		`SELECT session_id, agent_type, working_dir, title, source, agent_name, trigger_kind, trigger_data, storage_id, created_at, updated_at, archived_at
		 FROM agent_sessions WHERE session_id = ?`,
		sessionID,
	).Scan(&r.SessionID, &r.AgentType, &r.WorkingDir, &r.Title, &r.Source, &r.AgentName, &r.TriggerKind, &r.TriggerData, &r.StorageID, &r.CreatedAt, &r.UpdatedAt, &archivedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if archivedAt.Valid {
		r.ArchivedAt = &archivedAt.Int64
	}
	return &r, nil
}
```

- [ ] **Step 4: Update `ListAgentSessions` to read `storage_id`**

In the same file, find `ListAgentSessions` (and any other functions that read `agent_sessions` rows — `GetAgentSessionsByIDs`, etc.). Add `storage_id` to the SELECT column list and the corresponding `Scan(...)` calls. Keep ordering consistent with the SELECT.

- [ ] **Step 5: Run `go build ./...` to verify all callers compile**

Run: `cd backend && go build ./...`
Expected: build fails with errors about `CreateAgentSession` argument count at every call site (we'll fix in Task 9). For now, check that `db/agent_sessions.go` itself compiles: `cd backend && go build ./db/...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/db/agent_sessions.go
git commit -m "feat(db): persist storage_id on agent_sessions row"
```

---

### Task 3: Storage id minter helper

**Files:**
- Create: `backend/api/agent_storage.go`
- Test: `backend/api/agent_storage_test.go`

- [ ] **Step 1: Write the failing test**

```go
package api

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestMintStorageID(t *testing.T) {
	a := mintStorageID()
	b := mintStorageID()
	if a == "" || b == "" {
		t.Fatal("mintStorageID returned empty")
	}
	if a == b {
		t.Fatal("mintStorageID returned duplicate")
	}
	if len(a) < 32 {
		t.Fatalf("mintStorageID looks too short: %q", a)
	}
}

func TestSessionDir(t *testing.T) {
	dir := sessionDir("/data", "abc-123")
	if dir != filepath.Join("/data", "sessions", "abc-123") {
		t.Fatalf("got %q", dir)
	}
}

func TestSessionUploadsDir(t *testing.T) {
	got := sessionUploadsDir("/data", "abc-123")
	want := filepath.Join("/data", "sessions", "abc-123", "uploads")
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestSessionGeneratedDir(t *testing.T) {
	got := sessionGeneratedDir("/data", "abc-123")
	want := filepath.Join("/data", "sessions", "abc-123", "generated")
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestValidStorageID(t *testing.T) {
	if !validStorageID("abc-123_def") {
		t.Error("expected alphanumeric+dash+underscore to be valid")
	}
	if validStorageID("") {
		t.Error("empty must be invalid")
	}
	if validStorageID("..") {
		t.Error("dot-dot must be invalid")
	}
	if validStorageID("a/b") {
		t.Error("slash must be invalid")
	}
	if validStorageID(strings.Repeat("a", 200)) {
		t.Error("excessively long must be invalid")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./api/ -run 'TestMintStorageID|TestSessionDir|TestSessionUploadsDir|TestSessionGeneratedDir|TestValidStorageID' -v`
Expected: FAIL — undefined `mintStorageID`, `sessionDir`, `sessionUploadsDir`, `sessionGeneratedDir`, `validStorageID`.

- [ ] **Step 3: Write minimal implementation**

```go
package api

import (
	"path/filepath"

	"github.com/google/uuid"
)

// mintStorageID returns a fresh per-session storage id (UUIDv4).
// Used as the directory name under USER_DATA_DIR/sessions/.
func mintStorageID() string {
	return uuid.New().String()
}

// sessionDir returns USER_DATA_DIR/sessions/<storageID>.
func sessionDir(userDataDir, storageID string) string {
	return filepath.Join(userDataDir, "sessions", storageID)
}

// sessionUploadsDir returns USER_DATA_DIR/sessions/<storageID>/uploads.
func sessionUploadsDir(userDataDir, storageID string) string {
	return filepath.Join(sessionDir(userDataDir, storageID), "uploads")
}

// sessionGeneratedDir returns USER_DATA_DIR/sessions/<storageID>/generated.
func sessionGeneratedDir(userDataDir, storageID string) string {
	return filepath.Join(sessionDir(userDataDir, storageID), "generated")
}

// validStorageID rejects empty values, path traversal sequences, separators,
// and excessively long ids. Used to sanitize values that came from request
// bodies / URL params before they're joined into a filesystem path.
func validStorageID(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	if s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./api/ -run 'TestMintStorageID|TestSessionDir|TestSessionUploadsDir|TestSessionGeneratedDir|TestValidStorageID' -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/api/agent_storage.go backend/api/agent_storage_test.go
git commit -m "feat(api): storage id minter and per-session path helpers"
```

---

### Task 4: Filename collision suffix helper

**Files:**
- Modify: `backend/api/agent_storage.go`
- Modify: `backend/api/agent_storage_test.go`

- [ ] **Step 1: Write the failing test**

Append to `backend/api/agent_storage_test.go`:

```go
import (
	"os"
	// ... existing imports
)

func TestUniqueFilename_NoCollision(t *testing.T) {
	dir := t.TempDir()
	got := uniqueFilename(dir, "report.html")
	if got != "report.html" {
		t.Fatalf("got %q want report.html", got)
	}
}

func TestUniqueFilename_WithCollision(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "report.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := uniqueFilename(dir, "report.html")
	if got != "report-1.html" {
		t.Fatalf("got %q want report-1.html", got)
	}
}

func TestUniqueFilename_MultipleCollisions(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"report.html", "report-1.html", "report-2.html"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := uniqueFilename(dir, "report.html")
	if got != "report-3.html" {
		t.Fatalf("got %q want report-3.html", got)
	}
}

func TestUniqueFilename_NoExtension(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := uniqueFilename(dir, "README")
	if got != "README-1" {
		t.Fatalf("got %q want README-1", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./api/ -run TestUniqueFilename -v`
Expected: FAIL — undefined `uniqueFilename`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/api/agent_storage.go`:

```go
import (
	"os"
	"path/filepath"
	"strings"
	// ... existing imports
)

// uniqueFilename returns a filename within dir that does not yet exist on disk.
// If dir/name is free, it returns name unchanged. Otherwise it appends a
// numeric suffix before the extension: report.html -> report-1.html.
// Caller is responsible for creating dir.
func uniqueFilename(dir, name string) string {
	full := filepath.Join(dir, name)
	if _, err := os.Stat(full); os.IsNotExist(err) {
		return name
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; i < 10000; i++ {
		candidate := stem + "-" + itoa(i) + ext
		if _, err := os.Stat(filepath.Join(dir, candidate)); os.IsNotExist(err) {
			return candidate
		}
	}
	return name
}

// itoa is a tiny strconv-free integer formatter used by uniqueFilename
// (avoids pulling in strconv just for one call site).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./api/ -run TestUniqueFilename -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/api/agent_storage.go backend/api/agent_storage_test.go
git commit -m "feat(api): collision-suffix helper for staged filenames"
```

---

### Task 5: Upload handler — accept `storageId`, write to per-session uploads dir

**Files:**
- Modify: `backend/api/agent_attachments.go`
- Modify: `backend/api/agent_attachments_test.go`

- [ ] **Step 1: Write the failing test for upload-without-storageId mints one**

Add to `backend/api/agent_attachments_test.go`:

```go
func TestUpload_MintsStorageIDWhenAbsent(t *testing.T) {
	tmp := t.TempDir()
	a := &attachmentsHandler{userDataDir: tmp}

	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	fw, _ := mw.CreateFormFile("file", "hello.txt")
	fw.Write([]byte("hello"))
	mw.Close()

	r := httptest.NewRequest("POST", "/upload", body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	a.UploadAttachment(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	sid, _ := resp["storageId"].(string)
	if !validStorageID(sid) {
		t.Fatalf("response storageId not valid: %q", sid)
	}
	want := filepath.Join(tmp, "sessions", sid, "uploads", "hello.txt")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("expected file at %s: %v", want, err)
	}
}

func TestUpload_UsesProvidedStorageID(t *testing.T) {
	tmp := t.TempDir()
	a := &attachmentsHandler{userDataDir: tmp}

	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	mw.WriteField("storageId", "fixed-sid-1")
	fw, _ := mw.CreateFormFile("file", "doc.pdf")
	fw.Write([]byte("pdf-bytes"))
	mw.Close()

	r := httptest.NewRequest("POST", "/upload", body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	a.UploadAttachment(c)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if got := resp["storageId"]; got != "fixed-sid-1" {
		t.Fatalf("storageId echo = %v, want fixed-sid-1", got)
	}
	want := filepath.Join(tmp, "sessions", "fixed-sid-1", "uploads", "doc.pdf")
	if _, err := os.Stat(want); err != nil {
		t.Fatal(err)
	}
}

func TestUpload_FilenameCollision(t *testing.T) {
	tmp := t.TempDir()
	a := &attachmentsHandler{userDataDir: tmp}

	upload := func(name string) string {
		body := &bytes.Buffer{}
		mw := multipart.NewWriter(body)
		mw.WriteField("storageId", "sid-A")
		fw, _ := mw.CreateFormFile("file", name)
		fw.Write([]byte("x"))
		mw.Close()
		r := httptest.NewRequest("POST", "/upload", body)
		r.Header.Set("Content-Type", mw.FormDataContentType())
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = r
		a.UploadAttachment(c)
		var resp map[string]any
		json.Unmarshal(w.Body.Bytes(), &resp)
		return resp["filename"].(string)
	}

	if got := upload("dup.txt"); got != "dup.txt" {
		t.Errorf("first upload filename = %q want dup.txt", got)
	}
	if got := upload("dup.txt"); got != "dup-1.txt" {
		t.Errorf("second upload filename = %q want dup-1.txt", got)
	}
}

func TestUpload_RejectsInvalidStorageID(t *testing.T) {
	tmp := t.TempDir()
	a := &attachmentsHandler{userDataDir: tmp}

	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	mw.WriteField("storageId", "../etc")
	fw, _ := mw.CreateFormFile("file", "x.txt")
	fw.Write([]byte("x"))
	mw.Close()

	r := httptest.NewRequest("POST", "/upload", body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	a.UploadAttachment(c)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", w.Code, w.Body.String())
	}
}
```

Add the imports needed at the top of the test file if they aren't already there: `bytes`, `encoding/json`, `mime/multipart`, `net/http`, `net/http/httptest`, `os`, `path/filepath`, `testing`, `github.com/gin-gonic/gin`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./api/ -run 'TestUpload_' -v`
Expected: FAIL — `attachmentsHandler` has no `userDataDir`, response has no `storageId`, etc.

- [ ] **Step 3: Rewrite `attachmentsHandler` and `UploadAttachment`**

Replace the body of `backend/api/agent_attachments.go` (keep the `package api` declaration and import block updated):

```go
package api

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

const maxAttachmentSize = 1 << 30 // 1 GiB

// attachmentsHandler stages user-uploaded files for an in-flight agent session.
//
// Uploads land at:
//   USER_DATA_DIR/sessions/<storageID>/uploads/<filename>
//
// The storageID is the per-session storage id (see agent_storage.go). When the
// caller doesn't supply one (very first upload before any session exists), we
// mint a fresh id and return it; the client persists it and includes it on
// subsequent uploads + on POST /api/agent/sessions.
type attachmentsHandler struct {
	userDataDir string
}

// UploadAttachment handles POST /api/agent/attachments.
//   form fields: file (required), storageId (optional)
//   response:    { storageId, filename, absolutePath, size, contentType }
func (a *attachmentsHandler) UploadAttachment(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxAttachmentSize)

	fileHeader, err := c.FormFile("file")
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file exceeds 1 GiB limit"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing or invalid 'file' field: " + err.Error()})
		return
	}
	if fileHeader.Size > maxAttachmentSize {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file exceeds 1 GiB limit"})
		return
	}

	storageID := c.PostForm("storageId")
	if storageID == "" {
		storageID = mintStorageID()
	} else if !validStorageID(storageID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid storageId"})
		return
	}

	filename := filepath.Base(fileHeader.Filename)
	if filename == "" || filename == "." || filename == string(filepath.Separator) {
		filename = "file"
	}

	destDir := sessionUploadsDir(a.userDataDir, storageID)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		log.Error().Err(err).Str("dir", destDir).Msg("agent-attachments: mkdir failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create staging dir"})
		return
	}

	finalName := uniqueFilename(destDir, filename)
	destPath := filepath.Join(destDir, finalName)

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to open upload: " + err.Error()})
		return
	}
	defer src.Close()

	dst, err := os.Create(destPath)
	if err != nil {
		log.Error().Err(err).Str("path", destPath).Msg("agent-attachments: create failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to stage file"})
		return
	}
	written, err := io.Copy(dst, src)
	closeErr := dst.Close()
	if err != nil || closeErr != nil {
		os.Remove(destPath)
		log.Error().Err(err).Err(closeErr).Str("path", destPath).Msg("agent-attachments: write failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file"})
		return
	}

	log.Info().
		Str("storageID", storageID).
		Str("filename", finalName).
		Int64("size", written).
		Msg("agent-attachments: upload staged")

	c.JSON(http.StatusOK, gin.H{
		"storageId":    storageID,
		"filename":     finalName,
		"absolutePath": destPath,
		"size":         written,
		"contentType":  fileHeader.Header.Get("Content-Type"),
	})
}

// UploadAgentAttachment is the production shim used by the real router.
func (h *Handlers) UploadAgentAttachment(c *gin.Context) {
	inner := &attachmentsHandler{userDataDir: h.server.Cfg().UserDataDir}
	inner.UploadAttachment(c)
}
```

(The DELETE handler is rewritten in Task 6 — but to keep the build green between tasks, **also include this temporary compile-passing DELETE in Task 5's rewrite** so the file still compiles after the field rename. It will be replaced in Task 6.)

```go
// DeleteAttachment is a temporary stub kept only to keep the build green
// between Task 5 and Task 6. It accepts the old :uploadID param and is a
// no-op. Replaced in Task 6 with the per-session/per-filename version.
func (a *attachmentsHandler) DeleteAttachment(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

func (h *Handlers) DeleteAgentAttachment(c *gin.Context) {
	inner := &attachmentsHandler{userDataDir: h.server.Cfg().UserDataDir}
	inner.DeleteAttachment(c)
}
```

- [ ] **Step 4: Run upload tests to verify they pass**

Run: `cd backend && go test ./api/ -run 'TestUpload_' -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/api/agent_attachments.go backend/api/agent_attachments_test.go
git commit -m "feat(api): stage uploads under sessions/<storageId>/uploads"
```

---

### Task 6: Delete attachment endpoint — `:storageId/:filename`

**Files:**
- Modify: `backend/api/agent_attachments.go`
- Modify: `backend/api/agent_attachments_test.go`
- Modify: `backend/api/routes.go`

- [ ] **Step 1: Write failing tests**

Add to `backend/api/agent_attachments_test.go`:

```go
func TestDelete_RemovesStagedFile(t *testing.T) {
	tmp := t.TempDir()
	a := &attachmentsHandler{userDataDir: tmp}

	dir := filepath.Join(tmp, "sessions", "sid-X", "uploads")
	os.MkdirAll(dir, 0o755)
	file := filepath.Join(dir, "doc.txt")
	os.WriteFile(file, []byte("x"), 0o644)

	r := httptest.NewRequest("DELETE", "/attachments/sid-X/doc.txt", nil)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	c.Params = gin.Params{
		{Key: "storageId", Value: "sid-X"},
		{Key: "filename", Value: "doc.txt"},
	}
	a.DeleteAttachment(c)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("file should be removed; stat err=%v", err)
	}
}

func TestDelete_IdempotentMissingFile(t *testing.T) {
	tmp := t.TempDir()
	a := &attachmentsHandler{userDataDir: tmp}

	r := httptest.NewRequest("DELETE", "/attachments/sid-Y/nope.txt", nil)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	c.Params = gin.Params{
		{Key: "storageId", Value: "sid-Y"},
		{Key: "filename", Value: "nope.txt"},
	}
	a.DeleteAttachment(c)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", w.Code)
	}
}

func TestDelete_RejectsTraversal(t *testing.T) {
	tmp := t.TempDir()
	a := &attachmentsHandler{userDataDir: tmp}

	r := httptest.NewRequest("DELETE", "/x", nil)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	c.Params = gin.Params{
		{Key: "storageId", Value: "sid-Z"},
		{Key: "filename", Value: "../../etc/passwd"},
	}
	a.DeleteAttachment(c)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./api/ -run TestDelete_ -v`
Expected: FAIL — current `DeleteAttachment` reads `c.Param("uploadID")`, expects different params, and reads `appDataDir`.

- [ ] **Step 3: Rewrite `DeleteAttachment` + `DeleteAgentAttachment`**

Replace the bottom of `backend/api/agent_attachments.go`:

```go
// DeleteAttachment handles DELETE /api/agent/attachments/:storageId/:filename.
// Removes one staged file. Idempotent — returns 204 whether or not the file
// existed. Rejects path-traversal attempts in either parameter.
func (a *attachmentsHandler) DeleteAttachment(c *gin.Context) {
	storageID := c.Param("storageId")
	filename := c.Param("filename")
	if !validStorageID(storageID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid storageId"})
		return
	}
	if filename == "" || filename != filepath.Base(filename) || filename == "." || filename == ".." {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}

	full := filepath.Join(sessionUploadsDir(a.userDataDir, storageID), filename)
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		log.Error().Err(err).Str("path", full).Msg("agent-attachments: delete failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete"})
		return
	}
	log.Info().Str("storageID", storageID).Str("filename", filename).Msg("agent-attachments: upload deleted")
	c.Status(http.StatusNoContent)
}

func (h *Handlers) DeleteAgentAttachment(c *gin.Context) {
	inner := &attachmentsHandler{userDataDir: h.server.Cfg().UserDataDir}
	inner.DeleteAttachment(c)
}
```

- [ ] **Step 4: Update the route**

In [backend/api/routes.go](../../../backend/api/routes.go), find the existing DELETE route for agent attachments and change it from `:uploadID` to `:storageId/:filename`. Search for `DeleteAgentAttachment` to locate the line; the new line should look like:

```go
agentRoutes.DELETE("/attachments/:storageId/:filename", h.DeleteAgentAttachment)
```

- [ ] **Step 5: Run tests + build**

Run: `cd backend && go test ./api/ -run TestDelete_ -v && go build ./api/...`
Expected: tests PASS, build OK.

- [ ] **Step 6: Commit**

```bash
git add backend/api/agent_attachments.go backend/api/agent_attachments_test.go backend/api/routes.go
git commit -m "feat(api): delete staged uploads by storageId+filename"
```

---

### Task 7: `CreateAgentSession` API — accept optional `storageId` in request body

**Files:**
- Modify: `backend/api/agent_api.go`
- Modify: `backend/api/agent_session.go`

- [ ] **Step 1: Add `StorageID` to `SessionParams`**

In [backend/api/agent_session.go](../../../backend/api/agent_session.go), find `SessionParams` and add a field:

```go
type SessionParams struct {
	// ... existing fields ...
	StorageID string // optional; when empty, agent_manager mints one
}
```

- [ ] **Step 2: Read `storageId` from the HTTP body**

In [backend/api/agent_api.go](../../../backend/api/agent_api.go), update `CreateAgentSession` (around line 41). Add `StorageID` to the inline request struct and pass it into `SessionParams`. Also include the (potentially newly-minted) storage id in the response.

```go
func (h *Handlers) CreateAgentSession(c *gin.Context) {
	var req struct {
		Title          string `json:"title"`
		Message        string `json:"message"`
		WorkingDir     string `json:"workingDir"`
		AgentType      string `json:"agentType"`
		PermissionMode string `json:"permissionMode"`
		Model          string `json:"model"`
		StorageID      string `json:"storageId"` // optional — set when client did an upload first
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.StorageID != "" && !validStorageID(req.StorageID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid storageId"})
		return
	}

	// ... existing model resolution ...

	handle, err := h.agentMgr.CreateSession(
		context.Background(),
		SessionParams{
			AgentType:      agentTypeStr,
			WorkingDir:     req.WorkingDir,
			Title:          req.Title,
			Message:        req.Message,
			PermissionMode: req.PermissionMode,
			DefaultModel:   model,
			Source:         "user",
			StorageID:      req.StorageID,
		},
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to create agent session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create agent session: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":         handle.ID,
		"agentType":  agentTypeStr,
		"workingDir": req.WorkingDir,
		"title":      req.Title,
		"storageId":  handle.StorageID,
	})
}
```

- [ ] **Step 3: Add `StorageID` to `SessionHandle`**

In [backend/api/agent_session.go](../../../backend/api/agent_session.go), find `SessionHandle` and add `StorageID string`. (The value is filled by `agent_manager.CreateSession` in Task 8.)

- [ ] **Step 4: Build the package**

Run: `cd backend && go build ./api/...`
Expected: builds successfully (or fails only inside `agent_manager.go`, which we'll fix in Task 8).

- [ ] **Step 5: Commit**

```bash
git add backend/api/agent_api.go backend/api/agent_session.go
git commit -m "feat(api): accept and return storageId on POST /api/agent/sessions"
```

---

### Task 8: `agent_manager.CreateSession` — mint id, build per-session McpServers + SystemPrompt, persist

**Files:**
- Modify: `backend/api/agent_manager.go`
- Modify: `backend/server/server.go`

- [ ] **Step 1: Update `buildAgentSystemPrompt` to take a storage id**

In [backend/server/server.go](../../../backend/server/server.go) at line ~779, change:

```go
func buildAgentSystemPrompt(dataDir string) string {
```
to:
```go
func buildAgentSystemPrompt(dataDir, storageID string) string {
```

Replace the HTML render section (currently mentions `.generated`) so the on-disk path and iframe src use the per-session location:

```go
	return `When the user asks for a chart, diagram, or visualization, return it as a fenced code block. The frontend auto-renders these — do not describe the output unless asked.

Two formats are supported:
- Mermaid code blocks for flowcharts, sequence diagrams, Gantt charts, ER diagrams, etc.
- HTML code blocks for anything richer or interactive (data-driven charts, styled layouts, computed tables). These render in a sandboxed iframe with scripts enabled.

Prefer mermaid when it can express the visualization. Use HTML when it cannot.

HTML output must be mobile-friendly and responsive — use relative units, flexbox/grid, and ensure readability on small screens.

## Large HTML visualizations (file-based)

When HTML output would exceed roughly 50 lines (complex dashboards, multi-slide presentations, data-heavy charts), do NOT inline it. Use the file-based approach instead:

1. Create the directory: mkdir -p ` + dataDir + `/sessions/` + storageID + `/generated
2. Write the full HTML to ` + dataDir + `/sessions/` + storageID + `/generated/<descriptive-name>.html using the Write tool
3. Return a small HTML code block wrapper that loads the file:

` + "```html" + `
<html>
<head><style>
  * { margin: 0; padding: 0; }
  body, html { width: 100%; height: 100%; overflow: hidden; }
  iframe { width: 100%; height: 100%; border: none; }
</style></head>
<body>
  <iframe src="/raw/sessions/` + storageID + `/generated/<descriptive-name>.html"></iframe>
</body>
</html>
` + "```" + `

IMPORTANT: Always write files to ` + dataDir + `/sessions/` + storageID + `/generated/ (absolute path). The iframe src must use /raw/sessions/` + storageID + `/generated/ (the /raw/ endpoint serves files relative to the data directory).

This keeps the LLM response small (saving tokens and latency) while the frontend renders the full visualization by loading it from the server via the /raw/ endpoint.

Use descriptive filenames: dashboard-sleep-trends.html, report-quarterly.html, chart-activity-by-month.html.

**Versioning rule:** When the user asks to modify a previously generated HTML file, always write to a NEW file with a version suffix (e.g., -v2, -v3). Never overwrite the original — it is still referenced earlier in the conversation and must remain intact so the user can see what changed and why.

For small visualizations (under ~50 lines), inline HTML code blocks are fine — no need for a file.

` /* … keep the rest of the existing prompt unchanged … */
```

Keep everything below the HTML render section intact (auto-run agents, etc.). At the original call site (line ~364), the call `buildAgentSystemPrompt(cfg.UserDataDir)` no longer compiles because we don't have a storage id at agent-client init time. **Remove the `SystemPrompt` field from the call to `agentsdk.NewClient`**:

```go
s.agentClient = agentsdk.NewClient(agentsdk.SessionConfig{
    McpServers:   mcpServers,  // also remove this in next sub-step
}, ccAgent, codexAgent, qwenAgent, geminiAgent, opencodeAgent)
```

Then remove `McpServers` too — both are now built per-session in `agent_manager.go`. The `agentsdk.SessionConfig` struct passed here becomes empty (zero value); leave the call as `agentsdk.NewClient(agentsdk.SessionConfig{}, …)`. The `mcpServers` local variable + `Build MCP servers` block above can be deleted in this same edit.

- [ ] **Step 2: Build the per-session config inside `agent_manager.go:CreateSession`**

In [backend/api/agent_manager.go](../../../backend/api/agent_manager.go), find `CreateSession` (~line 327). Just before the `m.agentClient.CreateSession(...)` call (around line 384), insert:

```go
	storageID := params.StorageID
	if storageID == "" {
		storageID = mintStorageID()
	} else if !validStorageID(storageID) {
		return nil, fmt.Errorf("invalid storageId: %q", storageID)
	}

	mcpToken := m.server.MCPToken()
	port := m.server.Cfg().Port
	mcpServers := []acp.McpServer{
		{
			Http: &acp.McpServerHttpInline{
				Name: "explore",
				Type: "http",
				Url:  fmt.Sprintf("http://localhost:%d/api/explore/mcp", port),
				Headers: []acp.HttpHeader{
					{Name: "Authorization", Value: "Bearer " + mcpToken},
				},
			},
		},
		{
			Http: &acp.McpServerHttpInline{
				Name: "mylifedb-builtin",
				Type: "http",
				Url:  fmt.Sprintf("http://localhost:%d/api/agent/mcp", port),
				Headers: []acp.HttpHeader{
					{Name: "Authorization", Value: "Bearer " + mcpToken},
					{Name: "X-MLD-Session-Id", Value: storageID},
				},
			},
		},
	}
	systemPrompt := buildAgentSystemPrompt(m.server.Cfg().UserDataDir, storageID)
```

(Add `acp "github.com/coder/acp-go-sdk"` and `"fmt"` to the imports of `agent_manager.go` if not already there. Use the existing alias if a different one is in use; check the top of the file.)

You'll need accessors on the server for `MCPToken()` and `Cfg().Port`. If `MCPToken()` isn't already exposed, add it in [backend/server/server.go](../../../backend/server/server.go):

```go
func (s *Server) MCPToken() string { return s.mcpToken }
```

Then update the `m.agentClient.CreateSession(...)` call to pass them:

```go
	sess, err := m.agentClient.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:        agentType,
		Mode:         params.PermissionMode,
		WorkingDir:   params.WorkingDir,
		Env:          sessionEnv,
		McpServers:   mcpServers,
		SystemPrompt: systemPrompt,
	})
```

- [ ] **Step 3: Persist the storage id and pass it back via `SessionHandle`**

In the same function, after `sessionID := sess.ID()`, update the DB call:

```go
	if err := db.CreateAgentSession(sessionID, agentTypeStr, params.WorkingDir, params.Title, params.Source, params.AgentName, params.TriggerKind, params.TriggerData, storageID); err != nil {
```

And later when constructing `SessionHandle`, fill in `StorageID: storageID`.

- [ ] **Step 4: Build to flush remaining call sites**

Run: `cd backend && go build ./...`

Two callers also pass to `db.CreateAgentSession`. Find them with `grep -rn "db.CreateAgentSession" backend/` and add an empty `""` (or appropriate value) as the trailing arg. The auto-run path may want to mint its own storage id — for the first cut, pass `""` (the row ends up with empty storage id; it's a session that will never use uploads/generated/, which is correct for cron-driven agents).

```bash
grep -rn "db.CreateAgentSession" backend/
```

Update each call so it ends with the new `storageID` parameter.

- [ ] **Step 5: Test the full backend builds and unit tests pass**

Run: `cd backend && go build ./... && go test ./api/... ./db/... -v`
Expected: build OK, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/api/agent_manager.go backend/api/agent_session.go backend/server/server.go
git commit -m "feat(agent): per-session McpServers + SystemPrompt with storage id"
```

---

### Task 9: MCP handler — read `X-MLD-Session-Id`, plumb via gin context

**Files:**
- Modify: `backend/agentrunner/mcp.go`
- Modify: `backend/agentrunner/mcp_test.go`

- [ ] **Step 1: Write failing test that header is read and exposed**

Add to [backend/agentrunner/mcp_test.go](../../../backend/agentrunner/mcp_test.go):

```go
func TestHandleMCP_PassesSessionIDIntoContext(t *testing.T) {
	var seen string
	h := NewMCPHandler(New(Config{}), "")
	h.ImageGen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
		seen, _ = ctx.Value(ctxKeyMLDSessionID).(string)
		return &ImageGenResult{AbsPath: "/tmp/x.png", RelPath: "x.png", Bytes: 1}, nil
	}
	r := newTestRouter(h)

	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generateImage","arguments":{"prompt":"hi"}}}`
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	req.Header.Set("X-MLD-Session-Id", "sid-from-header")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	if seen != "sid-from-header" {
		t.Fatalf("ctx session id = %q, want sid-from-header", seen)
	}
}
```

(Add `context` and `strings` and `net/http/httptest` imports if not present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./agentrunner/ -run TestHandleMCP_PassesSessionIDIntoContext -v`
Expected: FAIL — `ctxKeyMLDSessionID` undefined and the value isn't injected.

- [ ] **Step 3: Implement context injection**

In [backend/agentrunner/mcp.go](../../../backend/agentrunner/mcp.go), add near the top (after imports):

```go
type ctxKey string

// ctxKeyMLDSessionID is the gin/context.Context key under which the MCP
// handler stashes the value of the X-MLD-Session-Id request header so tool
// implementations (image gen / edit / future artifact tools) can resolve the
// per-session destination directory.
const ctxKeyMLDSessionID ctxKey = "mldSessionID"
```

In `HandleMCP` (around line 74), after the auth check, read the header and stash it on the gin request context:

```go
	if sid := c.GetHeader("X-MLD-Session-Id"); sid != "" {
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), ctxKeyMLDSessionID, sid))
	}
```

In `callGenerateImage` and `callEditImage`, change:

```go
	ctx, cancel := context.WithTimeout(context.Background(), imageCallTimeout)
```
to:
```go
	ctx, cancel := context.WithTimeout(c.Request.Context(), imageCallTimeout)
```

This requires passing the gin context through. Update the call sites in `handleToolsCall` and the function signatures of `callGenerateImage`/`callEditImage` to accept `c *gin.Context` (or `context.Context`) instead of just `id`. Easiest: change `handleToolsCall(req)` to `handleToolsCall(c *gin.Context, req)` and pass `c` along; threading touches `handleRequest` too. Look at the existing call chain in [agentrunner/mcp.go](../../../backend/agentrunner/mcp.go) and add a `c *gin.Context` param consistently.

If that threading is too invasive, an acceptable alternative is to store the session id in a sync.Map keyed by request — but the context approach is cleaner. Pick one and document it in a one-line comment above the new field.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test ./agentrunner/ -run TestHandleMCP_PassesSessionIDIntoContext -v`
Expected: PASS.

- [ ] **Step 5: Run the full agentrunner test suite to verify no regressions**

Run: `cd backend && go test ./agentrunner/ -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/agentrunner/mcp.go backend/agentrunner/mcp_test.go
git commit -m "feat(mcp): plumb X-MLD-Session-Id header into tool-call context"
```

---

### Task 10: Image gen — write to per-session `generated/` (no date subdir)

**Files:**
- Modify: `backend/agentrunner/image.go`
- Modify: `backend/agentrunner/mcp.go`
- Modify: `backend/agentrunner/image_test.go`

- [ ] **Step 1: Write failing test for new path layout**

Add to [backend/agentrunner/image_test.go](../../../backend/agentrunner/image_test.go):

```go
func TestWriteImageFromResponse_PerSessionPath(t *testing.T) {
	tmp := t.TempDir()
	gc := ImageGenConfig{
		UserDataDir: tmp,
		StorageID:   "sid-Q",
		Now:         func() time.Time { return time.Date(2026, 4, 28, 0, 0, 0, 0, time.UTC) },
	}
	body := encodeFakeImageResponse(t, "img1") // helper that builds a valid b64-png JSON response — see existing tests
	res, err := writeImageFromResponse(body, gc, "my-prompt", "generated")
	if err != nil {
		t.Fatal(err)
	}
	wantDir := filepath.Join(tmp, "sessions", "sid-Q", "generated")
	if !strings.HasPrefix(res.AbsPath, wantDir+string(filepath.Separator)) {
		t.Fatalf("AbsPath = %q, want under %q", res.AbsPath, wantDir)
	}
	if !strings.HasPrefix(res.RelPath, "sessions/sid-Q/generated/") {
		t.Fatalf("RelPath = %q, want under sessions/sid-Q/generated/", res.RelPath)
	}
	if strings.Contains(res.RelPath, "2026-04-28") {
		t.Fatalf("RelPath %q should not include a date subdir", res.RelPath)
	}
}

func TestWriteImageFromResponse_RequiresStorageID(t *testing.T) {
	tmp := t.TempDir()
	gc := ImageGenConfig{UserDataDir: tmp /* StorageID intentionally empty */}
	body := encodeFakeImageResponse(t, "img2")
	if _, err := writeImageFromResponse(body, gc, "prompt", "generated"); err == nil {
		t.Fatal("expected error when StorageID empty")
	}
}
```

If `encodeFakeImageResponse` doesn't exist, look for the equivalent helper used by existing image tests (probably defined inline) and copy the pattern. The shape needed is `{"data":[{"b64_json":"<base64-encoded-1x1-png>","revised_prompt":""}]}`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./agentrunner/ -run TestWriteImageFromResponse_ -v`
Expected: FAIL — `StorageID` field missing on `ImageGenConfig`; current path uses `generated/<date>/`.

- [ ] **Step 3: Update `ImageGenConfig`, `validateConfig`, `writeImageFromResponse`**

In [backend/agentrunner/image.go](../../../backend/agentrunner/image.go):

```go
type ImageGenConfig struct {
	HTTPClient  *http.Client
	BaseURL     string
	APIKey      string
	UserDataDir string
	StorageID   string // per-session storage id; required at write time
	Model       string
	Now         func() time.Time
}
```

In `validateConfig`, add:

```go
	if gc.StorageID == "" {
		return fmt.Errorf("StorageID not set (X-MLD-Session-Id header missing on MCP request)")
	}
```

Replace the `day := …; dayDir := filepath.Join(...)` block in `writeImageFromResponse` with:

```go
	destDir := filepath.Join(gc.UserDataDir, "sessions", gc.StorageID, "generated")
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", destDir, err)
	}

	slug := slugifyForFile(slugSrc)
	if slug == "" {
		slug = "image"
	}
	sum := sha256.Sum256(pngBytes)
	short := hex.EncodeToString(sum[:])[:6]
	var name string
	if opTag == "" || opTag == "generated" {
		name = fmt.Sprintf("%s-%s.png", slug, short)
	} else {
		name = fmt.Sprintf("%s-%s-%s.png", opTag, slug, short)
	}
	absPath := filepath.Join(destDir, name)
	if err := os.WriteFile(absPath, pngBytes, 0o644); err != nil {
		return nil, fmt.Errorf("writing %s: %w", absPath, err)
	}
	return &ImageGenResult{
		AbsPath:       absPath,
		RelPath:       filepath.ToSlash(filepath.Join("sessions", gc.StorageID, "generated", name)),
		Bytes:         len(pngBytes),
		RevisedPrompt: parsed.Data[0].RevisedPrompt,
	}, nil
```

Also update the doc comments at the top of `writeImageFromResponse`, `GenerateImage`, and `EditImage` to reference the new path.

The `Now func() time.Time` field becomes unused for path generation but may still be used elsewhere — leave it. Don't delete unless `go vet` flags it.

- [ ] **Step 4: Wire `StorageID` from MCP context into the default `ImageGen` / `ImageEdit` lambdas**

In [backend/agentrunner/mcp.go](../../../backend/agentrunner/mcp.go) `callGenerateImage`, change the default `gen` lambda:

```go
	gen := m.ImageGen
	if gen == nil {
		gen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
			cfg := config.Get()
			sid, _ := ctx.Value(ctxKeyMLDSessionID).(string)
			return GenerateImage(ctx, ImageGenConfig{
				BaseURL:     cfg.AgentBaseURL,
				APIKey:      cfg.AgentAPIKey,
				UserDataDir: cfg.UserDataDir,
				StorageID:   sid,
			}, req)
		}
	}
```

Same change in `callEditImage` for the `edit` lambda — read `sid` from `ctx` and pass it as `StorageID`.

- [ ] **Step 5: Run tests + build**

Run: `cd backend && go test ./agentrunner/ -v && go build ./...`
Expected: all PASS, build OK. (Existing image tests that didn't set `StorageID` will fail; update them to set `StorageID: "test-sid"` on their `ImageGenConfig{}` instances.)

- [ ] **Step 6: Commit**

```bash
git add backend/agentrunner/image.go backend/agentrunner/mcp.go backend/agentrunner/image_test.go
git commit -m "feat(agentrunner): write images to sessions/<sid>/generated/"
```

---

### Task 11: Update MCP tool descriptions (LLM-facing strings)

**Files:**
- Modify: `backend/agentrunner/mcp.go`

- [ ] **Step 1: Update three description strings**

In [backend/agentrunner/mcp.go](../../../backend/agentrunner/mcp.go), update the three call sites that currently say `USER_DATA_DIR/generated/<date>/`:

Line ~30 (file header comment):
```
//   - generateImage: generates an image via gpt-image-2 through the configured
//     LiteLLM gateway (AGENT_BASE_URL / AGENT_API_KEY) and saves it under
//     USER_DATA_DIR/sessions/<storage-id>/generated/. The storage id is
//     resolved from the X-MLD-Session-Id request header.
```

Line ~349 (generateImage description):
```go
"description": "Generate a new image from a text prompt using gpt-image-2. " +
    "The image is saved under the current session's generated/ folder " +
    "(USER_DATA_DIR/sessions/<storage-id>/generated/) and the frontend " +
    "renders it inline in the conversation. Use this whenever the user asks for an icon, " +
    "illustration, mockup, diagram, or any visual asset — do NOT write Python/SVG code to fake " +
    "an image when this tool is available.",
```

Line ~391 (editImage description):
```go
"description": "Edit an existing image using gpt-image-2. The source image is read from disk by " +
    "absolute path. Use for changing colors, adding/removing elements, applying styles, or " +
    "inpainting (with an optional mask). Output is saved alongside generated images at " +
    "USER_DATA_DIR/sessions/<storage-id>/generated/edited-<slug>-<hash>.png and rendered inline in the conversation.",
```

- [ ] **Step 2: Build and run existing tests**

Run: `cd backend && go test ./agentrunner/ -v`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/agentrunner/mcp.go
git commit -m "docs(mcp): update image tool descriptions for per-session path"
```

---

### Task 12: Remove `.generated` special handling

**Files:**
- Modify: `backend/fs/pathfilter.go`
- Modify: `backend/fs/pathfilter_test.go`
- Modify: `backend/fs/validation_test.go`
- Modify: `backend/skills/create-auto-agent.md`

- [ ] **Step 1: Remove the `.generated` mention from the pathfilter comment**

In [backend/fs/pathfilter.go](../../../backend/fs/pathfilter.go) around line 57, find the comment that names `.generated` as an "app-relevant dot-dir" exception. Either remove `.generated` from the comment or, if removing makes the comment trivial, delete the comment entirely.

- [ ] **Step 2: Remove `.generated`-specific tests**

In [backend/fs/pathfilter_test.go](../../../backend/fs/pathfilter_test.go) at lines 179-180, delete the assertion:

```go
	if f.IsExcludedEntry(".generated", false) {
		t.Error(".generated should be visible in tree")
	}
```

In [backend/fs/validation_test.go](../../../backend/fs/validation_test.go) at line 68, delete the table row:

```go
		{".generated/report.html", false, "should NOT exclude .generated"},
```

- [ ] **Step 3: Update the auto-agent skill doc**

In [backend/skills/create-auto-agent.md](../../../backend/skills/create-auto-agent.md):

Line ~116: change the glob exclusion list — remove `.generated/` from the exclusion (it's no longer special). The line currently mentions `'agents/', '.*', '.generated/'` — drop `.generated/`.

Line ~235: in the "Over-broad globs" pitfall, drop the `.generated/` reference. The remaining example list (`every digest output, thumbnail, ... and more`) is still valid as-is.

- [ ] **Step 4: Run the fs tests to verify no breakage**

Run: `cd backend && go test ./fs/... -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/fs/pathfilter.go backend/fs/pathfilter_test.go backend/fs/validation_test.go backend/skills/create-auto-agent.md
git commit -m "chore(fs): drop .generated special-case (no longer used)"
```

---

### Task 13: Frontend — pass `storageId` on uploads + receive in response

**Files:**
- Modify: `frontend/app/lib/agent-attachments.ts`

- [ ] **Step 1: Read the current upload client to understand the call shape**

Run: `cat frontend/app/lib/agent-attachments.ts`
Note the existing function signatures for upload and delete. Identify where `uploadID` is used by callers (search the frontend with `grep -rn uploadID frontend/app/`).

- [ ] **Step 2: Update the upload function**

The upload helper (around lines 32-43 of [frontend/app/lib/agent-attachments.ts](../../../frontend/app/lib/agent-attachments.ts)) currently posts to `/api/agent/attachments` with just the file. Change the signature to accept an optional `storageId` and to return `{ storageId, filename, absolutePath, size, contentType }` — replacing the old `uploadID`-keyed shape.

```ts
export interface UploadAttachmentResult {
  storageId: string
  filename: string
  absolutePath: string
  size: number
  contentType: string
}

export async function uploadAgentAttachment(
  file: File,
  opts?: { storageId?: string; onProgress?: (pct: number) => void }
): Promise<UploadAttachmentResult> {
  const form = new FormData()
  form.append("file", file)
  if (opts?.storageId) form.append("storageId", opts.storageId)

  // ...keep the existing XHR-based progress reporting if present;
  // resolve with parsed JSON shaped like UploadAttachmentResult.
}
```

Update the in-memory state that was tracking `uploadID` to track `{ storageId, filename }` instead. The deletion call site (around line 69) becomes:

```ts
await fetchWithRefresh(
  `/api/agent/attachments/${encodeURIComponent(storageId)}/${encodeURIComponent(filename)}`,
  { method: "DELETE" }
)
```

- [ ] **Step 3: Update callers**

`grep -rn "uploadID\|uploadAgentAttachment\|deleteAgentAttachment" frontend/app/` — for each call site, replace `uploadID` with `{ storageId, filename }`. Most call sites are in components that compose attachments before sending a message. They need to:

- Track a single `storageId` per draft message (initialize to `null`; set from the first upload's response).
- On subsequent uploads in the same draft, pass the existing `storageId`.
- On send (Task 14), include `storageId` in the create-session body.

- [ ] **Step 4: Verify the frontend type-checks and builds**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/
git commit -m "feat(frontend): track storageId for agent uploads"
```

---

### Task 14: Frontend — pass `storageId` on session create

**Files:**
- Modify: `frontend/app/routes/agent.tsx`

- [ ] **Step 1: Find the create-session call**

Run: `grep -n "/api/agent/sessions" frontend/app/routes/agent.tsx`
The POST is around line 831:

```ts
const response = await api.post('/api/agent/sessions', {
  title, message, workingDir, agentType, permissionMode, model,
})
```

- [ ] **Step 2: Add `storageId` to the body and consume it from the response**

Change to:

```ts
const response = await api.post('/api/agent/sessions', {
  title, message, workingDir, agentType, permissionMode, model,
  storageId: draftStorageId ?? undefined,
})
// response.data.storageId is the canonical id (server may have minted one if we
// didn't send any); cache it on the session if downstream features need it.
```

The `draftStorageId` is the value from Task 13's draft state — `null` when no upload happened, otherwise the storage id minted by the first upload.

- [ ] **Step 3: Verify typecheck + build + dev**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: PASS.

Then start the dev server and confirm the page loads without console errors:
```bash
cd frontend && npm run dev
# in another shell, after the build prints "Local: http://localhost:12345"
curl -s http://localhost:12345/agent | head -20
```
Expected: HTML response.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/routes/agent.tsx
git commit -m "feat(frontend): include storageId on session create POST"
```

---

### Task 15: Manual integration verification

**Files:** none (verification only)

- [ ] **Step 1: Build everything**

```bash
cd frontend && npm run build
cd ../backend && go build .
```
Expected: both succeed.

- [ ] **Step 2: Start the backend on a fresh data dir**

```bash
cd backend && rm -rf .my-life-db && APP_DATA_DIR=.my-life-db USER_DATA_DIR=./testdata-userdir go run .
```
Open `http://localhost:12345/agent` in a browser.

- [ ] **Step 3: Verify upload-then-send flow**

1. Open the agent UI.
2. Drag/drop a file into the composer (without sending a message yet).
3. In the network panel, confirm `POST /api/agent/attachments` returned a `storageId` in the JSON body.
4. On disk: `ls testdata-userdir/sessions/<that-storage-id>/uploads/` — the file should be there.
5. Type and send a message.
6. In the network panel, confirm `POST /api/agent/sessions` body included the same `storageId`, and the response echoed it.
7. SQL: `sqlite3 .my-life-db/database.sqlite "SELECT session_id, storage_id FROM agent_sessions ORDER BY created_at DESC LIMIT 1"` — confirm the row has the storage id populated.

- [ ] **Step 4: Verify image gen lands in the per-session dir**

1. In the agent chat, send "generate an image of a red apple".
2. Wait for the image to render inline.
3. On disk: `ls testdata-userdir/sessions/<storage-id>/generated/` — should contain a `.png`.
4. Confirm there is no `testdata-userdir/generated/<date>/` directory created by this run.

- [ ] **Step 5: Verify HTML render lands in the per-session dir**

1. Send "make me a colorful HTML dashboard with three charts of fake data" (or any prompt that triggers the >50-line HTML branch).
2. Confirm the iframe in the response loads via `/raw/sessions/<storage-id>/generated/<name>.html`.
3. On disk: `ls testdata-userdir/sessions/<storage-id>/generated/` — should now include the HTML file.
4. Confirm there is no `testdata-userdir/.generated/` directory.

- [ ] **Step 6: Verify session-create-without-upload still works**

1. Open a fresh agent chat (no file upload).
2. Send a message.
3. Confirm `POST /api/agent/sessions` request had no `storageId`, response had a server-minted `storageId`.
4. SQL: confirm the row has a non-empty `storage_id`.

- [ ] **Step 7: Stop the server and clean up the test fixture**

```bash
# kill the running server, then:
cd backend && rm -rf .my-life-db testdata-userdir
```

- [ ] **Step 8: No commit needed** — this task only validates.

---

## Summary

After all tasks: a single new top-level folder `USER_DATA_DIR/sessions/<storage-id>/{uploads,generated}/` holds all in-flight agent files; the storage id is allocated lazily by upload or session-create; the agent learns the path via per-session system prompt (HTML render via `Write`) and per-session MCP header (image gen via `generateImage`/`editImage`); old code paths (`AppDataDir/tmp/agent-uploads/`, `USER_DATA_DIR/generated/<date>/`, `.generated/` special handling) are removed.
