package vendors

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	haidClient     *HAIDClient
	haidClientOnce sync.Once
)

// HAIDClient wraps the HAID API client
type HAIDClient struct {
	baseURL      string
	apiKey       string
	chromeCDPURL string
	httpClient   *http.Client
}

// CrawlOptions holds options for URL crawling
type CrawlOptions struct {
	Screenshot bool
	Timeout    int // seconds
}

// CrawlResponse represents a crawl response
type CrawlResponse struct {
	Title      string `json:"title"`
	Content    string `json:"content"`
	Markdown   string `json:"markdown"`
	Screenshot string `json:"screenshot"` // base64
	URL        string `json:"url"`
	Error      string `json:"error,omitempty"`
}

// ASROptions holds options for speech recognition
type ASROptions struct {
	Model       string
	Diarization bool
}

// ASRResponse represents speech recognition response
type ASRResponse struct {
	Text     string `json:"text"`
	Language string `json:"language"`
	Segments []struct {
		Start   float64 `json:"start"`
		End     float64 `json:"end"`
		Text    string  `json:"text"`
		Speaker string  `json:"speaker,omitempty"`
	} `json:"segments"`
	Error string `json:"error,omitempty"`
}

// OCRResponse represents OCR response
type OCRResponse struct {
	Text   string `json:"text"`
	Blocks []struct {
		Text       string    `json:"text"`
		Confidence float64   `json:"confidence"`
		BBox       []float64 `json:"bbox"`
	} `json:"blocks"`
	Error string `json:"error,omitempty"`
}

// CaptioningResponse represents image captioning response
type CaptioningResponse struct {
	Caption string `json:"caption"`
	Error   string `json:"error,omitempty"`
}

// SAMResponse represents SAM segmentation response
type SAMResponse struct {
	Objects []struct {
		Title       string    `json:"title"`
		Description string    `json:"description"`
		Category    string    `json:"category"`
		BBox        []float64 `json:"bbox"`
		RLE         *struct {
			Size   []int `json:"size"`
			Counts []int `json:"counts"`
		} `json:"rle"`
	} `json:"objects"`
	Error string `json:"error,omitempty"`
}

// GetHAIDClient returns the singleton HAID client
func GetHAIDClient() *HAIDClient {
	haidClientOnce.Do(func() {
		// Load settings from database first, fall back to env vars
		settings, err := db.LoadUserSettings()
		if err != nil {
			log.Error().Err(err).Msg("failed to load user settings for HAID")
			return
		}

		baseURL := ""
		apiKey := ""
		chromeCDPURL := ""

		if settings.Vendors != nil && settings.Vendors.HomelabAI != nil {
			baseURL = settings.Vendors.HomelabAI.BaseURL
			chromeCDPURL = settings.Vendors.HomelabAI.ChromeCdpURL
		}

		// Fall back to env vars if not in DB
		if baseURL == "" {
			cfg := config.Get()
			baseURL = cfg.HAIDBaseURL
			if apiKey == "" {
				apiKey = cfg.HAIDAPIKey
			}
			if chromeCDPURL == "" {
				chromeCDPURL = cfg.HAIDChromeCDPURL
			}
		}

		if baseURL == "" {
			log.Warn().Msg("HAID_BASE_URL not configured, HAID disabled")
			return
		}

		haidClient = &HAIDClient{
			baseURL:      baseURL,
			apiKey:       apiKey,
			chromeCDPURL: chromeCDPURL,
			httpClient: &http.Client{
				Timeout: 5 * time.Minute, // Long timeout for ML operations
			},
		}

		log.Info().Str("baseURL", baseURL).Msg("HAID initialized")
	})

	return haidClient
}

// CrawlURLWithOpts crawls a URL and returns the content with options
func (h *HAIDClient) CrawlURLWithOpts(url string, opts CrawlOptions) (*CrawlResponse, error) {
	if h == nil {
		return nil, nil
	}

	body := map[string]interface{}{
		"url":        url,
		"screenshot": opts.Screenshot,
	}

	if h.chromeCDPURL != "" {
		body["chrome_cdp_url"] = h.chromeCDPURL
	}

	if opts.Timeout > 0 {
		body["timeout"] = opts.Timeout
	}

	resp, err := h.post("/api/crawl", body)
	if err != nil {
		return nil, err
	}

	var result CrawlResponse
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, err
	}

	return &result, nil
}

// SpeechRecognition transcribes audio
func (h *HAIDClient) SpeechRecognition(audioPath string, opts ASROptions) (*ASRResponse, error) {
	if h == nil {
		return nil, nil
	}

	// Read and encode audio file
	audioData, err := os.ReadFile(audioPath)
	if err != nil {
		return nil, err
	}

	audioBase64 := base64.StdEncoding.EncodeToString(audioData)

	body := map[string]interface{}{
		"audio":       audioBase64,
		"model":       opts.Model,
		"diarization": opts.Diarization,
	}

	resp, err := h.post("/api/automatic-speech-recognition", body)
	if err != nil {
		return nil, err
	}

	var result ASRResponse
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, err
	}

	return &result, nil
}

// ImageOCR extracts text from an image
func (h *HAIDClient) ImageOCR(imagePath string) (*OCRResponse, error) {
	if h == nil {
		return nil, nil
	}

	imageData, err := os.ReadFile(imagePath)
	if err != nil {
		return nil, err
	}

	imageBase64 := base64.StdEncoding.EncodeToString(imageData)

	body := map[string]interface{}{
		"image": imageBase64,
	}

	resp, err := h.post("/api/ocr", body)
	if err != nil {
		return nil, err
	}

	var result OCRResponse
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, err
	}

	return &result, nil
}

// ImageCaptioning generates a caption for an image
func (h *HAIDClient) ImageCaptioning(imagePath string) (*CaptioningResponse, error) {
	if h == nil {
		return nil, nil
	}

	imageData, err := os.ReadFile(imagePath)
	if err != nil {
		return nil, err
	}

	imageBase64 := base64.StdEncoding.EncodeToString(imageData)

	body := map[string]interface{}{
		"image": imageBase64,
	}

	resp, err := h.post("/api/image-captioning", body)
	if err != nil {
		return nil, err
	}

	var result CaptioningResponse
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, err
	}

	return &result, nil
}

// SegmentImage runs SAM segmentation
func (h *HAIDClient) SegmentImage(imagePath string) (*SAMResponse, error) {
	if h == nil {
		return nil, nil
	}

	imageData, err := os.ReadFile(imagePath)
	if err != nil {
		return nil, err
	}

	imageBase64 := base64.StdEncoding.EncodeToString(imageData)

	body := map[string]interface{}{
		"image": imageBase64,
	}

	resp, err := h.post("/api/segment-anything", body)
	if err != nil {
		return nil, err
	}

	var result SAMResponse
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, err
	}

	return &result, nil
}

// Embed generates embeddings for texts
func (h *HAIDClient) Embed(texts []string) ([][]float32, error) {
	if h == nil {
		return nil, nil
	}

	log.Info().Int("textCount", len(texts)).Msg("generating embeddings via HAID")

	body := map[string]interface{}{
		"texts": texts,
		"model": "Qwen/Qwen3-Embedding-0.6B",
	}

	resp, err := h.post("/api/text-to-embedding", body)
	if err != nil {
		log.Error().Err(err).Msg("HAID embedding request failed")
		return nil, err
	}

	var result struct {
		Embeddings [][]float32 `json:"embeddings"`
		Model      string      `json:"model"`
		Dimensions int         `json:"dimensions"`
		Error      string      `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		log.Error().Err(err).Msg("failed to parse HAID embedding response")
		return nil, err
	}

	if result.Error != "" {
		return nil, fmt.Errorf("HAID embedding error: %s", result.Error)
	}

	log.Info().
		Str("model", result.Model).
		Int("dimensions", result.Dimensions).
		Int("embeddingCount", len(result.Embeddings)).
		Msg("HAID embeddings generated successfully")

	return result.Embeddings, nil
}

// SpeakerEmbedding extracts speaker embedding from audio
func (h *HAIDClient) SpeakerEmbedding(audioPath string) ([]float32, error) {
	if h == nil {
		return nil, nil
	}

	audioData, err := os.ReadFile(audioPath)
	if err != nil {
		return nil, err
	}

	audioBase64 := base64.StdEncoding.EncodeToString(audioData)

	body := map[string]interface{}{
		"audio": audioBase64,
	}

	resp, err := h.post("/api/speaker-embedding", body)
	if err != nil {
		return nil, err
	}

	var result struct {
		Embedding []float32 `json:"embedding"`
		Error     string    `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, err
	}

	return result.Embedding, nil
}

// post makes a POST request to the HAID API
func (h *HAIDClient) post(endpoint string, body map[string]interface{}) ([]byte, error) {
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	// Properly join base URL and endpoint using url.JoinPath
	fullURL, err := url.JoinPath(h.baseURL, endpoint)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", fullURL, bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	if h.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+h.apiKey)
	}

	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	return io.ReadAll(resp.Body)
}

// GetHAID returns the HAID client (wrapper for digest workers)
func GetHAID() *HAIDClient {
	return GetHAIDClient()
}

// CrawlURL crawls a URL (simplified interface for digest workers)
func (h *HAIDClient) CrawlURL(url string) (string, []byte, error) {
	if h == nil {
		return "", nil, nil
	}

	resp, err := h.CrawlURLWithOpts(url, CrawlOptions{Screenshot: true, Timeout: 30})
	if err != nil {
		return "", nil, err
	}

	content := resp.Markdown
	if content == "" {
		content = resp.Content
	}

	var screenshot []byte
	if resp.Screenshot != "" {
		screenshot, _ = base64.StdEncoding.DecodeString(resp.Screenshot)
	}

	return content, screenshot, nil
}

// ConvertDocToMarkdown converts a document to markdown
func (h *HAIDClient) ConvertDocToMarkdown(docPath string) (string, error) {
	if h == nil {
		return "", nil
	}

	docData, err := os.ReadFile(docPath)
	if err != nil {
		return "", err
	}

	docBase64 := base64.StdEncoding.EncodeToString(docData)

	body := map[string]interface{}{
		"document": docBase64,
	}

	resp, err := h.post("/api/doc-to-markdown", body)
	if err != nil {
		return "", err
	}

	var result struct {
		Markdown string `json:"markdown"`
		Error    string `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return "", err
	}

	return result.Markdown, nil
}

// GenerateDocScreenshot generates a screenshot of a document
func (h *HAIDClient) GenerateDocScreenshot(docPath string) ([]byte, error) {
	if h == nil {
		return nil, nil
	}

	docData, err := os.ReadFile(docPath)
	if err != nil {
		return nil, err
	}

	docBase64 := base64.StdEncoding.EncodeToString(docData)

	body := map[string]interface{}{
		"document": docBase64,
	}

	resp, err := h.post("/api/doc-to-screenshot", body)
	if err != nil {
		return nil, err
	}

	var result struct {
		Screenshot string `json:"screenshot"`
		Error      string `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, err
	}

	return base64.StdEncoding.DecodeString(result.Screenshot)
}

// OCRImage extracts text from an image (simplified interface)
func (h *HAIDClient) OCRImage(imagePath string) (string, error) {
	if h == nil {
		return "", nil
	}

	resp, err := h.ImageOCR(imagePath)
	if err != nil {
		return "", err
	}

	return resp.Text, nil
}

// CaptionImage generates a caption for an image (simplified interface)
func (h *HAIDClient) CaptionImage(imagePath string) (string, error) {
	if h == nil {
		return "", nil
	}

	resp, err := h.ImageCaptioning(imagePath)
	if err != nil {
		return "", err
	}

	return resp.Caption, nil
}

// DetectObjects detects objects in an image
func (h *HAIDClient) DetectObjects(imagePath string) ([]map[string]interface{}, error) {
	if h == nil {
		return nil, nil
	}

	resp, err := h.SegmentImage(imagePath)
	if err != nil {
		return nil, err
	}

	objects := make([]map[string]interface{}, 0, len(resp.Objects))
	for _, obj := range resp.Objects {
		objects = append(objects, map[string]interface{}{
			"title":       obj.Title,
			"description": obj.Description,
			"category":    obj.Category,
			"bbox":        obj.BBox,
		})
	}

	return objects, nil
}

// TranscribeAudio transcribes audio to text (simplified interface)
func (h *HAIDClient) TranscribeAudio(audioPath string) (string, error) {
	if h == nil {
		return "", nil
	}

	resp, err := h.SpeechRecognition(audioPath, ASROptions{Diarization: false})
	if err != nil {
		return "", err
	}

	return resp.Text, nil
}

// GenerateSpeakerEmbedding generates speaker embedding (simplified interface)
func (h *HAIDClient) GenerateSpeakerEmbedding(audioPath string) ([]float32, error) {
	return h.SpeakerEmbedding(audioPath)
}
