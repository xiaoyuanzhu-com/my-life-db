package vendors

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	aliyunClient     *AliyunClient
	aliyunClientOnce sync.Once
)

// AliyunClient wraps the Aliyun API client
type AliyunClient struct {
	apiKey     string
	region     string // "beijing" or "singapore"
	httpClient *http.Client
	ossClient  *oss.Client
	ossBucket  string
}

// AliyunASRSubmitRequest represents the request to submit an ASR task
type AliyunASRSubmitRequest struct {
	Model      string                 `json:"model"`
	Input      map[string]interface{} `json:"input"`
	Parameters map[string]interface{} `json:"parameters,omitempty"`
}

// AliyunASRSubmitResponse represents the response from submitting an ASR task
type AliyunASRSubmitResponse struct {
	RequestID string `json:"request_id"`
	Output    struct {
		TaskID string `json:"task_id"`
	} `json:"output"`
}

// AliyunASRStatusResponse represents the response from querying task status
type AliyunASRStatusResponse struct {
	RequestID string `json:"request_id"`
	Output    struct {
		TaskID     string `json:"task_id"`
		TaskStatus string `json:"task_status"` // PENDING, RUNNING, SUCCEEDED, FAILED
		SubmitTime string `json:"submit_time"`
		EndTime    string `json:"end_time,omitempty"`
		Results    []struct {
			FileURL          string `json:"file_url"`
			TranscriptionURL string `json:"transcription_url"`
			SubtaskStatus    string `json:"subtask_status"` // SUCCEEDED, FAILED
		} `json:"results,omitempty"`
	} `json:"output"`
}

// AliyunTranscriptionResult represents the transcription result
type AliyunTranscriptionResult struct {
	FileURL    string `json:"file_url"`
	Properties struct {
		AudioFormat                    string `json:"audio_format"`
		Channels                       []int  `json:"channels"`
		OriginalSamplingRate           int    `json:"original_sampling_rate"`
		OriginalDurationInMilliseconds int    `json:"original_duration_in_milliseconds"`
	} `json:"properties"`
	Transcripts []struct {
		ChannelID                      int    `json:"channel_id"`
		ContentDurationInMilliseconds  int    `json:"content_duration_in_milliseconds"`
		Text                           string `json:"text"`
		Sentences                      []struct {
			BeginTime  int    `json:"begin_time"`
			EndTime    int    `json:"end_time"`
			Text       string `json:"text"`
			SentenceID int    `json:"sentence_id"`
			SpeakerID  int    `json:"speaker_id,omitempty"`
			Words      []struct {
				BeginTime   int    `json:"begin_time"`
				EndTime     int    `json:"end_time"`
				Text        string `json:"text"`
				Punctuation string `json:"punctuation,omitempty"`
			} `json:"words,omitempty"`
		} `json:"sentences"`
	} `json:"transcripts"`
}

// GetAliyunClient returns the singleton Aliyun client
func GetAliyunClient() *AliyunClient {
	aliyunClientOnce.Do(func() {
		// Load settings from database
		settings, err := db.LoadUserSettings()
		if err != nil {
			log.Error().Err(err).Msg("failed to load user settings for Aliyun")
			return
		}

		if settings.Vendors == nil || settings.Vendors.Aliyun == nil || settings.Vendors.Aliyun.APIKey == "" {
			log.Warn().Msg("Aliyun API key not configured, Aliyun ASR disabled")
			return
		}

		region := settings.Vendors.Aliyun.Region
		if region == "" {
			region = "beijing" // Default to beijing
		}

		// Initialize OSS client if credentials are provided
		var ossClient *oss.Client
		ossBucket := settings.Vendors.Aliyun.OSSBucket

		if settings.Vendors.Aliyun.OSSAccessKeyID != "" && settings.Vendors.Aliyun.OSSAccessKeySecret != "" && ossBucket != "" {
			ossRegion := settings.Vendors.Aliyun.OSSRegion
			if ossRegion == "" {
				ossRegion = "oss-cn-beijing" // Default to Beijing
			}

			// Create credentials provider
			credProvider := credentials.NewStaticCredentialsProvider(
				settings.Vendors.Aliyun.OSSAccessKeyID,
				settings.Vendors.Aliyun.OSSAccessKeySecret,
			)

			// Create OSS config and client
			ossCfg := oss.LoadDefaultConfig().
				WithCredentialsProvider(credProvider).
				WithRegion(ossRegion)

			ossClient = oss.NewClient(ossCfg)
			log.Info().
				Str("region", ossRegion).
				Str("bucket", ossBucket).
				Msg("Aliyun OSS initialized")
		} else {
			log.Warn().Msg("Aliyun OSS credentials not configured, OSS features disabled")
		}

		aliyunClient = &AliyunClient{
			apiKey:     settings.Vendors.Aliyun.APIKey,
			region:     region,
			ossClient:  ossClient,
			ossBucket:  ossBucket,
			httpClient: &http.Client{
				Timeout: 30 * time.Minute, // Long timeout for large files
			},
		}

		log.Info().Str("region", region).Msg("Aliyun ASR initialized")
	})

	return aliyunClient
}

// getBaseURL returns the base URL based on region
func (c *AliyunClient) getBaseURL() string {
	if c.region == "singapore" {
		return "https://dashscope-intl.aliyuncs.com"
	}
	return "https://dashscope.aliyuncs.com"
}

// uploadToOSS uploads a file to Aliyun OSS and returns a presigned URL
func (c *AliyunClient) uploadToOSS(audioPath string) (string, error) {
	if c.ossClient == nil {
		return "", fmt.Errorf("OSS client not initialized - please configure OSS credentials")
	}

	// Resolve relative path to absolute
	fullPath := resolveFilePath(audioPath)

	// Read audio file
	audioFile, err := os.Open(fullPath)
	if err != nil {
		return "", fmt.Errorf("failed to open audio file: %w", err)
	}
	defer audioFile.Close()

	// Generate OSS key: asr-temp/{filename}
	filename := filepath.Base(audioPath)
	ossKey := fmt.Sprintf("asr-temp/%s", filename)

	// Upload to OSS
	putReq := &oss.PutObjectRequest{
		Bucket: oss.Ptr(c.ossBucket),
		Key:    oss.Ptr(ossKey),
		Body:   audioFile,
	}

	ctx := context.Background()
	_, err = c.ossClient.PutObject(ctx, putReq)
	if err != nil {
		return "", fmt.Errorf("failed to upload to OSS: %w", err)
	}

	log.Info().
		Str("audioPath", audioPath).
		Str("ossKey", ossKey).
		Msg("uploaded file to OSS")

	// Generate presigned URL (valid for 1 hour)
	getReq := &oss.GetObjectRequest{
		Bucket: oss.Ptr(c.ossBucket),
		Key:    oss.Ptr(ossKey),
	}

	presignResult, err := c.ossClient.Presign(ctx, getReq, oss.PresignExpires(1*time.Hour))
	if err != nil {
		return "", fmt.Errorf("failed to generate presigned URL: %w", err)
	}

	log.Info().
		Str("url", presignResult.URL).
		Time("expiration", presignResult.Expiration).
		Msg("generated presigned URL")

	return presignResult.URL, nil
}

// SpeechRecognition transcribes audio using Aliyun Fun-ASR recorded speech API
func (c *AliyunClient) SpeechRecognition(audioPath string, opts ASROptions) (*ASRResponse, error) {
	if c == nil {
		return nil, fmt.Errorf("Aliyun client not initialized")
	}

	// Upload to OSS and get presigned URL
	fileURL, err := c.uploadToOSS(audioPath)
	if err != nil {
		return nil, fmt.Errorf("failed to upload to OSS: %w", err)
	}

	// Submit ASR task
	submitReq := AliyunASRSubmitRequest{
		Model: "fun-asr",
		Input: map[string]interface{}{
			"file_urls": []string{fileURL},
		},
		Parameters: map[string]interface{}{
			"channel_id": []int{0},
		},
	}

	// Enable diarization if requested
	if opts.Diarization {
		submitReq.Parameters["diarization_enabled"] = true
		submitReq.Parameters["speaker_count"] = 4 // Max speakers
	}

	submitURL := c.getBaseURL() + "/api/v1/services/audio/asr/transcription"
	submitResp, err := c.doRequest("POST", submitURL, submitReq, map[string]string{
		"X-DashScope-Async": "enable",
	})
	if err != nil {
		return nil, fmt.Errorf("failed to submit ASR task: %w", err)
	}

	var submitResult AliyunASRSubmitResponse
	if err := json.Unmarshal(submitResp, &submitResult); err != nil {
		return nil, fmt.Errorf("failed to parse submit response: %w", err)
	}

	taskID := submitResult.Output.TaskID
	log.Info().Str("taskID", taskID).Msg("submitted ASR task to Aliyun")

	// Poll for task completion
	statusURL := c.getBaseURL() + "/api/v1/tasks/" + taskID
	var transcriptionURL string

	for {
		time.Sleep(2 * time.Second) // Poll every 2 seconds

		statusResp, err := c.doRequest("GET", statusURL, nil, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to query task status: %w", err)
		}

		var statusResult AliyunASRStatusResponse
		if err := json.Unmarshal(statusResp, &statusResult); err != nil {
			return nil, fmt.Errorf("failed to parse status response: %w", err)
		}

		log.Debug().
			Str("taskID", taskID).
			Str("status", statusResult.Output.TaskStatus).
			Msg("ASR task status")

		switch statusResult.Output.TaskStatus {
		case "SUCCEEDED":
			if len(statusResult.Output.Results) > 0 {
				transcriptionURL = statusResult.Output.Results[0].TranscriptionURL
			}
			goto done
		case "FAILED":
			return nil, fmt.Errorf("ASR task failed")
		case "PENDING", "RUNNING":
			continue
		default:
			return nil, fmt.Errorf("unknown task status: %s", statusResult.Output.TaskStatus)
		}
	}

done:
	if transcriptionURL == "" {
		return nil, fmt.Errorf("no transcription URL returned")
	}

	log.Info().Str("transcriptionURL", transcriptionURL).Msg("fetching transcription result")

	// Fetch transcription result
	transcriptionResp, err := c.doRequest("GET", transcriptionURL, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch transcription: %w", err)
	}

	var transcription AliyunTranscriptionResult
	if err := json.Unmarshal(transcriptionResp, &transcription); err != nil {
		return nil, fmt.Errorf("failed to parse transcription: %w", err)
	}

	// Convert to ASRResponse format
	var segments []ASRSegment
	var speakers []ASRSpeaker
	fullText := ""

	if len(transcription.Transcripts) > 0 {
		transcript := transcription.Transcripts[0]
		fullText = transcript.Text

		// Convert sentences to segments
		speakerMap := make(map[int]bool)
		for _, sentence := range transcript.Sentences {
			segment := ASRSegment{
				Start: float64(sentence.BeginTime) / 1000.0,
				End:   float64(sentence.EndTime) / 1000.0,
				Text:  sentence.Text,
			}

			// Add speaker if diarization was enabled
			if sentence.SpeakerID > 0 {
				segment.Speaker = fmt.Sprintf("SPEAKER_%d", sentence.SpeakerID)
				speakerMap[sentence.SpeakerID] = true
			}

			segments = append(segments, segment)
		}

		// Create speaker entries (without embeddings since Aliyun doesn't provide them)
		for speakerID := range speakerMap {
			speakers = append(speakers, ASRSpeaker{
				SpeakerID:     fmt.Sprintf("SPEAKER_%d", speakerID),
				Embedding:     nil, // Aliyun doesn't provide voice embeddings
				TotalDuration: 0,   // Would need to calculate from segments
				SegmentCount:  0,   // Would need to calculate from segments
			})
		}
	}

	asrResponse := &ASRResponse{
		RequestID:        taskID,
		ProcessingTimeMs: 0, // Aliyun doesn't provide this
		Text:             fullText,
		Language:         "zh", // Aliyun is primarily Chinese
		Model:            "fun-asr",
		Segments:         segments,
		Speakers:         speakers,
	}

	log.Info().
		Str("taskID", taskID).
		Int("segmentCount", len(segments)).
		Int("speakerCount", len(speakers)).
		Int("textLength", len(fullText)).
		Msg("Aliyun ASR completed successfully")

	return asrResponse, nil
}

// doRequest performs an HTTP request to Aliyun API
func (c *AliyunClient) doRequest(method, url string, body interface{}, extraHeaders map[string]string) ([]byte, error) {
	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewBuffer(jsonBody)
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	// Add extra headers
	for key, value := range extraHeaders {
		req.Header.Set(key, value)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	return respBody, nil
}

// GetAliyun returns the Aliyun client (wrapper for digest workers)
func GetAliyun() *AliyunClient {
	return GetAliyunClient()
}

// getRealtimeWebSocketURL returns the WebSocket URL for real-time ASR based on region
func (c *AliyunClient) getRealtimeWebSocketURL() string {
	if c.region == "singapore" {
		return "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference"
	}
	return "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
}
