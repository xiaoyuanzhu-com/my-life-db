package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// agentSessionStates is a registry of session ID → *SessionState.
// Protected by agentSessionStatesMu.
var (
	agentSessionStatesMu sync.Mutex
	agentSessionStates   = make(map[string]*agentsdk.SessionState)
)

// getOrCreateSessionState returns the SessionState for the given session ID,
// creating one if it doesn't exist.
func getOrCreateSessionState(sessionID string) *agentsdk.SessionState {
	agentSessionStatesMu.Lock()
	defer agentSessionStatesMu.Unlock()

	if state, ok := agentSessionStates[sessionID]; ok {
		return state
	}
	state := agentsdk.NewSessionState()
	agentSessionStates[sessionID] = state
	return state
}

// acpSessions tracks active ACP sessions by session ID.
// Protected by acpSessionsMu.
var (
	acpSessionsMu sync.Mutex
	acpSessions   = make(map[string]agentsdk.Session)
)

// AgentSessionWebSocket handles WebSocket connections for ACP-based agent sessions.
// It translates ACP events into the same JSON format the existing frontend expects.
func (h *Handlers) AgentSessionWebSocket(c *gin.Context) {
	sessionID := c.Param("id")

	log.Info().Str("sessionId", sessionID).Msg("AgentSessionWebSocket: connection request")

	// Get or create session state
	sessionState := getOrCreateSessionState(sessionID)

	// Get the underlying http.ResponseWriter from Gin's wrapper
	var w http.ResponseWriter = c.Writer
	if unwrapper, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		w = unwrapper.Unwrap()
	}

	// Accept WebSocket connection (compression disabled, skip origin check)
	conn, err := websocket.Accept(w, c.Request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("AgentSessionWebSocket: upgrade failed")
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// Abort Gin context to prevent middleware from writing headers on hijacked connection
	c.Abort()

	// Create a cancellable context for this connection
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Monitor server shutdown
	go func() {
		select {
		case <-h.server.ShutdownContext().Done():
			log.Debug().Str("sessionId", sessionID).Msg("server shutdown, closing agent WebSocket")
			cancel()
		case <-ctx.Done():
		}
	}()

	// Track seen result count for read state persistence
	var seenResultCount atomic.Int32

	persistReadState := func() {
		if n := int(seenResultCount.Load()); n > 0 {
			if err := db.MarkClaudeSessionRead(sessionID, n); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist read state")
			} else {
				h.server.Notifications().NotifyClaudeSessionUpdated(sessionID, "read")
			}
		}
	}
	defer persistReadState()

	// Mark session as read on connect
	sessionState.Mu.RLock()
	rc := sessionState.ResultCount
	sessionState.Mu.RUnlock()
	if rc > 0 {
		if err := db.MarkClaudeSessionRead(sessionID, rc); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to mark session read on connect")
		} else {
			h.server.Notifications().NotifyClaudeSessionUpdated(sessionID, "read")
		}
		seenResultCount.Store(int32(rc))
	}

	// Send session_info metadata frame
	totalMessages := len(sessionState.GetRecentMessages(0))
	sessionInfo := map[string]any{
		"type":            "session_info",
		"totalPages":      1,
		"lowestBurstPage": 0,
		"totalMessages":   totalMessages,
	}
	if infoBytes, err := json.Marshal(sessionInfo); err == nil {
		if err := conn.Write(ctx, websocket.MessageText, infoBytes); err != nil {
			return
		}
	}

	// Send initial burst (last ~100 messages)
	burstMessages := sessionState.GetRecentMessages(100)
	if len(burstMessages) > 0 {
		log.Debug().
			Str("sessionId", sessionID).
			Int("burstMessages", len(burstMessages)).
			Msg("sending initial burst to new agent client")

		for _, msgBytes := range burstMessages {
			if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send burst message")
				return
			}
		}
	}

	// Register as client
	uiClient := &agentsdk.WSClient{
		ID:   uuid.New().String(),
		Send: make(chan []byte, 256),
	}
	sessionState.AddClient(uiClient)
	defer sessionState.RemoveClient(uiClient)

	// Goroutine: forward broadcasts to WebSocket
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		for {
			select {
			case <-ctx.Done():
				return
			case data, ok := <-uiClient.Send:
				if !ok {
					return
				}
				if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
					if ctx.Err() == nil {
						log.Debug().Err(err).Str("sessionId", sessionID).Msg("agent WebSocket write failed")
					}
					return
				}
				var mt struct{ Type string `json:"type"` }
				if json.Unmarshal(data, &mt) == nil && mt.Type == "result" {
					seenResultCount.Add(1)
					persistReadState()
				}
			}
		}
	}()

	// Goroutine: ping every 30s
	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		for {
			select {
			case <-ctx.Done():
				return
			case <-pingTicker.C:
				if err := conn.Ping(ctx); err != nil {
					return
				}
			}
		}
	}()

	// Create the bridge for event translation
	bridge := &agentsdk.WSBridge{SessionID: sessionID}

	// Read loop: handle inbound messages
	for {
		msgType, msg, err := conn.Read(ctx)
		if err != nil {
			closeStatus := websocket.CloseStatus(err)
			if closeStatus == websocket.StatusGoingAway ||
				closeStatus == websocket.StatusNormalClosure ||
				closeStatus == websocket.StatusNoStatusRcvd {
				log.Debug().Str("sessionId", sessionID).Int("closeStatus", int(closeStatus)).Msg("agent WebSocket closed normally")
			} else {
				log.Debug().Err(err).Str("sessionId", sessionID).Msg("agent WebSocket read error")
			}
			cancel()
			break
		}

		if msgType != websocket.MessageText {
			continue
		}

		// Parse incoming message
		var inMsg struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(msg, &inMsg); err != nil {
			log.Debug().Err(err).Msg("failed to parse agent WS message")
			continue
		}

		log.Debug().Str("sessionId", sessionID).Str("type", inMsg.Type).Msg("received agent WS message")

		switch inMsg.Type {
		case "user_message":
			msgUUID := uuid.New().String()

			// Broadcast synthetic user message
			userMsg := bridge.UserMessage(inMsg.Content, msgUUID)
			sessionState.AppendAndBroadcast(userMsg)

			// Broadcast system:init
			initMsg := bridge.SystemInitMessage()
			sessionState.AppendAndBroadcast(initMsg)

			// Create ACP session lazily if needed
			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if !exists {
				// Create a new ACP session
				sess, err := h.server.AgentClient().CreateSession(ctx, agentsdk.SessionConfig{
					Agent:       agentsdk.AgentClaudeCode,
					Permissions: agentsdk.PermissionAsk,
				})
				if err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to create ACP session")
					errMsg := map[string]any{
						"type":  "error",
						"error": "Failed to create agent session: " + err.Error(),
					}
					if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
						conn.Write(ctx, websocket.MessageText, msgBytes)
					}
					continue
				}
				acpSessionsMu.Lock()
				acpSessions[sessionID] = sess
				acpSessionsMu.Unlock()
				acpSession = sess
			}

			// Send prompt and start event forwarding
			go func(acpSess agentsdk.Session, prompt string) {
				events, err := acpSess.Send(ctx, prompt)
				if err != nil {
					log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send prompt to ACP session")
					errMsg := map[string]any{
						"type":  "error",
						"error": "Failed to send message: " + err.Error(),
					}
					if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
						sessionState.AppendAndBroadcast(msgBytes)
					}
					return
				}

				sessionState.Mu.Lock()
				sessionState.IsProcessing = true
				sessionState.Mu.Unlock()

				for event := range events {
					translated := bridge.TranslateEvent(event)
					for _, jsonMsg := range translated {
						sessionState.AppendAndBroadcast(jsonMsg)
					}
					if event.Type == agentsdk.EventComplete {
						sessionState.Mu.Lock()
						sessionState.ResultCount++
						sessionState.IsProcessing = false
						sessionState.Mu.Unlock()
						h.server.Notifications().NotifyClaudeSessionUpdated(sessionID, "result")
					}
				}
			}(acpSession, inMsg.Content)

			// Auto-unarchive
			if archived, err := db.IsClaudeSessionArchived(sessionID); err == nil && archived {
				if err := db.UnarchiveClaudeSession(sessionID); err != nil {
					log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to auto-unarchive session")
				} else {
					log.Info().Str("sessionId", sessionID).Msg("auto-unarchived session on new message")
				}
			}

			log.Info().
				Str("sessionId", sessionID).
				Str("content", inMsg.Content).
				Msg("message sent to agent session via WebSocket")

		case "control_response", "permission_response":
			// Parse permission response
			var permResp struct {
				RequestID string `json:"request_id"`
				Response  struct {
					Response struct {
						Behavior string `json:"behavior"`
					} `json:"response"`
				} `json:"response"`
			}
			if err := json.Unmarshal(msg, &permResp); err != nil {
				log.Debug().Err(err).Msg("failed to parse permission response")
				break
			}

			acpSessionsMu.Lock()
			acpSession, exists := acpSessions[sessionID]
			acpSessionsMu.Unlock()

			if !exists {
				log.Warn().Str("sessionId", sessionID).Msg("no ACP session for permission response")
				break
			}

			allowed := permResp.Response.Response.Behavior != "deny"

			if err := acpSession.RespondToPermission(ctx, permResp.RequestID, allowed); err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to respond to permission")
			}

			log.Info().
				Str("sessionId", sessionID).
				Str("requestId", permResp.RequestID).
				Bool("allowed", allowed).
				Msg("sent permission response to agent")

		case "control_request":
			// Parse the control request
			var controlReq struct {
				Request struct {
					Subtype string `json:"subtype"`
					Mode    string `json:"mode"`
				} `json:"request"`
			}
			if err := json.Unmarshal(msg, &controlReq); err != nil {
				log.Debug().Err(err).Msg("failed to parse control_request")
				break
			}

			switch controlReq.Request.Subtype {
			case "interrupt":
				acpSessionsMu.Lock()
				acpSession, exists := acpSessions[sessionID]
				acpSessionsMu.Unlock()

				if exists {
					if err := acpSession.Stop(); err != nil {
						log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to interrupt agent session")
					} else {
						log.Info().Str("sessionId", sessionID).Msg("agent session interrupted via WebSocket")
					}
				}

			case "set_permission_mode":
				// Store preference — currently informational only for ACP sessions
				log.Info().
					Str("sessionId", sessionID).
					Str("mode", controlReq.Request.Mode).
					Msg("permission mode preference noted (ACP)")
			}

		default:
			log.Debug().Str("type", inMsg.Type).Msg("unknown agent WS message type")
		}
	}

	<-pollDone
	<-pingDone
}
