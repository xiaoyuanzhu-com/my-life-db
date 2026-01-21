package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/models"
	"github.com/xiaoyuanzhu-com/my-life-db/vendors"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now (consider restricting in production)
	},
}

// Our vendor-agnostic ASR message schema
// This schema is designed to be provider-independent while supporting real-time streaming ASR

// ASRMessage is the top-level message format for our ASR API
type ASRMessage struct {
	Type    string                 `json:"type"`              // "start", "stop", "transcript", "error", "done"
	Payload map[string]interface{} `json:"payload,omitempty"` // Type-specific payload
}

// TranscriptPayload contains transcription results
type TranscriptPayload struct {
	Text       string  `json:"text"`                  // Transcribed text
	IsFinal    bool    `json:"is_final"`              // true if finalized, false if partial
	Confidence float64 `json:"confidence,omitempty"`  // 0.0-1.0 confidence score
	BeginTime  int     `json:"begin_time,omitempty"`  // Milliseconds from start
	EndTime    int     `json:"end_time,omitempty"`    // Milliseconds from start
	SpeakerID  string  `json:"speaker_id,omitempty"`  // Speaker identifier (if diarization enabled)
}

// ErrorPayload contains error information
type ErrorPayload struct {
	Message string `json:"message"` // Error message
	Code    string `json:"code"`    // Error code
}

// Internal: Aliyun-specific message format (used for upstream communication only)
type AliyunASRMessage struct {
	Header  map[string]interface{} `json:"header"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

// RealtimeASR proxies WebSocket connections directly to Aliyun Fun-ASR Realtime
// Client and server communicate using Aliyun's message schema directly
func (h *Handlers) RealtimeASR(c *gin.Context) {
	// Upgrade HTTP connection to WebSocket
	clientConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("failed to upgrade WebSocket connection")
		return
	}
	defer clientConn.Close()

	// Load settings for Aliyun credentials
	settings, err := db.LoadUserSettings()
	if err != nil {
		sendError(clientConn, "failed to load settings: "+err.Error())
		return
	}

	log.Info().Msg("starting real-time ASR proxy session")

	// Proxy to Aliyun Fun-ASR Realtime
	h.proxyAliyunRealtimeASR(clientConn, settings)
}

// proxyAliyunRealtimeASR proxies messages between client and Aliyun Fun-ASR Realtime
func (h *Handlers) proxyAliyunRealtimeASR(clientConn *websocket.Conn, settings *models.UserSettings) {
	if settings.Vendors == nil || settings.Vendors.Aliyun == nil || settings.Vendors.Aliyun.APIKey == "" {
		sendError(clientConn, "Aliyun API key not configured")
		return
	}

	apiKey := settings.Vendors.Aliyun.APIKey
	region := settings.Vendors.Aliyun.Region
	if region == "" {
		region = "beijing"
	}

	// Determine WebSocket URL based on region
	wsURL := "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
	if region == "singapore" {
		wsURL = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference"
	}

	// Connect to Aliyun WebSocket
	header := http.Header{}
	header.Set("Authorization", "bearer "+apiKey)

	aliyunConn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		log.Error().Err(err).Str("url", wsURL).Msg("failed to connect to Aliyun WebSocket")
		sendError(clientConn, "failed to connect to ASR provider: "+err.Error())
		return
	}
	defer aliyunConn.Close()

	log.Info().Str("url", wsURL).Msg("connected to Aliyun Fun-ASR Realtime")

	// Use goroutines to handle bidirectional communication
	var wg sync.WaitGroup
	errChan := make(chan error, 2)

	// Generate task ID for this session
	taskID := "task_" + time.Now().Format("20060102150405")

	// Goroutine 1: Forward messages from client to Aliyun (with transformation)
	wg.Add(1)
	go func() {
		defer wg.Done()
		log.Info().Msg("🔵 Started goroutine: Client → Aliyun")
		for {
			// Read message type to determine how to handle it
			log.Debug().Msg("⏳ Waiting for client message...")
			messageType, message, err := clientConn.ReadMessage()
			if err != nil {
				// Check if it's an unexpected close (ignore normal closes)
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, websocket.CloseNormalClosure, websocket.CloseNoStatusReceived) {
					log.Error().Err(err).Msg("client WebSocket unexpected close error")
					errChan <- err
				} else {
					log.Debug().Err(err).Msg("client WebSocket closed normally")
				}
				return
			}

			log.Info().Int("messageType", messageType).Int("length", len(message)).Msg("📨 Received message from client")

			// Handle different message types
			if messageType == websocket.TextMessage {
				// Transform our schema to Aliyun schema
				log.Info().RawJSON("clientMsg", message).Msg("📤 Client message (our schema)")

				aliyunMsg, err := transformOursToAliyun(message, taskID)
				if err != nil {
					log.Error().Err(err).Msg("failed to transform client message to Aliyun format")
					continue
				}

				log.Info().RawJSON("aliyunMsg", aliyunMsg).Msg("📤 Transformed to Aliyun schema")

				// Forward the transformed message to Aliyun
				if err := aliyunConn.WriteMessage(websocket.TextMessage, aliyunMsg); err != nil {
					log.Error().Err(err).Msg("failed to forward message to Aliyun")
					errChan <- err
					return
				}
			} else if messageType == websocket.BinaryMessage {
				// Forward binary audio data directly (no transformation needed)
				log.Debug().Int("bytes", len(message)).Msg("🎤 Client → Aliyun (binary audio)")

				if err := aliyunConn.WriteMessage(websocket.BinaryMessage, message); err != nil {
					log.Error().Err(err).Msg("failed to forward audio to Aliyun")
					errChan <- err
					return
				}
			}
		}
	}()

	// Goroutine 2: Forward messages from Aliyun to client (with transformation)
	wg.Add(1)
	go func() {
		defer wg.Done()
		log.Info().Msg("🟢 Started goroutine: Aliyun → Client")
		for {
			log.Debug().Msg("⏳ Waiting for Aliyun message...")
			messageType, message, err := aliyunConn.ReadMessage()
			if err != nil {
				// Check if it's an unexpected close (ignore normal closes)
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure, websocket.CloseNormalClosure) {
					log.Error().Err(err).Msg("Aliyun WebSocket unexpected close error")
					errChan <- err
				} else {
					log.Debug().Err(err).Msg("Aliyun WebSocket closed normally")
				}
				return
			}

			// Handle different message types
			if messageType == websocket.TextMessage {
				log.Info().RawJSON("aliyunMsg", message).Msg("📥 Aliyun message (Aliyun schema)")

				// Transform Aliyun schema to our schema
				ourMsg, err := transformAliyunToOurs(message)
				if err != nil {
					log.Error().Err(err).Msg("failed to transform Aliyun message to our format")
					continue
				}

				log.Info().RawJSON("ourMsg", ourMsg).Msg("📥 Transformed to our schema")

				// Forward the transformed message to client
				if err := clientConn.WriteMessage(websocket.TextMessage, ourMsg); err != nil {
					// If client already closed, this is expected during shutdown
					log.Debug().Err(err).Msg("failed to forward message to client (client may have closed)")
					return
				}
			} else if messageType == websocket.BinaryMessage {
				// Binary messages are not expected from Aliyun (only text responses)
				log.Debug().Int("bytes", len(message)).Msg("📥 Aliyun → Client (unexpected binary)")
			}
		}
	}()

	// Wait for either goroutine to finish or error
	go func() {
		wg.Wait()
		close(errChan)
	}()

	// Block until error or completion
	for err := range errChan {
		if err != nil {
			log.Error().Err(err).Msg("WebSocket error occurred")
			sendError(clientConn, err.Error())
		}
	}
}

// transformAliyunToOurs converts Aliyun message format to our vendor-agnostic format
func transformAliyunToOurs(aliyunMsg []byte) ([]byte, error) {
	var msg AliyunASRMessage
	if err := json.Unmarshal(aliyunMsg, &msg); err != nil {
		return nil, err
	}

	header := msg.Header
	payload := msg.Payload

	// Determine message type from Aliyun event
	event, _ := header["event"].(string)

	var ourMsg ASRMessage

	switch event {
	case "task-started":
		ourMsg = ASRMessage{
			Type:    "ready",
			Payload: map[string]interface{}{},
		}

	case "result-generated":
		// Extract sentence from Aliyun format
		output, _ := payload["output"].(map[string]interface{})
		sentence, _ := output["sentence"].(map[string]interface{})

		text, _ := sentence["text"].(string)
		endTime, _ := sentence["end_time"].(float64)
		beginTime, _ := sentence["begin_time"].(float64)
		speakerID, _ := sentence["speaker_id"].(string)

		isFinal := endTime > 0

		transcriptPayload := TranscriptPayload{
			Text:      text,
			IsFinal:   isFinal,
			BeginTime: int(beginTime),
			EndTime:   int(endTime),
			SpeakerID: speakerID,
		}

		ourMsg = ASRMessage{
			Type: "transcript",
			Payload: map[string]interface{}{
				"text":       transcriptPayload.Text,
				"is_final":   transcriptPayload.IsFinal,
				"begin_time": transcriptPayload.BeginTime,
				"end_time":   transcriptPayload.EndTime,
			},
		}

		if speakerID != "" {
			ourMsg.Payload["speaker_id"] = speakerID
		}

	case "task-finished":
		ourMsg = ASRMessage{
			Type:    "done",
			Payload: map[string]interface{}{},
		}

	case "task-failed":
		errMsg, _ := payload["message"].(string)
		ourMsg = ASRMessage{
			Type: "error",
			Payload: map[string]interface{}{
				"message": errMsg,
				"code":    "asr_error",
			},
		}

	default:
		// Unknown event, pass through as-is for debugging
		return aliyunMsg, nil
	}

	return json.Marshal(ourMsg)
}

// transformOursToAliyun converts our message format to Aliyun format
func transformOursToAliyun(ourMsg []byte, taskID string) ([]byte, error) {
	var msg ASRMessage
	if err := json.Unmarshal(ourMsg, &msg); err != nil {
		return nil, err
	}

	var aliyunMsg AliyunASRMessage

	switch msg.Type {
	case "start":
		// Client sends "start" -> convert to Aliyun "run-task"
		aliyunMsg = AliyunASRMessage{
			Header: map[string]interface{}{
				"action":    "run-task",
				"task_id":   taskID,
				"streaming": "duplex",
			},
			Payload: map[string]interface{}{
				"task_group": "audio",
				"task":       "asr",
				"function":   "recognition",
				"model":      "fun-asr-realtime",
				"input": map[string]interface{}{
					"format":      "pcm",
					"sample_rate": 16000,
				},
				"parameters": map[string]interface{}{
					"semantic_punctuation_enabled": false,
					"max_sentence_silence":          1300,
				},
			},
		}

	case "stop":
		// Client sends "stop" -> convert to Aliyun "finish-task"
		aliyunMsg = AliyunASRMessage{
			Header: map[string]interface{}{
				"action":    "finish-task",
				"task_id":   taskID,
				"streaming": "duplex",
			},
			Payload: map[string]interface{}{
				"input": map[string]interface{}{},
			},
		}

	default:
		// Unknown type, return error
		return nil, json.Unmarshal([]byte(`{"error": "unknown message type"}`), &aliyunMsg)
	}

	return json.Marshal(aliyunMsg)
}

// sendError sends an error message to the client (using our schema)
func sendError(conn *websocket.Conn, errMsg string) {
	msg := ASRMessage{
		Type: "error",
		Payload: map[string]interface{}{
			"message": errMsg,
			"code":    "connection_error",
		},
	}
	conn.WriteJSON(msg)
}

// ASRRequest represents the request for non-realtime ASR
type ASRRequest struct {
	FileURL string `json:"file_url,omitempty"`       // URL to audio file (e.g., presigned OSS URL)
	FilePath string `json:"file_path,omitempty"`     // Local file path (absolute or relative to app data dir)
	Diarization bool `json:"diarization,omitempty"`  // Enable speaker diarization
}

// ASRHandler processes audio through non-realtime ASR (Aliyun Fun-ASR)
// Accepts either:
// 1. JSON with file_path or file_url
// 2. Multipart form data with 'audio' file field
func (h *Handlers) ASRHandler(c *gin.Context) {
	var audioPath string
	var diarization bool
	contentType := c.GetHeader("Content-Type")

	// Check if this is a multipart upload
	if strings.HasPrefix(contentType, "multipart/form-data") {
		// Handle multipart file upload
		file, err := c.FormFile("audio")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "audio file is required in multipart upload: " + err.Error()})
			return
		}

		// Get diarization flag from form (optional)
		diarization = c.PostForm("diarization") == "true"

		// Save uploaded file to temp directory
		cfg := config.Get()
		tempDir := filepath.Join(cfg.GetAppDataDir(), "recordings", "temp")
		if err := os.MkdirAll(tempDir, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create temp directory: " + err.Error()})
			return
		}

		audioPath = filepath.Join(tempDir, file.Filename)
		if err := c.SaveUploadedFile(file, audioPath); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save uploaded file: " + err.Error()})
			return
		}

		log.Info().Str("audioPath", audioPath).Msg("saved uploaded audio file for ASR processing")
	} else {
		// Handle JSON request with file_path or file_url
		var req ASRRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
			return
		}

		// Validate: must have either file_url or file_path
		if req.FileURL == "" && req.FilePath == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "either file_url or file_path is required"})
			return
		}

		diarization = req.Diarization
		audioPath = req.FilePath
	}

	// Load settings for Aliyun credentials
	settings, err := db.LoadUserSettings()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load settings: " + err.Error()})
		return
	}

	if settings.Vendors == nil || settings.Vendors.Aliyun == nil || settings.Vendors.Aliyun.APIKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Aliyun API key not configured"})
		return
	}

	// Get the Aliyun client
	aliyunClient := vendors.GetAliyunClient()
	if aliyunClient == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to initialize Aliyun client"})
		return
	}

	// Ensure the path is absolute (if not already set from multipart upload)
	if audioPath != "" && !filepath.IsAbs(audioPath) {
		// If relative, assume it's relative to app data dir (where temp files are stored)
		cfg := config.Get()
		audioPath = filepath.Join(cfg.GetAppDataDir(), audioPath)
	}

	log.Info().
		Str("audioPath", audioPath).
		Bool("diarization", diarization).
		Msg("starting non-realtime ASR")

	// Perform non-realtime ASR using fun-asr model
	asrResponse, err := aliyunClient.SpeechRecognition(audioPath, vendors.ASROptions{
		Model:       "fun-asr",
		Diarization: diarization,
	})
	if err != nil {
		log.Error().Err(err).Str("audioPath", audioPath).Msg("ASR failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "ASR failed: " + err.Error()})
		return
	}

	log.Info().
		Str("audioPath", audioPath).
		Int("textLength", len(asrResponse.Text)).
		Int("segmentCount", len(asrResponse.Segments)).
		Msg("ASR completed successfully")

	// Clean up the temp audio file if it's from our temp directory
	if filepath.Dir(audioPath) == filepath.Join(config.Get().GetAppDataDir(), "recordings", "temp") {
		if err := os.Remove(audioPath); err != nil {
			log.Warn().Err(err).Str("audioPath", audioPath).Msg("failed to clean up temp audio file")
		} else {
			log.Info().Str("audioPath", audioPath).Msg("cleaned up temp audio file")
		}
	}

	// Return the full ASR response
	c.JSON(http.StatusOK, asrResponse)
}
