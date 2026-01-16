package api

import (
	"encoding/json"
	"net/http"
	"sync"

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

// AliyunASRMessage represents the Aliyun Fun-ASR Realtime message format
// We use this schema directly as our API schema for simplicity
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
// This is a transparent proxy - messages are forwarded as-is without transformation
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

	// Goroutine 1: Forward messages from client to Aliyun (transparent proxy)
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
				// Parse to check the action and optionally inject defaults
				var msg AliyunASRMessage
				if err := json.Unmarshal(message, &msg); err != nil {
					log.Error().Err(err).Msg("failed to parse client message")
					continue
				}

				// Log the message for debugging
				log.Info().RawJSON("clientMsg", message).Msg("📤 Client → Aliyun (text)")

				// If it's a run-task, inject defaults
				if header, ok := msg.Header["action"].(string); ok && header == "run-task" {
					// Log task ID if present
					if tid, ok := msg.Header["task_id"].(string); ok {
						log.Info().Str("taskID", tid).Msg("starting ASR task")
					}

					// Inject default parameters if not provided
					if payload, ok := msg.Payload["parameters"].(map[string]interface{}); !ok || payload == nil {
						if msg.Payload == nil {
							msg.Payload = make(map[string]interface{})
						}
						msg.Payload["parameters"] = map[string]interface{}{
							"semantic_punctuation_enabled": false,
							"max_sentence_silence":          1300,
						}
					}

					// Re-marshal with defaults
					message, _ = json.Marshal(msg)
				}

				// Forward the message to Aliyun
				if err := aliyunConn.WriteMessage(websocket.TextMessage, message); err != nil {
					log.Error().Err(err).Msg("failed to forward message to Aliyun")
					errChan <- err
					return
				}
			} else if messageType == websocket.BinaryMessage {
				// Forward binary audio data directly
				log.Debug().Int("bytes", len(message)).Msg("🎤 Client → Aliyun (binary audio)")
				if err := aliyunConn.WriteMessage(websocket.BinaryMessage, message); err != nil {
					log.Error().Err(err).Msg("failed to forward audio to Aliyun")
					errChan <- err
					return
				}
			}
		}
	}()

	// Goroutine 2: Forward messages from Aliyun to client (transparent proxy)
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

			// Log message for debugging
			if messageType == websocket.TextMessage {
				log.Info().RawJSON("aliyunMsg", message).Msg("📥 Aliyun → Client (text)")
			} else if messageType == websocket.BinaryMessage {
				log.Debug().Int("bytes", len(message)).Msg("📥 Aliyun → Client (binary)")
			}

			// Forward the message directly to client
			if err := clientConn.WriteMessage(messageType, message); err != nil {
				// If client already closed, this is expected during shutdown
				log.Debug().Err(err).Msg("failed to forward message to client (client may have closed)")
				return
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

// sendError sends an error message to the client (using Aliyun schema)
func sendError(conn *websocket.Conn, errMsg string) {
	msg := AliyunASRMessage{
		Header: map[string]interface{}{
			"event": "task-failed",
		},
		Payload: map[string]interface{}{
			"message": errMsg,
		},
	}
	conn.WriteJSON(msg)
}
