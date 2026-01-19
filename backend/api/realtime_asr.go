package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
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
// Returns the path to the temp audio file for refinement
func (h *Handlers) proxyAliyunRealtimeASR(clientConn *websocket.Conn, settings *models.UserSettings) string {
	if settings.Vendors == nil || settings.Vendors.Aliyun == nil || settings.Vendors.Aliyun.APIKey == "" {
		sendError(clientConn, "Aliyun API key not configured")
		return ""
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
		return ""
	}
	defer aliyunConn.Close()

	log.Info().Str("url", wsURL).Msg("connected to Aliyun Fun-ASR Realtime")

	// Create temporary recording file for crash protection
	cfg := config.Get()
	tempDir := filepath.Join(cfg.GetAppDataDir(), "recordings", "temp")
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		log.Error().Err(err).Msg("failed to create temp recordings directory")
	}

	timestamp := time.Now().Format("20060102_150405")
	tempFile := filepath.Join(tempDir, timestamp+".pcm")
	audioFile, err := os.Create(tempFile)
	if err != nil {
		log.Warn().Err(err).Msg("failed to create temp audio file, continuing without auto-save")
		audioFile = nil
	} else {
		log.Info().Str("file", tempFile).Msg("saving audio chunks for crash protection")
		defer func() {
			if audioFile != nil {
				audioFile.Close()
				// Note: We don't delete the temp file here anymore
				// It will be deleted after refinement by the RefineTranscript endpoint
				log.Info().Str("file", tempFile).Msg("temp audio file saved for refinement")
			}
		}()
	}

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

				// Save audio chunk to temp file for crash protection
				if audioFile != nil {
					if _, err := audioFile.Write(message); err != nil {
						log.Warn().Err(err).Msg("failed to write audio chunk to temp file")
					}
				}

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

				// Transform Aliyun schema to our schema, passing temp file path for "done" messages
				ourMsg, err := transformAliyunToOurs(message, tempFile)
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

	return tempFile
}

// transformAliyunToOurs converts Aliyun message format to our vendor-agnostic format
// If tempAudioPath is provided and the message is "task-finished", includes it in the done payload
func transformAliyunToOurs(aliyunMsg []byte, tempAudioPath string) ([]byte, error) {
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
		payload := map[string]interface{}{}
		// Include temp audio path for refinement if available
		if tempAudioPath != "" {
			payload["temp_audio_path"] = tempAudioPath
		}
		ourMsg = ASRMessage{
			Type:    "done",
			Payload: payload,
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

// RefineTranscriptRequest represents the request to refine a transcript using non-realtime ASR
type RefineTranscriptRequest struct {
	AudioPath string `json:"audio_path" binding:"required"` // Path to the temporary audio file
}

// RefineTranscriptResponse represents the response from transcript refinement
type RefineTranscriptResponse struct {
	Text  string `json:"text"`
	Error string `json:"error,omitempty"`
}

// RefineTranscript processes the recorded audio through non-realtime Fun-ASR for better quality
func (h *Handlers) RefineTranscript(c *gin.Context) {
	var req RefineTranscriptRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
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

	// Perform non-realtime ASR using fun-asr model
	asrResponse, err := aliyunClient.SpeechRecognition(req.AudioPath, vendors.ASROptions{
		Model:       "fun-asr",
		Diarization: false,
	})
	if err != nil {
		log.Error().Err(err).Str("audioPath", req.AudioPath).Msg("failed to refine transcript")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "transcript refinement failed: " + err.Error()})
		return
	}

	log.Info().
		Str("audioPath", req.AudioPath).
		Int("textLength", len(asrResponse.Text)).
		Msg("transcript refined successfully")

	// Clean up the temp audio file after successful refinement
	if err := os.Remove(req.AudioPath); err != nil {
		log.Warn().Err(err).Str("audioPath", req.AudioPath).Msg("failed to clean up temp audio file after refinement")
	} else {
		log.Info().Str("audioPath", req.AudioPath).Msg("cleaned up temp audio file after refinement")
	}

	c.JSON(http.StatusOK, RefineTranscriptResponse{
		Text: asrResponse.Text,
	})
}
