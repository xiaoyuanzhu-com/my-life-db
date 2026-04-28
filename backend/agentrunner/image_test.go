package agentrunner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// 1x1 transparent PNG; small payload that's easy to base64 in tests.
var tinyPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
	0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
	0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
}

// imageReqCapture records what arrived at the mock server.
type imageReqCapture struct {
	Path  string
	Auth  string
	Body  map[string]any    // for /images/generations (JSON)
	Form  map[string]string // for /images/edits (multipart fields)
	Files map[string]struct {
		Filename string
		MimeType string
		Bytes    []byte
	}
	Calls int
}

func newMockImageServer(t *testing.T) (*httptest.Server, *imageReqCapture) {
	t.Helper()
	cap := &imageReqCapture{
		Form: map[string]string{},
		Files: map[string]struct {
			Filename string
			MimeType string
			Bytes    []byte
		}{},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.Calls++
		cap.Path = r.URL.Path
		cap.Auth = r.Header.Get("Authorization")

		ct := r.Header.Get("Content-Type")
		mt, params, _ := mime.ParseMediaType(ct)
		switch {
		case strings.HasSuffix(r.URL.Path, "/images/generations"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			cap.Body = body
		case strings.HasSuffix(r.URL.Path, "/images/edits"):
			if mt != "multipart/form-data" {
				t.Errorf("edit endpoint expected multipart, got %q", ct)
			}
			mr := multipart.NewReader(r.Body, params["boundary"])
			for {
				part, err := mr.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Errorf("read part: %v", err)
					break
				}
				data, _ := io.ReadAll(part)
				if part.FileName() != "" {
					cap.Files[part.FormName()] = struct {
						Filename string
						MimeType string
						Bytes    []byte
					}{
						Filename: part.FileName(),
						MimeType: part.Header.Get("Content-Type"),
						Bytes:    data,
					}
				} else {
					cap.Form[part.FormName()] = string(data)
				}
			}
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"created": time.Now().Unix(),
			"data": []map[string]any{
				{
					"b64_json":       base64.StdEncoding.EncodeToString(tinyPNG),
					"revised_prompt": "model rewrote: " + cap.Path,
					"url":            nil,
				},
			},
			"usage": map[string]any{
				"input_tokens":  31,
				"output_tokens": 196,
				"total_tokens":  227,
			},
		})
	}))
	t.Cleanup(srv.Close)
	return srv, cap
}

// --- GenerateImage --------------------------------------------------------

func TestGenerateImage_HappyPath(t *testing.T) {
	srv, cap := newMockImageServer(t)
	dir := t.TempDir()
	fixedTime := time.Date(2026, 4, 26, 12, 0, 0, 0, time.UTC)

	res, err := GenerateImage(context.Background(), ImageGenConfig{
		BaseURL:     srv.URL,
		APIKey:      "test-key",
		UserDataDir: dir,
		StorageID:   "test-sid",
		Now:         func() time.Time { return fixedTime },
	}, ImageGenRequest{
		Prompt: "a tiny apple icon",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cap.Auth != "Bearer test-key" {
		t.Errorf("Authorization = %q, want Bearer test-key", cap.Auth)
	}
	if cap.Body["model"] != "gpt-image-2" {
		t.Errorf("model = %v, want gpt-image-2", cap.Body["model"])
	}
	if cap.Body["size"] != "1024x1024" {
		t.Errorf("default size = %v, want 1024x1024", cap.Body["size"])
	}
	if cap.Body["quality"] != "medium" {
		t.Errorf("default quality = %v, want medium", cap.Body["quality"])
	}
	if v := cap.Body["n"]; v != float64(1) {
		t.Errorf("n = %v, want 1", v)
	}

	// Spec check: gpt-image-2 does not accept response_format.
	// Sending it causes a 400, so the request body MUST NOT contain it.
	if _, present := cap.Body["response_format"]; present {
		t.Errorf("request body must not include response_format for gpt-image-2; got %v", cap.Body["response_format"])
	}
	if _, present := cap.Body["background"]; present {
		t.Errorf("background was not requested but is present in body: %v", cap.Body["background"])
	}

	wantDir := filepath.Join(dir, "sessions", "test-sid", "generated")
	if !strings.HasPrefix(res.AbsPath, wantDir) {
		t.Errorf("AbsPath = %q, want under %q", res.AbsPath, wantDir)
	}
	if !strings.Contains(filepath.Base(res.AbsPath), "a-tiny-apple-icon") {
		t.Errorf("filename %q does not contain slug", filepath.Base(res.AbsPath))
	}
	on, err := os.ReadFile(res.AbsPath)
	if err != nil {
		t.Fatalf("file not written: %v", err)
	}
	if len(on) != len(tinyPNG) {
		t.Errorf("file bytes = %d, want %d", len(on), len(tinyPNG))
	}
	if res.RevisedPrompt == "" {
		t.Errorf("expected RevisedPrompt to be parsed from response, got empty")
	}
	wantRelPrefix := "sessions/test-sid/generated/"
	if !strings.HasPrefix(res.RelPath, wantRelPrefix) {
		t.Errorf("RelPath = %q, want prefix %q", res.RelPath, wantRelPrefix)
	}
	if strings.Contains(res.RelPath, "\\") {
		t.Errorf("RelPath = %q must use forward slashes for /raw/ URL use", res.RelPath)
	}
}

func TestGenerateImage_OverridesPassThrough(t *testing.T) {
	srv, cap := newMockImageServer(t)
	dir := t.TempDir()

	_, err := GenerateImage(context.Background(), ImageGenConfig{
		BaseURL:     srv.URL,
		APIKey:      "k",
		UserDataDir: dir,
		StorageID:   "test-sid",
	}, ImageGenRequest{
		Prompt:     "test",
		Size:       "1536x1024",
		Quality:    "high",
		Background: "transparent",
		Filename:   "my-image",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cap.Body["size"] != "1536x1024" {
		t.Errorf("size = %v, want 1536x1024", cap.Body["size"])
	}
	if cap.Body["quality"] != "high" {
		t.Errorf("quality = %v, want high", cap.Body["quality"])
	}
	if cap.Body["background"] != "transparent" {
		t.Errorf("background = %v, want transparent", cap.Body["background"])
	}
}

func TestGenerateImage_FilenameHintUsed(t *testing.T) {
	srv, _ := newMockImageServer(t)
	dir := t.TempDir()

	res, err := GenerateImage(context.Background(), ImageGenConfig{
		BaseURL:     srv.URL,
		APIKey:      "k",
		UserDataDir: dir,
		StorageID:   "test-sid",
	}, ImageGenRequest{
		Prompt:   "anything goes here",
		Filename: "Custom Name!",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	base := filepath.Base(res.AbsPath)
	if !strings.HasPrefix(base, "custom-name-") {
		t.Errorf("filename %q does not start with slug of filename hint", base)
	}
}

func TestGenerateImage_MissingConfigReturnsError(t *testing.T) {
	cases := []struct {
		name string
		gc   ImageGenConfig
	}{
		{"no base url", ImageGenConfig{APIKey: "k", UserDataDir: t.TempDir(), StorageID: "test-sid"}},
		{"no api key", ImageGenConfig{BaseURL: "http://x", UserDataDir: t.TempDir(), StorageID: "test-sid"}},
		{"no user data dir", ImageGenConfig{BaseURL: "http://x", APIKey: "k", StorageID: "test-sid"}},
		{"no storage id", ImageGenConfig{BaseURL: "http://x", APIKey: "k", UserDataDir: t.TempDir()}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := GenerateImage(context.Background(), c.gc, ImageGenRequest{Prompt: "p"})
			if err == nil {
				t.Errorf("expected error, got nil")
			}
		})
	}
}

func TestGenerateImage_EmptyPromptReturnsError(t *testing.T) {
	_, err := GenerateImage(context.Background(), ImageGenConfig{
		BaseURL:     "http://x",
		APIKey:      "k",
		UserDataDir: t.TempDir(),
	}, ImageGenRequest{Prompt: "   "})
	if err == nil {
		t.Errorf("expected error for empty prompt, got nil")
	}
}

func TestGenerateImage_HTTPErrorIsForwarded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"content policy violation"}}`))
	}))
	defer srv.Close()

	_, err := GenerateImage(context.Background(), ImageGenConfig{
		BaseURL:     srv.URL,
		APIKey:      "k",
		UserDataDir: t.TempDir(),
		StorageID:   "test-sid",
	}, ImageGenRequest{Prompt: "p"})
	if err == nil {
		t.Fatal("expected error from non-2xx response")
	}
	if !strings.Contains(err.Error(), "400") {
		t.Errorf("error %q does not include status code", err.Error())
	}
}

// --- EditImage ------------------------------------------------------------

func TestEditImage_HappyPath(t *testing.T) {
	srv, cap := newMockImageServer(t)
	dir := t.TempDir()
	fixedTime := time.Date(2026, 4, 26, 12, 0, 0, 0, time.UTC)

	src := filepath.Join(dir, "source.png")
	if err := os.WriteFile(src, tinyPNG, 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := EditImage(context.Background(), ImageGenConfig{
		BaseURL:     srv.URL,
		APIKey:      "test-key",
		UserDataDir: dir,
		StorageID:   "test-sid",
		Now:         func() time.Time { return fixedTime },
	}, ImageEditRequest{
		Prompt:    "make it blue",
		ImagePath: src,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.HasSuffix(cap.Path, "/images/edits") {
		t.Errorf("called %q, want suffix /images/edits", cap.Path)
	}
	if cap.Auth != "Bearer test-key" {
		t.Errorf("Authorization = %q", cap.Auth)
	}
	if cap.Form["model"] != "gpt-image-2" {
		t.Errorf("form model = %q", cap.Form["model"])
	}
	if cap.Form["prompt"] != "make it blue" {
		t.Errorf("form prompt = %q", cap.Form["prompt"])
	}
	if cap.Form["size"] != "1024x1024" {
		t.Errorf("form size = %q, want 1024x1024", cap.Form["size"])
	}
	if cap.Form["quality"] != "medium" {
		t.Errorf("form quality = %q, want medium", cap.Form["quality"])
	}
	if cap.Form["n"] != "1" {
		t.Errorf("form n = %q, want 1", cap.Form["n"])
	}
	img, ok := cap.Files["image"]
	if !ok {
		t.Fatalf("image part missing — got files: %v", keys(cap.Files))
	}
	if img.MimeType != "image/png" {
		t.Errorf("image part mime = %q, want image/png", img.MimeType)
	}
	if len(img.Bytes) != len(tinyPNG) {
		t.Errorf("image part bytes = %d, want %d", len(img.Bytes), len(tinyPNG))
	}
	if _, hasMask := cap.Files["mask"]; hasMask {
		t.Errorf("mask part present but was not requested")
	}

	// Output file goes under sessions/<sid>/generated/edited-<slug>-<hash>.png.
	wantDir := filepath.Join(dir, "sessions", "test-sid", "generated")
	if !strings.HasPrefix(res.AbsPath, wantDir) {
		t.Errorf("AbsPath = %q, want under %q", res.AbsPath, wantDir)
	}
	if !strings.HasPrefix(filepath.Base(res.AbsPath), "edited-") {
		t.Errorf("edit filename %q must start with 'edited-'", filepath.Base(res.AbsPath))
	}
	if !strings.Contains(filepath.Base(res.AbsPath), "source-edited") {
		t.Errorf("edit filename %q must contain source-edited slug", filepath.Base(res.AbsPath))
	}
}

func TestEditImage_WithMask(t *testing.T) {
	srv, cap := newMockImageServer(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.png")
	mask := filepath.Join(dir, "mask.png")
	if err := os.WriteFile(src, tinyPNG, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mask, tinyPNG, 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := EditImage(context.Background(), ImageGenConfig{
		BaseURL:     srv.URL,
		APIKey:      "k",
		UserDataDir: dir,
		StorageID:   "test-sid",
	}, ImageEditRequest{
		Prompt:    "inpaint",
		ImagePath: src,
		MaskPath:  mask,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := cap.Files["mask"]; !ok {
		t.Errorf("mask part missing — files: %v", keys(cap.Files))
	}
}

func TestEditImage_RequiresAbsoluteImagePath(t *testing.T) {
	dir := t.TempDir()
	_, err := EditImage(context.Background(), ImageGenConfig{
		BaseURL:     "http://x",
		APIKey:      "k",
		UserDataDir: dir,
		StorageID:   "test-sid",
	}, ImageEditRequest{
		Prompt:    "p",
		ImagePath: "relative/path.png",
	})
	if err == nil {
		t.Fatal("expected error for relative imagePath")
	}
	if !strings.Contains(err.Error(), "absolute") {
		t.Errorf("error %q should mention 'absolute'", err.Error())
	}
}

func TestEditImage_RejectsLargeSourceImage(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "huge.png")
	huge := make([]byte, maxEditSourceBytes+1)
	if err := os.WriteFile(src, huge, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := EditImage(context.Background(), ImageGenConfig{
		BaseURL:     "http://x",
		APIKey:      "k",
		UserDataDir: dir,
		StorageID:   "test-sid",
	}, ImageEditRequest{
		Prompt:    "p",
		ImagePath: src,
	})
	if err == nil {
		t.Fatal("expected error for oversized source")
	}
	if !strings.Contains(err.Error(), "cap") {
		t.Errorf("error %q should mention size cap", err.Error())
	}
}

func TestEditImage_DetectsJPEGMimeFromExtension(t *testing.T) {
	srv, cap := newMockImageServer(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "photo.jpg")
	if err := os.WriteFile(src, tinyPNG, 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := EditImage(context.Background(), ImageGenConfig{
		BaseURL:     srv.URL,
		APIKey:      "k",
		UserDataDir: dir,
		StorageID:   "test-sid",
	}, ImageEditRequest{
		Prompt:    "p",
		ImagePath: src,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cap.Files["image"].MimeType != "image/jpeg" {
		t.Errorf("image part mime = %q, want image/jpeg", cap.Files["image"].MimeType)
	}
}

// --- MCP tool surface -----------------------------------------------------

func TestMCP_ToolsList_HasGenerateAndEdit(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), ""))
	w := postJSONRPC(t, r, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, "")
	var resp struct {
		Result struct {
			Tools []struct {
				Name         string         `json:"name"`
				OutputSchema map[string]any `json:"outputSchema"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got := map[string]map[string]any{}
	for _, tool := range resp.Result.Tools {
		got[tool.Name] = tool.OutputSchema
	}
	for _, want := range []string{"generate_image", "edit_image"} {
		schema, ok := got[want]
		if !ok {
			t.Errorf("%s not in tools/list", want)
			continue
		}
		// Image tools must declare outputSchema so spec-aware clients
		// (MCP 2025-06-18+) can validate structuredContent.
		if schema == nil {
			t.Errorf("%s missing outputSchema", want)
			continue
		}
		props, _ := schema["properties"].(map[string]any)
		if props["relPath"] == nil {
			t.Errorf("%s.outputSchema missing relPath property", want)
		}
	}
}

func TestMCP_GenerateImage_ReturnsTextWithMarker(t *testing.T) {
	dir := t.TempDir()
	h := NewMCPHandler(New(Config{}), "")
	wantAbs := filepath.Join(dir, "out.png")
	wantRel := "generated/2026-04-28/out.png"
	h.ImageGen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
		_ = os.WriteFile(wantAbs, tinyPNG, 0o644)
		return &ImageGenResult{
			AbsPath:       wantAbs,
			RelPath:       wantRel,
			Bytes:         len(tinyPNG),
			RevisedPrompt: "rephrased",
		}, nil
	}
	r := newTestRouter(h)

	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "generate_image",
			"arguments": map[string]any{"prompt": "a cat", "background": "transparent"},
		},
	})
	w := postJSONRPC(t, r, string(body), "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		Result struct {
			Content           []map[string]any `json:"content"`
			StructuredContent map[string]any   `json:"structuredContent"`
			IsError           bool             `json:"isError"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Result.IsError {
		t.Fatalf("got isError=true, body: %s", w.Body.String())
	}
	// Single text content block. The agent CLI (Claude Code, observed
	// 2026-04-28) flattens our MCP response and drops `_meta`,
	// `structuredContent`, and `resource_link` blocks before forwarding over
	// ACP. So the marker has to live inside text — that's the only field
	// that always survives. structuredContent is still emitted (for
	// spec-aware clients on MCP 2025-06-18+).
	if len(resp.Result.Content) != 1 {
		t.Fatalf("content blocks = %d, want 1 (single text with marker)", len(resp.Result.Content))
	}
	// structuredContent: native MCP 2025-06-18 field carrying the same data
	// as the marker. Tested for completeness even though current agent CLIs
	// drop it on the wire.
	if resp.Result.StructuredContent["relPath"] != wantRel {
		t.Errorf("structuredContent.relPath = %v, want %s", resp.Result.StructuredContent["relPath"], wantRel)
	}
	if resp.Result.StructuredContent["op"] != "generated" {
		t.Errorf("structuredContent.op = %v, want generated", resp.Result.StructuredContent["op"])
	}
	if resp.Result.Content[0]["type"] != "text" {
		t.Errorf("block 0 type = %v, want text", resp.Result.Content[0]["type"])
	}
	textOut := resp.Result.Content[0]["text"].(string)
	if !strings.Contains(textOut, wantAbs) {
		t.Errorf("text block missing absPath %q: %q", wantAbs, textOut)
	}
	if !strings.Contains(textOut, wantRel) {
		t.Errorf("text block missing relPath %q: %q", wantRel, textOut)
	}
	if !strings.Contains(textOut, "rephrased") {
		t.Errorf("text block missing revised prompt: %q", textOut)
	}
	// Structured marker — the contract the frontend reads.
	const markerPrefix = "[mylifedb-image] "
	idx := strings.Index(textOut, markerPrefix)
	if idx < 0 {
		t.Fatalf("marker %q not found in text: %q", markerPrefix, textOut)
	}
	jsonPart := textOut[idx+len(markerPrefix):]
	// Marker JSON must be a single line, on its own line, ending the message.
	if strings.Contains(jsonPart, "\n") {
		t.Errorf("marker JSON must be on a single line: %q", jsonPart)
	}
	var meta struct {
		Op            string `json:"op"`
		AbsPath       string `json:"absPath"`
		RelPath       string `json:"relPath"`
		MimeType      string `json:"mimeType"`
		Bytes         int    `json:"bytes"`
		RevisedPrompt string `json:"revisedPrompt"`
	}
	if err := json.Unmarshal([]byte(jsonPart), &meta); err != nil {
		t.Fatalf("marker JSON parse failed: %v -- payload: %q", err, jsonPart)
	}
	if meta.RelPath != wantRel {
		t.Errorf("marker.relPath = %q, want %q", meta.RelPath, wantRel)
	}
	if meta.AbsPath != wantAbs {
		t.Errorf("marker.absPath = %q, want %q", meta.AbsPath, wantAbs)
	}
	if meta.Op != "generated" {
		t.Errorf("marker.op = %q, want generated", meta.Op)
	}
	if meta.Bytes != len(tinyPNG) {
		t.Errorf("marker.bytes = %d, want %d", meta.Bytes, len(tinyPNG))
	}
	if meta.RevisedPrompt != "rephrased" {
		t.Errorf("marker.revisedPrompt = %q, want rephrased", meta.RevisedPrompt)
	}
	if meta.MimeType != "image/png" {
		t.Errorf("marker.mimeType = %q, want image/png", meta.MimeType)
	}
	// Defense in depth: explicitly verify no image content block leaked through.
	for _, b := range resp.Result.Content {
		if b["type"] == "image" {
			t.Errorf("image content block must NOT be present (would burn token context); got %v", b)
		}
	}
}

func TestMCP_GenerateImage_PassesBackgroundThrough(t *testing.T) {
	var capturedBg string
	h := NewMCPHandler(New(Config{}), "")
	h.ImageGen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
		capturedBg = req.Background
		return &ImageGenResult{Bytes: 1, AbsPath: "/x.png"}, nil
	}
	r := newTestRouter(h)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"p","background":"opaque"}}}`
	postJSONRPC(t, r, body, "")
	if capturedBg != "opaque" {
		t.Errorf("background passthrough = %q, want opaque", capturedBg)
	}
}

func TestMCP_GenerateImage_MissingPromptReturnsToolError(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), ""))
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_image","arguments":{}}}`
	w := postJSONRPC(t, r, body, "")
	var resp struct {
		Result struct {
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.Result.IsError {
		t.Errorf("expected isError=true")
	}
}

func TestMCP_GenerateImage_GeneratorErrorReturnsToolError(t *testing.T) {
	h := NewMCPHandler(New(Config{}), "")
	h.ImageGen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
		return nil, errBoom
	}
	r := newTestRouter(h)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"x"}}}`
	w := postJSONRPC(t, r, body, "")
	var resp struct {
		Result struct {
			IsError bool             `json:"isError"`
			Content []map[string]any `json:"content"`
		} `json:"result"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.Result.IsError {
		t.Errorf("expected isError=true on generator failure")
	}
	if len(resp.Result.Content) == 0 || !strings.Contains(resp.Result.Content[0]["text"].(string), "boom") {
		t.Errorf("expected error text to contain 'boom', got %v", resp.Result.Content)
	}
}

func TestMCP_EditImage_DispatchesAndPassesArgsThrough(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "in.png")
	_ = os.WriteFile(src, tinyPNG, 0o644)

	var captured ImageEditRequest
	h := NewMCPHandler(New(Config{}), "")
	editedPath := filepath.Join(dir, "edited-out.png")
	h.ImageEdit = func(ctx context.Context, req ImageEditRequest) (*ImageGenResult, error) {
		captured = req
		return &ImageGenResult{
			AbsPath: editedPath,
			Bytes:   len(tinyPNG),
		}, nil
	}
	r := newTestRouter(h)
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name": "edit_image",
			"arguments": map[string]any{
				"prompt":    "make it blue",
				"imagePath": src,
				"size":      "1536x1024",
			},
		},
	})
	w := postJSONRPC(t, r, string(body), "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if captured.Prompt != "make it blue" {
		t.Errorf("prompt = %q", captured.Prompt)
	}
	if captured.ImagePath != src {
		t.Errorf("imagePath = %q, want %q", captured.ImagePath, src)
	}
	if captured.Size != "1536x1024" {
		t.Errorf("size = %q", captured.Size)
	}

	var resp struct {
		Result struct {
			Content []map[string]any `json:"content"`
			IsError bool             `json:"isError"`
		} `json:"result"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Result.IsError {
		t.Fatalf("got isError=true: %s", w.Body.String())
	}
	if len(resp.Result.Content) != 1 {
		t.Fatalf("content blocks = %d, want 1 (text with marker)", len(resp.Result.Content))
	}
	textOut := resp.Result.Content[0]["text"].(string)
	if !strings.HasPrefix(textOut, "Edited image") {
		t.Errorf("edit result text should start with 'Edited image', got %q", textOut)
	}
	if !strings.Contains(textOut, editedPath) {
		t.Errorf("edit result text missing path %q: %q", editedPath, textOut)
	}
	if !strings.Contains(textOut, "[mylifedb-image] ") {
		t.Errorf("edit result text missing structured marker: %q", textOut)
	}
}

func TestMCP_EditImage_MissingArgsReturnsToolError(t *testing.T) {
	r := newTestRouter(NewMCPHandler(New(Config{}), ""))
	cases := []string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"edit_image","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"edit_image","arguments":{"prompt":"p"}}}`,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"edit_image","arguments":{"imagePath":"/x"}}}`,
	}
	for _, body := range cases {
		w := postJSONRPC(t, r, body, "")
		var resp struct {
			Result struct {
				IsError bool `json:"isError"`
			} `json:"result"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		if !resp.Result.IsError {
			t.Errorf("expected isError=true for body %s", body)
		}
	}
}

// --- SSE transport (slow tools/call) -------------------------------------

// TestMCP_ToolsCall_SSEStreamsResponseAndKeepalives verifies the fix for the
// "broken pipe" symptom: when the client advertises text/event-stream in
// Accept, tools/call responses come back as an SSE stream with the headers
// flushed immediately and a JSON-RPC `data:` event written when the tool
// finishes. Uses a slow ImageGen override (~150ms) — too short to see real
// keepalives, but long enough to confirm the client can read the stream
// before the work completes (i.e. headers were flushed early).
func TestMCP_ToolsCall_SSEStreamsResponseAndKeepalives(t *testing.T) {
	dir := t.TempDir()
	h := NewMCPHandler(New(Config{}), "")
	h.ImageGen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
		time.Sleep(150 * time.Millisecond)
		path := filepath.Join(dir, "out.png")
		_ = os.WriteFile(path, tinyPNG, 0o644)
		return &ImageGenResult{
			AbsPath: path,
			Bytes:   len(tinyPNG),
		}, nil
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/mcp", h.HandleMCP)
	srv := httptest.NewServer(r)
	defer srv.Close()

	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "generate_image",
			"arguments": map[string]any{"prompt": "x"},
		},
	})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/mcp", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("Content-Type"); !strings.Contains(got, "text/event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", got)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}

	jsonRPC := extractSSEData(string(raw))
	if jsonRPC == "" {
		t.Fatalf("no data: event found in SSE stream — body: %q", string(raw))
	}
	var rpc struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  struct {
			Content []map[string]any `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(jsonRPC), &rpc); err != nil {
		t.Fatalf("parse data event JSON: %v — payload: %q", err, jsonRPC)
	}
	if rpc.JSONRPC != "2.0" {
		t.Errorf("jsonrpc = %q, want 2.0", rpc.JSONRPC)
	}
	if len(rpc.Result.Content) != 1 {
		t.Fatalf("content blocks = %d, want 1 (text with marker)", len(rpc.Result.Content))
	}
	if rpc.Result.Content[0]["type"] != "text" {
		t.Errorf("block 0 type = %v, want text", rpc.Result.Content[0]["type"])
	}
}

// TestMCP_ToolsCall_NoSSEFallsBackToJSON verifies that a client that does
// NOT advertise text/event-stream in Accept gets a normal application/json
// response — backwards-compat with simpler MCP clients.
func TestMCP_ToolsCall_NoSSEFallsBackToJSON(t *testing.T) {
	h := NewMCPHandler(New(Config{}), "")
	h.ImageGen = func(ctx context.Context, req ImageGenRequest) (*ImageGenResult, error) {
		return &ImageGenResult{Bytes: 1, AbsPath: "/x.png"}, nil
	}
	r := newTestRouter(h)
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"p"}}}`
	w := postJSONRPC(t, r, body, "")
	if got := w.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Errorf("Content-Type = %q, want application/json (no SSE in Accept)", got)
	}
	var resp struct {
		Result struct {
			Content []map[string]any `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("parse JSON body: %v — body: %s", err, w.Body.String())
	}
	if len(resp.Result.Content) == 0 {
		t.Errorf("expected content blocks, got empty")
	}
}

// extractSSEData pulls the first `data:` line's payload out of an SSE
// response body. Multi-line data fields are joined with newlines per the
// SSE spec, but our server only writes single-line JSON `data:` events.
func extractSSEData(body string) string {
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "data: ") {
			return strings.TrimPrefix(line, "data: ")
		}
	}
	return ""
}

func TestWriteImageFromResponse_PerSessionPath(t *testing.T) {
	tmp := t.TempDir()
	gc := ImageGenConfig{
		UserDataDir: tmp,
		StorageID:   "sid-Q",
		Now:         func() time.Time { return time.Date(2026, 4, 28, 0, 0, 0, 0, time.UTC) },
	}
	body, _ := json.Marshal(map[string]any{
		"data": []map[string]any{
			{
				"b64_json":       base64.StdEncoding.EncodeToString(tinyPNG),
				"revised_prompt": "",
			},
		},
	})
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
	gc := ImageGenConfig{
		BaseURL:     "http://x",
		APIKey:      "k",
		UserDataDir: tmp,
		// StorageID intentionally empty
	}
	body, _ := json.Marshal(map[string]any{
		"data": []map[string]any{
			{"b64_json": base64.StdEncoding.EncodeToString(tinyPNG)},
		},
	})
	// writeImageFromResponse itself doesn't validate config (validateConfig
	// is invoked by GenerateImage / EditImage). Test that GenerateImage
	// returns the expected error when StorageID is empty.
	_, err := GenerateImage(context.Background(), gc, ImageGenRequest{Prompt: "hi"})
	_ = body
	if err == nil {
		t.Fatal("expected error when StorageID empty")
	}
	if !strings.Contains(err.Error(), "StorageID") && !strings.Contains(err.Error(), "X-MLD-Session-Id") {
		t.Fatalf("error should mention StorageID or X-MLD-Session-Id, got: %v", err)
	}
}

// --- helpers --------------------------------------------------------------

func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

var errBoom = errSimple("boom")

type errSimple string

func (e errSimple) Error() string { return string(e) }
