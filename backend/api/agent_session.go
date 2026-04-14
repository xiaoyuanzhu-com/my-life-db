package api

import (
	"context"
	"encoding/json"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
	"github.com/xiaoyuanzhu-com/my-life-db/notifications"
)

// SessionParams configures a new agent session. Used by both the REST API
// (user-initiated) and the agent runner (auto-triggered).
type SessionParams struct {
	AgentType      string // "claude_code" or "codex"
	WorkingDir     string
	Title          string
	Message        string // initial prompt; empty = no prompt sent
	PermissionMode string // e.g. "bypassPermissions"; empty = default
	Source         string // "user" or "auto"
	AgentFile      string // agent definition file (auto-run only)
}

// SessionHandle is returned by CreateSession so the caller can manage
// the session lifecycle (e.g. close after completion for auto-run).
type SessionHandle struct {
	ID           string
	AcpSession   agentsdk.Session
	SessionState *agentsdk.SessionState
	// PromptDone is closed when the initial prompt completes.
	// Nil if no message was provided.
	PromptDone <-chan struct{}
}

// CreateSession is the shared internal function for creating an agent session.
// It spawns the ACP process, persists to DB, wires frame broadcasting, synths
// the user message, and sends the initial prompt.
//
// The caller owns the ACP session lifecycle — for user sessions it stays alive
// for interactive WebSocket use; for auto-run sessions the caller closes it
// after the prompt completes.
func CreateSession(
	ctx context.Context,
	agentClient *agentsdk.Client,
	notifService *notifications.Service,
	shutdownCtx context.Context,
	params SessionParams,
) (*SessionHandle, error) {
	// Map agentType string to agentsdk.AgentType
	agentTypeStr := params.AgentType
	if agentTypeStr == "" {
		agentTypeStr = "claude_code"
	}
	agentType := agentsdk.AgentClaudeCode
	if agentTypeStr == "codex" {
		agentType = agentsdk.AgentCodex
	}

	// Spawn ACP agent process.
	sess, err := agentClient.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:      agentType,
		Mode:       params.PermissionMode,
		WorkingDir: params.WorkingDir,
	})
	if err != nil {
		return nil, err
	}

	sessionID := sess.ID()

	// Persist to database
	if err := db.CreateAgentSession(sessionID, agentTypeStr, params.WorkingDir, params.Title, params.Source, params.AgentFile); err != nil {
		log.Error().Err(err).Msg("failed to create agent session in DB")
		sess.Close()
		return nil, err
	}

	// Save permission mode if provided
	if params.PermissionMode != "" {
		db.SaveAgentSessionPermissionMode(sessionID, params.PermissionMode)
	}

	// Wire frame broadcasting
	sessionState := GetOrCreateSessionState(sessionID)
	sess.SetOnFrame(func(data []byte) {
		sessionState.Mu.Lock()
		sessionState.TouchFrame()
		sessionState.Mu.Unlock()
		sessionState.AppendAndBroadcast(data)
	})

	// Set mode after onFrame so the mode-change event is captured
	if params.PermissionMode != "" {
		if err := sess.SetMode(context.Background(), params.PermissionMode); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Str("mode", params.PermissionMode).Msg("failed to set initial mode")
		}
	}

	// Store in the in-memory map for WebSocket handler access
	StoreAcpSession(sessionID, sess)

	log.Info().
		Str("sessionId", sessionID).
		Str("agentType", agentTypeStr).
		Str("workingDir", params.WorkingDir).
		Str("source", params.Source).
		Msg("agent session created")

	// Synthesize user message so it appears in the chat UI
	var promptDone chan struct{}
	if params.Message != "" {
		promptDone = make(chan struct{})
		sessionState.AppendAndBroadcast(agentsdk.SynthUserMessageChunk(params.Message))

		// Send prompt in a background goroutine
		go func(acpSess agentsdk.Session, prompt string) {
			defer close(promptDone)

			sessionState.Mu.Lock()
			sessionState.SetProcessing(true, params.Source+"-prompt")
			sessionState.IsActive = true
			sessionState.TouchFrame()
			sessionState.Mu.Unlock()
			notifService.NotifyAgentSessionUpdated(sessionID, "working")

			sendCtx, cancel := context.WithCancel(shutdownCtx)
			defer cancel()

			// Register with SessionState so WS handler can coordinate
			internalDone := make(chan struct{})
			defer close(internalDone)
			sessionState.Mu.Lock()
			sessionState.RegisterPrompt(internalDone, cancel)
			sessionState.Mu.Unlock()

			// Monitor process exit
			go func() {
				select {
				case <-acpSess.Done():
					log.Info().Str("sessionId", sessionID).Msg("agent process exited during prompt")
					cancel()
				case <-sendCtx.Done():
				}
			}()

			// Emit turn.start so the frontend knows processing has begun.
			// Stored in rawMessages for burst replay on reconnect.
			if startBytes, err := json.Marshal(map[string]any{
				"type": "turn.start",
			}); err == nil {
				sessionState.AppendAndBroadcast(startBytes)
			}

			events, err := acpSess.Send(sendCtx, prompt)
			if err != nil {
				log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send prompt")
				sessionState.Mu.Lock()
				sessionState.SetProcessing(false, params.Source+"-prompt-send-error")
				sessionState.Mu.Unlock()
				if errBytes, err := json.Marshal(map[string]any{
					"type": "error", "message": "Failed to send message: " + err.Error(), "code": "SEND_ERROR",
				}); err == nil {
					sessionState.AppendAndBroadcast(errBytes)
				}
				notifService.NotifyAgentSessionUpdated(sessionID, "result")
				return
			}

			// The events channel contains synthetic frames (turn.complete,
			// session.modeUpdate, session.modelsUpdate, errors) that are NOT
			// delivered via onFrame — they must be broadcast explicitly.
			frameCount := 0
			for frame := range events {
				frameCount++
				sessionState.AppendAndBroadcast(frame)
			}

			// Channel closed = turn complete
			sessionState.Mu.Lock()
			sessionState.ResultCount++
			sessionState.SetProcessing(false, params.Source+"-prompt-complete")
			sessionState.ClearPrompt()
			sessionState.Mu.Unlock()

			// Detect zero-output turns
			if frameCount <= 1 {
				log.Info().
					Str("sessionId", sessionID).
					Int("frameCount", frameCount).
					Msg("zero-output turn detected: agent produced no content")
				if errBytes, err := json.Marshal(map[string]any{
					"type":    "error",
					"message": "The agent returned an empty response. This can happen when the session state is corrupted — try sending your message again or start a new session.",
					"code":    "EMPTY_RESPONSE",
				}); err == nil {
					sessionState.AppendAndBroadcast(errBytes)
				}
			}
			notifService.NotifyAgentSessionUpdated(sessionID, "result")
		}(sess, params.Message)
	}

	return &SessionHandle{
		ID:           sessionID,
		AcpSession:   sess,
		SessionState: sessionState,
		PromptDone:   promptDone,
	}, nil
}
