package vendors

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/internal/config"
	"github.com/xiaoyuanzhu-com/my-life-db/internal/log"
)

var (
	haidClient     *HAIDClient
	haidClientOnce sync.Once
	haidLogger     = log.GetLogger("HAID")
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
		cfg := config.Get()
		if cfg.HAIDBaseURL == "" {
			haidLogger.Warn().Msg("HAID_BASE_URL not configured, HAID disabled")
			return
		}

		haidClient = &HAIDClient{
			baseURL:      cfg.HAIDBaseURL,
			apiKey:       cfg.HAIDAPIKey,
			chromeCDPURL: cfg.HAIDChromeCDPURL,
			httpClient: &http.Client{
				Timeout: 5 * time.Minute, // Long timeout for ML operations
			},
		}

		haidLogger.Info().Str("baseURL", cfg.HAIDBaseURL).Msg("HAID initialized")
	})

	return haidClient
}

// CrawlURL crawls a URL and returns the content
func (h *HAIDClient) CrawlURL(url string, opts CrawlOptions) (*CrawlResponse, error) {
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

	body := map[string]interface{}{
		"texts": texts,
	}

	resp, err := h.post("/api/embed", body)
	if err != nil {
		return nil, err
	}

	var result struct {
		Embeddings [][]float32 `json:"embeddings"`
		Error      string      `json:"error,omitempty"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, err
	}

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

	req, err := http.NewRequest("POST", h.baseURL+endpoint, bytes.NewBuffer(jsonBody))
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
