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
	return &attachmentsHandler{userDataDir: tmpDir}
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
		StorageID    string `json:"storageId"`
		AbsolutePath string `json:"absolutePath"`
		Filename     string `json:"filename"`
		Size         int64  `json:"size"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !validStorageID(resp.StorageID) {
		t.Fatalf("storageId not valid: %q", resp.StorageID)
	}
	if resp.Filename != "hello.txt" {
		t.Fatalf("filename = %q", resp.Filename)
	}
	if resp.Size != 8 {
		t.Fatalf("size = %d", resp.Size)
	}

	wantPath := filepath.Join(tmpDir, "sessions", resp.StorageID, "uploads", "hello.txt")
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
	// Saved path should be inside tmpDir/sessions/*/uploads/
	rootPrefix := filepath.Join(tmpDir, "sessions") + string(filepath.Separator)
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

func TestDelete_RejectsInvalidStorageID(t *testing.T) {
	tmp := t.TempDir()
	a := &attachmentsHandler{userDataDir: tmp}

	r := httptest.NewRequest("DELETE", "/x", nil)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = r
	c.Params = gin.Params{
		{Key: "storageId", Value: "../etc"},
		{Key: "filename", Value: "passwd"},
	}
	a.DeleteAttachment(c)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// --- New tests added in Task 5 ---

func TestUpload_MintsStorageIDWhenAbsent(t *testing.T) {
	gin.SetMode(gin.TestMode)
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
