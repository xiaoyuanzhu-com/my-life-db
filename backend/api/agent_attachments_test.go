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

// TestUploadAttachment_TooLarge — when the request body exceeds the
// MaxBytesReader cap, the error unwraps to *http.MaxBytesError and the
// handler must return 413, not a generic 400.
func TestUploadAttachment_TooLarge(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tmpDir := t.TempDir()
	h := newAttachmentsHandler(tmpDir)

	// Override the cap via a wrapped route that installs a tiny MaxBytesReader.
	// We do this by calling UploadAttachment through a route that sets the
	// reader to a small size before invocation. To avoid changing the handler
	// API, we exercise the real path: send a body just under and just over
	// using the default cap. But 1 GiB is impractical in a unit test, so
	// instead we use httptest.NewRequest with ContentLength > cap and a body
	// that streams through MaxBytesReader, which trips on the first read.
	//
	// Use ~2 MiB payload but install a short MaxBytesReader via a wrapper.
	const testCap = 1024 // 1 KiB — tiny for test
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	fw, _ := mw.CreateFormFile("file", "big.bin")
	fw.Write(bytes.Repeat([]byte("A"), testCap*4)) // 4 KiB -> exceeds testCap
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/agent/attachments", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()

	r := gin.New()
	r.POST("/api/agent/attachments", func(c *gin.Context) {
		// Wrap with a tiny limit so we don't need a 1 GiB test body.
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, testCap)
		h.UploadAttachment(c)
	})
	r.ServeHTTP(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413, body=%s", w.Code, w.Body.String())
	}
}

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

	r := gin.New()
	r.DELETE("/api/agent/attachments/:uploadID", h.DeleteAttachment)

	// ".." as uploadID must be rejected by the handler itself.
	req := httptest.NewRequest(http.MethodDelete, "/api/agent/attachments/..", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("uploadID='..' status = %d, want 400", w.Code)
	}

	// A URL-encoded slash is decoded by Gin's router before routing, so
	// the path no longer matches :uploadID — router returns 404. Either
	// 400 (handler) or 404 (router) is an acceptable rejection.
	req = httptest.NewRequest(http.MethodDelete, "/api/agent/attachments/..%2F..", nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest && w.Code != http.StatusNotFound {
		t.Fatalf("uploadID='..%%2F..' status = %d, want 400 or 404", w.Code)
	}
}
