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
