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
	"mime/multipart"
	"net/http"
	"net/textproto"
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
// path of the saved PNG, the byte count, and the model's revised prompt
// (useful for showing the model how its prompt was rephrased).
//
// The base64 image bytes are intentionally NOT held here — they're decoded
// once and written to disk. Returning them inline in the MCP tool_result
// would burn ~640K text tokens or ~1500 vision tokens of model context per
// generation; the model only needs the path. The frontend renders the
// image from disk via the existing /raw/<path> static endpoint.
type ImageGenResult struct {
	AbsPath       string
	Bytes         int
	RevisedPrompt string
}

// ImageGenConfig holds the wiring used by GenerateImage and EditImage. In
// production it's pulled from config.Get(); tests inject it directly.
type ImageGenConfig struct {
	HTTPClient *http.Client
	BaseURL    string // gateway base URL, e.g. https://litellm.example.com/v1
	APIKey     string
	AppDataDir string
	Model      string // default "gpt-image-2"
	Now        func() time.Time
}

// GenerateImage POSTs to {BaseURL}/images/generations and writes the returned
// PNG to {AppDataDir}/generated/{YYYY-MM-DD}/{slug}-{hash}.png.
//
// Note: gpt-image-2 always returns base64 in `data[].b64_json` and does not
// accept a `response_format` parameter (unlike gpt-image-1) — passing one
// causes a 400.
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
		"model":   gc.Model,
		"prompt":  req.Prompt,
		"size":    size,
		"quality": quality,
		"n":       1,
	}
	if req.Background != "" {
		body["background"] = req.Background
	}
	payload, _ := json.Marshal(body)

	url := strings.TrimRight(gc.BaseURL, "/") + "/images/generations"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+gc.APIKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := gc.HTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("calling image gen: %w", err)
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("image gen %d: %s", resp.StatusCode, truncateForError(string(rawBody), 500))
	}

	slugSrc := req.Filename
	if slugSrc == "" {
		slugSrc = req.Prompt
	}
	res, err := writeImageFromResponse(rawBody, gc, slugSrc, "generated")
	if err != nil {
		return nil, err
	}
	log.Info().
		Str("path", res.AbsPath).
		Int("bytes", res.Bytes).
		Str("size", size).
		Str("quality", quality).
		Str("model", gc.Model).
		Str("op", "generate").
		Msg("agentrunner: image generated")
	return res, nil
}

// EditImage POSTs to {BaseURL}/images/edits as multipart/form-data, uploading
// the source image (and optional mask), and writes the result alongside
// generated images at {AppDataDir}/generated/{YYYY-MM-DD}/.
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

	// Build multipart body.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("model", gc.Model); err != nil {
		return nil, err
	}
	if err := mw.WriteField("prompt", req.Prompt); err != nil {
		return nil, err
	}
	if err := mw.WriteField("size", size); err != nil {
		return nil, err
	}
	if err := mw.WriteField("quality", quality); err != nil {
		return nil, err
	}
	if err := mw.WriteField("n", "1"); err != nil {
		return nil, err
	}
	if req.Background != "" {
		if err := mw.WriteField("background", req.Background); err != nil {
			return nil, err
		}
	}
	if err := attachMultipartFile(mw, "image", req.ImagePath); err != nil {
		return nil, err
	}
	if req.MaskPath != "" {
		if err := attachMultipartFile(mw, "mask", req.MaskPath); err != nil {
			return nil, err
		}
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}

	url := strings.TrimRight(gc.BaseURL, "/") + "/images/edits"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &buf)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+gc.APIKey)
	httpReq.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := gc.HTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("calling image edit: %w", err)
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("image edit %d: %s", resp.StatusCode, truncateForError(string(rawBody), 500))
	}

	slugSrc := req.Filename
	if slugSrc == "" {
		// Default the edit slug to "<source-stem>-edited" so the user can
		// recognize the output as a derivative of a known input.
		stem := strings.TrimSuffix(filepath.Base(req.ImagePath), filepath.Ext(req.ImagePath))
		slugSrc = stem + "-edited"
	}
	res, err := writeImageFromResponse(rawBody, gc, slugSrc, "edited")
	if err != nil {
		return nil, err
	}
	log.Info().
		Str("path", res.AbsPath).
		Int("bytes", res.Bytes).
		Str("size", size).
		Str("quality", quality).
		Str("model", gc.Model).
		Str("source", req.ImagePath).
		Str("op", "edit").
		Msg("agentrunner: image edited")
	return res, nil
}

// validateConfig checks the required fields on ImageGenConfig.
func validateConfig(gc ImageGenConfig) error {
	if gc.BaseURL == "" || gc.APIKey == "" {
		return fmt.Errorf("agent gateway not configured (set AGENT_BASE_URL and AGENT_API_KEY)")
	}
	if gc.AppDataDir == "" {
		return fmt.Errorf("AppDataDir not set")
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

// writeImageFromResponse parses a gpt-image-2 response body, decodes the
// first b64 image, writes it to {AppDataDir}/generated/{YYYY-MM-DD}/, and
// returns the metadata including the model's revised prompt.
//
// The opTag distinguishes generated vs edited outputs in the saved filename
// (e.g. "edited-foo-abc123.png" vs "foo-abc123.png") — opTag of "generated"
// emits the bare slug; any other tag is prepended.
func writeImageFromResponse(rawBody []byte, gc ImageGenConfig, slugSrc, opTag string) (*ImageGenResult, error) {
	var parsed struct {
		Data []struct {
			B64JSON       string `json:"b64_json"`
			RevisedPrompt string `json:"revised_prompt"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rawBody, &parsed); err != nil {
		return nil, fmt.Errorf("parsing image response: %w", err)
	}
	if len(parsed.Data) == 0 || parsed.Data[0].B64JSON == "" {
		return nil, fmt.Errorf("empty image data in response")
	}
	pngBytes, err := base64.StdEncoding.DecodeString(parsed.Data[0].B64JSON)
	if err != nil {
		return nil, fmt.Errorf("decoding b64: %w", err)
	}

	dayDir := filepath.Join(gc.AppDataDir, "generated", gc.Now().Format("2006-01-02"))
	if err := os.MkdirAll(dayDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dayDir, err)
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
	absPath := filepath.Join(dayDir, name)
	if err := os.WriteFile(absPath, pngBytes, 0o644); err != nil {
		return nil, fmt.Errorf("writing %s: %w", absPath, err)
	}
	return &ImageGenResult{
		AbsPath:       absPath,
		Bytes:         len(pngBytes),
		RevisedPrompt: parsed.Data[0].RevisedPrompt,
	}, nil
}

// attachMultipartFile reads path, refuses files larger than maxEditSourceBytes,
// and writes a part with content-type derived from the file extension.
func attachMultipartFile(mw *multipart.Writer, fieldName, path string) error {
	st, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat %s: %w", path, err)
	}
	if st.IsDir() {
		return fmt.Errorf("%s is a directory", path)
	}
	if st.Size() > maxEditSourceBytes {
		return fmt.Errorf("%s is %d bytes, exceeds %d byte cap", path, st.Size(), maxEditSourceBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	ct := mimeForExt(filepath.Ext(path))

	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition",
		fmt.Sprintf(`form-data; name=%q; filename=%q`, fieldName, filepath.Base(path)))
	h.Set("Content-Type", ct)
	part, err := mw.CreatePart(h)
	if err != nil {
		return err
	}
	if _, err := part.Write(data); err != nil {
		return err
	}
	return nil
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
