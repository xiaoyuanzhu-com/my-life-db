package agentrunner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Maximum bytes accepted for source images on the edit endpoint.
// 20 MB is well above any realistic 1024x1024 PNG/JPEG/WebP and small enough
// that an agent loop can't accidentally upload a 4K screen recording.
const maxEditSourceBytes = 20 * 1024 * 1024

// ImageGenRequest describes a single image generation call.
type ImageGenRequest struct {
	Prompt     string
	Size       string // "1024x1024" | "1536x1024" | "1024x1536" | "auto"; default "1024x1024"
	Quality    string // "low" | "medium" | "high" | "auto"; default "medium"
	Background string // "transparent" | "opaque" | "auto"; empty = omit (server default)
	Filename   string // optional filename hint (no extension)
}

// ImageEditRequest describes a single image edit call.
type ImageEditRequest struct {
	Prompt     string
	ImagePath  string // absolute path to source image (PNG/JPEG/WebP)
	MaskPath   string // optional absolute path to mask PNG (transparent = edit zone)
	Size       string
	Quality    string
	Background string
	Filename   string
}

// ImageGenResult is what GenerateImage / EditImage returns: the on-disk
// path of the saved PNG (both absolute and relative to UserDataDir), the
// byte count, and the model's revised prompt.
//
// RelPath is what the frontend uses to render the image via /raw/<RelPath>;
// AbsPath is what the model sees in the tool result text so it can pass the
// path to other tools (Read, Edit) if needed.
//
// The base64 image bytes are intentionally NOT held here — they're decoded
// once and written to disk. Returning them inline in the MCP tool_result
// would burn ~640K text tokens or ~1500 vision tokens of model context per
// generation; the model only needs the path.
type ImageGenResult struct {
	AbsPath       string
	RelPath       string // relative to UserDataDir, e.g. "sessions/<storageID>/generated/foo.png"
	Bytes         int
	RevisedPrompt string
}

// ImageGenConfig holds the wiring used by GenerateImage and EditImage. In
// production it's pulled from config.Get(); tests inject it directly.
//
// UserDataDir (not AppDataDir) — generated images go under the user's library
// at USER_DATA_DIR/sessions/<storageID>/generated/ so they're served by the
// existing /raw/ endpoint and visible in the user's library/inbox flow. They're
// user content the user just produced.
type ImageGenConfig struct {
	HTTPClient  *http.Client
	BaseURL     string // gateway base URL, e.g. https://newapi.example.com/v1
	APIKey      string
	UserDataDir string
	StorageID   string // per-session storage id; required at write time
	Model       string // image model passed to the image_generation tool; default "gpt-image-2"
	Now         func() time.Time
}

// GenerateImage POSTs to {BaseURL}/responses using the OpenAI Responses API
// with the built-in `image_generation` tool, and writes the returned PNG to
// {UserDataDir}/sessions/{StorageID}/generated/{slug}-{hash}.png.
//
// We use /responses (not /images/generations) because the upstream gateway
// (newapi → Codex/ChatGPT-account backend) only exposes image generation
// through the Responses API tool surface — direct calls to /images/generations
// hang indefinitely on that backend.
func GenerateImage(ctx context.Context, gc ImageGenConfig, req ImageGenRequest) (*ImageGenResult, error) {
	if err := validateConfig(gc); err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, fmt.Errorf("prompt is required")
	}
	gc = withDefaults(gc)
	size, quality := defaultSizeQuality(req.Size, req.Quality)

	body := map[string]any{
		"model":       gc.Model,
		"input":       req.Prompt,
		"tools":       []any{buildImageGenTool(gc.Model, size, quality, req.Background, "")},
		"tool_choice": map[string]any{"type": "image_generation"},
	}
	res, err := callResponsesImage(ctx, gc, body, "generate")
	if err != nil {
		return nil, err
	}

	slugSrc := req.Filename
	if slugSrc == "" {
		slugSrc = req.Prompt
	}
	out, err := writeImage(res.png, res.revisedPrompt, gc, slugSrc, "generated")
	if err != nil {
		return nil, err
	}
	log.Info().
		Str("path", out.AbsPath).
		Int("bytes", out.Bytes).
		Str("size", size).
		Str("quality", quality).
		Str("model", gc.Model).
		Str("op", "generate").
		Msg("agentrunner: image generated")
	return out, nil
}

// EditImage POSTs to {BaseURL}/responses with the source image embedded as an
// `input_image` content block in the user message, and the optional mask
// passed through the `image_generation` tool's `input_image_mask` parameter.
// The result is written alongside generated images at
// {UserDataDir}/sessions/{StorageID}/generated/.
func EditImage(ctx context.Context, gc ImageGenConfig, req ImageEditRequest) (*ImageGenResult, error) {
	if err := validateConfig(gc); err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, fmt.Errorf("prompt is required")
	}
	if req.ImagePath == "" {
		return nil, fmt.Errorf("imagePath is required")
	}
	if !filepath.IsAbs(req.ImagePath) {
		return nil, fmt.Errorf("imagePath must be absolute, got %q", req.ImagePath)
	}
	if req.MaskPath != "" && !filepath.IsAbs(req.MaskPath) {
		return nil, fmt.Errorf("maskPath must be absolute, got %q", req.MaskPath)
	}
	gc = withDefaults(gc)
	size, quality := defaultSizeQuality(req.Size, req.Quality)

	imgDataURL, err := readImageAsDataURL(req.ImagePath)
	if err != nil {
		return nil, err
	}
	maskDataURL := ""
	if req.MaskPath != "" {
		maskDataURL, err = readImageAsDataURL(req.MaskPath)
		if err != nil {
			return nil, err
		}
	}

	body := map[string]any{
		"model": gc.Model,
		"input": []any{
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "input_text", "text": req.Prompt},
					map[string]any{"type": "input_image", "image_url": imgDataURL},
				},
			},
		},
		"tools":       []any{buildImageGenTool(gc.Model, size, quality, req.Background, maskDataURL)},
		"tool_choice": map[string]any{"type": "image_generation"},
	}
	res, err := callResponsesImage(ctx, gc, body, "edit")
	if err != nil {
		return nil, err
	}

	slugSrc := req.Filename
	if slugSrc == "" {
		// Default the edit slug to "<source-stem>-edited" so the user can
		// recognize the output as a derivative of a known input.
		stem := strings.TrimSuffix(filepath.Base(req.ImagePath), filepath.Ext(req.ImagePath))
		slugSrc = stem + "-edited"
	}
	out, err := writeImage(res.png, res.revisedPrompt, gc, slugSrc, "edited")
	if err != nil {
		return nil, err
	}
	log.Info().
		Str("path", out.AbsPath).
		Int("bytes", out.Bytes).
		Str("size", size).
		Str("quality", quality).
		Str("model", gc.Model).
		Str("source", req.ImagePath).
		Str("op", "edit").
		Msg("agentrunner: image edited")
	return out, nil
}

// buildImageGenTool builds the `image_generation` tool config block. `mask`
// is a data URL (or empty); when present it's passed via input_image_mask
// for inpainting.
func buildImageGenTool(model, size, quality, background, mask string) map[string]any {
	tool := map[string]any{
		"type":    "image_generation",
		"model":   model,
		"size":    size,
		"quality": quality,
	}
	if background != "" {
		tool["background"] = background
	}
	if mask != "" {
		tool["input_image_mask"] = map[string]any{"image_url": mask}
	}
	return tool
}

// imageResponseExtract holds what we pull out of a Responses API call: the
// decoded PNG bytes and the model's revised prompt (if any).
type imageResponseExtract struct {
	png           []byte
	revisedPrompt string
}

// callResponsesImage POSTs body to {BaseURL}/responses and extracts the first
// image_generation_call output. opTag is "generate" or "edit", used only for
// error messages.
func callResponsesImage(ctx context.Context, gc ImageGenConfig, body map[string]any, opTag string) (*imageResponseExtract, error) {
	payload, _ := json.Marshal(body)
	url := strings.TrimRight(gc.BaseURL, "/") + "/responses"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+gc.APIKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := gc.HTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("calling image %s: %w", opTag, err)
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("image %s %d: %s", opTag, resp.StatusCode, truncateForError(string(rawBody), 500))
	}
	return parseResponsesImage(rawBody)
}

// parseResponsesImage walks the Responses API output array looking for the
// first `image_generation_call` item, decodes its base64 `result`, and
// returns the bytes plus the revised prompt.
func parseResponsesImage(rawBody []byte) (*imageResponseExtract, error) {
	var parsed struct {
		Status string `json:"status"`
		Error  *struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
		Output []struct {
			Type          string `json:"type"`
			Status        string `json:"status"`
			Result        string `json:"result"`
			RevisedPrompt string `json:"revised_prompt"`
		} `json:"output"`
	}
	if err := json.Unmarshal(rawBody, &parsed); err != nil {
		return nil, fmt.Errorf("parsing image response: %w", err)
	}
	if parsed.Error != nil && parsed.Error.Message != "" {
		return nil, fmt.Errorf("image response error: %s", parsed.Error.Message)
	}
	for _, o := range parsed.Output {
		if o.Type != "image_generation_call" || o.Result == "" {
			continue
		}
		pngBytes, err := base64.StdEncoding.DecodeString(o.Result)
		if err != nil {
			return nil, fmt.Errorf("decoding b64 image result: %w", err)
		}
		return &imageResponseExtract{png: pngBytes, revisedPrompt: o.RevisedPrompt}, nil
	}
	return nil, fmt.Errorf("no image_generation_call in response output")
}

// validateConfig checks the required fields on ImageGenConfig.
func validateConfig(gc ImageGenConfig) error {
	if gc.BaseURL == "" || gc.APIKey == "" {
		return fmt.Errorf("agent gateway not configured (set AGENT_BASE_URL and AGENT_API_KEY)")
	}
	if gc.UserDataDir == "" {
		return fmt.Errorf("UserDataDir not set")
	}
	if gc.StorageID == "" {
		return fmt.Errorf("StorageID not set (X-MLD-Storage-Id header missing on MCP request)")
	}
	return nil
}

// withDefaults fills in defaulted fields on ImageGenConfig (HTTPClient, Now, Model).
func withDefaults(gc ImageGenConfig) ImageGenConfig {
	if gc.HTTPClient == nil {
		// 5 minutes accommodates gpt-image-2 high-quality at 1024x1536, which
		// can take 90-150s. Keepalive SSE comments on the inbound side prevent
		// the agent CLI from timing out during this wait.
		gc.HTTPClient = &http.Client{Timeout: 5 * time.Minute}
	}
	if gc.Now == nil {
		gc.Now = time.Now
	}
	if gc.Model == "" {
		gc.Model = "gpt-image-2"
	}
	return gc
}

func defaultSizeQuality(size, quality string) (string, string) {
	if size == "" {
		size = "1024x1024"
	}
	if quality == "" {
		quality = "medium"
	}
	return size, quality
}

// writeImage persists pngBytes to {UserDataDir}/sessions/{storageID}/generated/
// using a slug derived from slugSrc and a short content hash.
//
// The opTag distinguishes generated vs edited outputs in the saved filename
// (e.g. "edited-foo-abc123.png" vs "foo-abc123.png") — opTag of "generated"
// emits the bare slug; any other tag is prepended.
func writeImage(pngBytes []byte, revisedPrompt string, gc ImageGenConfig, slugSrc, opTag string) (*ImageGenResult, error) {
	if len(pngBytes) == 0 {
		return nil, fmt.Errorf("empty image data")
	}
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
		RevisedPrompt: revisedPrompt,
	}, nil
}

// readImageAsDataURL reads an image from disk (with the size cap), detects its
// MIME type from extension, and returns a "data:<mime>;base64,<...>" URL
// suitable for inlining in a Responses API input_image content block.
func readImageAsDataURL(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("stat %s: %w", path, err)
	}
	if st.IsDir() {
		return "", fmt.Errorf("%s is a directory", path)
	}
	if st.Size() > maxEditSourceBytes {
		return "", fmt.Errorf("%s is %d bytes, exceeds %d byte cap", path, st.Size(), maxEditSourceBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	mt := mimeForExt(filepath.Ext(path))
	return "data:" + mt + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func mimeForExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	default:
		return "image/png"
	}
}

// slugifyForFile strips special characters, lowercases, and limits to 40 runes
// (rune-aware so it doesn't slice through multi-byte CJK characters).
func slugifyForFile(s string) string {
	s = strings.ReplaceAll(s, " ", "-")
	s = strings.ReplaceAll(s, "_", "-")
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' {
			b.WriteRune(r)
		}
	}
	s = b.String()
	s = regexp.MustCompile(`-{2,}`).ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	s = strings.ToLower(s)
	if utf8.RuneCountInString(s) > 40 {
		s = string([]rune(s)[:40])
		s = strings.TrimRight(s, "-")
	}
	return s
}

func truncateForError(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
