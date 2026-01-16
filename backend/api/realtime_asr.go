package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/models"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now (consider restricting in production)
	},
}

// RealtimeASRMessage represents the vendor-agnostic message format for our API
type RealtimeASRMessage struct {
	Type      string                 `json:"type"`      // "start", "audio", "stop", "result", "error", "end"
	TaskID    string                 `json:"task_id,omitempty"`
	Text      string                 `json:"text,omitempty"`
	IsFinal   bool                   `json:"is_final,omitempty"`
	Timestamp float64                `json:"timestamp,omitempty"` // seconds from start
	Error     string                 `json:"error,omitempty"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
}

// RealtimeASRConfig holds configuration for starting a real-time ASR session
type RealtimeASRConfig struct {
	Model       string `json:"model,omitempty"`        // Model to use (provider-specific)
	SampleRate  int    `json:"sample_rate,omitempty"`  // Audio sample rate (default: 16000)
	Format      string `json:"format,omitempty"`       // Audio format: "pcm", "opus", etc (default: "pcm")
	Language    string `json:"language,omitempty"`     // Language code (optional)
	Diarization bool   `json:"diarization,omitempty"`  // Enable speaker diarization
}

// RealtimeASR handles vendor-agnostic real-time ASR WebSocket connections
func (h *Handlers) RealtimeASR(c *gin.Context) {
	// Upgrade HTTP connection to WebSocket
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("failed to upgrade WebSocket connection")
		return
	}
	defer conn.Close()

	// Load settings for Aliyun credentials
	settings, err := db.LoadUserSettings()
	if err != nil {
		sendError(conn, "failed to load settings: "+err.Error())
		return
	}

	log.Info().Msg("starting real-time ASR session")

	// Use Aliyun Fun-ASR Realtime
	h.handleAliyunRealtimeASR(conn, settings)
}

// handleAliyunRealtimeASR handles the Aliyun Fun-ASR Realtime WebSocket session
func (h *Handlers) handleAliyunRealtimeASR(clientConn *websocket.Conn, settings *models.UserSettings) {
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
	taskID := ""
	var taskIDMutex sync.RWMutex

	// Goroutine 1: Forward messages from client to Aliyun
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			var msg RealtimeASRMessage
			err := clientConn.ReadJSON(&msg)
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Error().Err(err).Msg("client WebSocket read error")
					errChan <- err
				}
				return
			}

			// Handle different message types from client
			switch msg.Type {
			case "start":
				// Parse config if provided
				var config RealtimeASRConfig
				if msg.Metadata != nil {
					configBytes, _ := json.Marshal(msg.Metadata)
					json.Unmarshal(configBytes, &config)
				}

				// Set defaults
				if config.SampleRate == 0 {
					config.SampleRate = 16000
				}
				if config.Format == "" {
					config.Format = "pcm"
				}
				if config.Model == "" {
					// Get model from environment or use default Aliyun Fun-ASR Realtime model
					config.Model = os.Getenv("ALIYUN_ASR_REALTIME_MODEL")
					if config.Model == "" {
						// Default to fun-asr-realtime (same as online demo)
						config.Model = "fun-asr-realtime"
					}
				}

				// Generate task ID
				newTaskID := fmt.Sprintf("task_%d", time.Now().UnixNano())
				taskIDMutex.Lock()
				taskID = newTaskID
				taskIDMutex.Unlock()

				// Build parameters based on config
				// Based on HAR file analysis, the online demo uses:
				// - semantic_punctuation_enabled: false (VAD-based segmentation for lower latency)
				// - max_sentence_silence: 1300 (ms)
				parameters := map[string]interface{}{
					"semantic_punctuation_enabled": false,
					"max_sentence_silence":          1300,
				}

				// Add language hints if specified
				if config.Language != "" {
					parameters["language_hints"] = []string{config.Language}
				}

				// Send run-task message to Aliyun
				runTaskMsg := map[string]interface{}{
					"header": map[string]interface{}{
						"action":    "run-task",
						"task_id":   taskID,
						"streaming": "duplex",
					},
					"payload": map[string]interface{}{
						"task_group": "audio",
						"task":       "asr",
						"function":   "recognition",
						"model":      config.Model,
						"input": map[string]interface{}{
							"format":      config.Format,
							"sample_rate": config.SampleRate,
						},
						"parameters": parameters,
					},
				}

				// Log the message we're sending for debugging
				msgJSON, _ := json.MarshalIndent(runTaskMsg, "", "  ")
				log.Debug().RawJSON("message", msgJSON).Msg("sending run-task to Aliyun")

				if err := aliyunConn.WriteJSON(runTaskMsg); err != nil {
					log.Error().Err(err).Msg("failed to send run-task to Aliyun")
					errChan <- err
					return
				}

				log.Info().Str("taskID", taskID).Msg("sent run-task to Aliyun")

			case "audio":
				// Forward binary audio data to Aliyun
				// The audio data should be in msg.Metadata["data"] as base64 string
				if msg.Metadata != nil && msg.Metadata["data"] != nil {
					audioDataBase64, ok := msg.Metadata["data"].(string)
					if !ok {
						log.Warn().Msg("audio data is not a string")
						continue
					}

					// Decode base64 to binary
					audioData, err := base64.StdEncoding.DecodeString(audioDataBase64)
					if err != nil {
						log.Error().Err(err).Msg("failed to decode base64 audio data")
						continue
					}

					// Send binary message to Aliyun
					if err := aliyunConn.WriteMessage(websocket.BinaryMessage, audioData); err != nil {
						log.Error().Err(err).Msg("failed to send audio to Aliyun")
						errChan <- err
						return
					}
				}

			case "stop":
				// Send finish-task message to Aliyun
				taskIDMutex.RLock()
				currentTaskID := taskID
				taskIDMutex.RUnlock()

				finishTaskMsg := map[string]interface{}{
					"header": map[string]interface{}{
						"action":    "finish-task",
						"task_id":   currentTaskID,
						"streaming": "duplex",
					},
					"payload": map[string]interface{}{
						"input": map[string]interface{}{},
					},
				}

				if err := aliyunConn.WriteJSON(finishTaskMsg); err != nil {
					log.Error().Err(err).Msg("failed to send finish-task to Aliyun")
					errChan <- err
					return
				}

				log.Info().Str("taskID", currentTaskID).Msg("stopped Aliyun ASR task")
				return // Close this goroutine
			}
		}
	}()

	// Goroutine 2: Forward messages from Aliyun to client
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			_, msgBytes, err := aliyunConn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Error().Err(err).Msg("Aliyun WebSocket read error")
					errChan <- err
				}
				return
			}

			// Log raw message for debugging
			log.Debug().Str("raw", string(msgBytes)).Msg("received message from Aliyun")

			// Parse Aliyun message
			var aliyunMsg map[string]interface{}
			if err := json.Unmarshal(msgBytes, &aliyunMsg); err != nil {
				log.Error().Err(err).Str("msg", string(msgBytes)).Msg("failed to parse Aliyun message")
				continue
			}

			// Extract header
			header, ok := aliyunMsg["header"].(map[string]interface{})
			if !ok {
				log.Warn().Interface("msg", aliyunMsg).Msg("Aliyun message missing header")
				continue
			}

			event, _ := header["event"].(string)
			currentTaskID, _ := header["task_id"].(string)

			log.Info().Str("event", event).Str("taskID", currentTaskID).Msg("received Aliyun event")

			// Convert Aliyun events to our vendor-agnostic format
			switch event {
			case "task-started":
				// Send task started event to client
				clientMsg := RealtimeASRMessage{
					Type:   "start",
					TaskID: currentTaskID,
				}
				clientConn.WriteJSON(clientMsg)

			case "result-generated":
				// Extract transcription result
				payload, _ := aliyunMsg["payload"].(map[string]interface{})
				output, _ := payload["output"].(map[string]interface{})
				sentence, _ := output["sentence"].(map[string]interface{})

				text, _ := sentence["text"].(string)
				beginTime, _ := sentence["begin_time"].(float64)
				isFinal := false
				if endTime, ok := sentence["end_time"].(float64); ok && endTime > 0 {
					isFinal = true
				}

				clientMsg := RealtimeASRMessage{
					Type:      "result",
					TaskID:    currentTaskID,
					Text:      text,
					IsFinal:   isFinal,
					Timestamp: beginTime / 1000.0, // Convert ms to seconds
				}
				clientConn.WriteJSON(clientMsg)

			case "task-finished":
				// Send task finished event
				clientMsg := RealtimeASRMessage{
					Type:   "end",
					TaskID: currentTaskID,
				}
				clientConn.WriteJSON(clientMsg)
				return // Close this goroutine

			case "task-failed":
				// Extract error message
				payload, _ := aliyunMsg["payload"].(map[string]interface{})
				message, _ := payload["message"].(string)
				code, _ := payload["code"].(string)

				// Log full payload for debugging
				log.Error().
					Str("code", code).
					Str("message", message).
					Interface("payload", payload).
					Interface("fullMsg", aliyunMsg).
					Msg("Aliyun ASR task failed")

				errorMsg := fmt.Sprintf("ASR task failed: %s (code: %s)", message, code)
				clientMsg := RealtimeASRMessage{
					Type:   "error",
					TaskID: currentTaskID,
					Error:  errorMsg,
				}
				clientConn.WriteJSON(clientMsg)
				return // Close this goroutine
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

// sendError sends an error message to the client
func sendError(conn *websocket.Conn, errMsg string) {
	msg := RealtimeASRMessage{
		Type:  "error",
		Error: errMsg,
	}
	conn.WriteJSON(msg)
}
