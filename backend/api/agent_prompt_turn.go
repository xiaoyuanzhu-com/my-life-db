package api

import (
	"context"
	"encoding/json"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// RunPromptTurn drives one prompt-and-stream turn on a live ACP session.
//
// Lifecycle handled here: SetProcessing(true/false), emitting turn.start,
// watching for process death, calling acpSess.Send and draining its events
// channel, detecting in-band error frames, persisting the turn outcome
// (errored vs completed), and the post-error ACP teardown that lets the
// next prompt respawn a fresh process (see comment in the error branch
// below — and session.cancel in agent_ws.go — for why this is needed).
//
// Contract with the caller:
//   - `done` MUST already be registered with sessionState.RegisterPrompt
//     before this is invoked, so a concurrent WaitForPrompt can't race a
//     not-yet-registered in-flight prompt. The helper closes `done` on exit.
//   - `pCtx`/`pCancel` are the per-prompt context pair. The helper defers
//     pCancel() so the process-death watcher goroutine always exits.
//   - The caller has already emitted the synthetic user_message_chunk if it
//     wants one (paths differ in how they handle messageId echo).
//
// `sourceLabel` is a short string like "ws", "user", "auto" that appears
// in IsProcessing transition logs.
func (m *AgentManager) RunPromptTurn(
	pCtx context.Context,
	pCancel context.CancelFunc,
	done chan struct{},
	acpSess agentsdk.Session,
	sessionState *agentsdk.SessionState,
	sessionID string,
	promptText string,
	sourceLabel string,
) {
	defer close(done)
	defer pCancel()

	sessionState.Mu.Lock()
	sessionState.SetProcessing(true, sourceLabel+"-prompt")
	sessionState.IsActive = true
	sessionState.Killed = false // reset from any previous force-kill
	sessionState.TouchFrame()
	sessionState.Mu.Unlock()
	m.notifService.NotifyAgentSessionUpdated(sessionID, "working")

	// Process-death watcher: if the agent process exits mid-turn, cancel
	// pCtx so conn.Prompt unblocks and the events channel closes.
	go func() {
		select {
		case <-acpSess.Done():
			log.Info().Str("sessionId", sessionID).Str("source", sourceLabel).Msg("agent process exited during prompt")
			pCancel()
		case <-pCtx.Done():
		}
	}()

	// turn.start so the frontend knows processing has begun even before
	// any content frames arrive (also persists for burst replay).
	if startBytes, err := json.Marshal(map[string]any{"type": "turn.start"}); err == nil {
		sessionState.AppendAndBroadcast(startBytes)
	}

	events, err := acpSess.Send(pCtx, promptText)
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send prompt to ACP session")
		sessionState.Mu.Lock()
		killed := sessionState.Killed
		if !killed {
			sessionState.SetProcessing(false, sourceLabel+"-prompt-send-error")
		}
		sessionState.ClearPrompt()
		sessionState.Mu.Unlock()
		if killed {
			return
		}
		if dbErr := m.srv.AppDB().MarkTurnOutcome(context.Background(), sessionID, db.OutcomeErrored, err.Error(), db.NowMs()); dbErr != nil {
			log.Warn().Err(dbErr).Str("sessionId", sessionID).Msg("failed to persist errored outcome")
		}
		if errBytes, mErr := json.Marshal(map[string]any{
			"type": "error", "message": "Failed to send message: " + err.Error(), "code": "SEND_ERROR",
		}); mErr == nil {
			sessionState.AppendAndBroadcast(errBytes)
		}
		m.notifService.NotifyAgentSessionUpdated(sessionID, "result")
		return
	}

	sawErrorFrame := false
	var errorFrameMsg string
	for frame := range events {
		// Skip frames if session was force-killed (kill handler already
		// emitted turn.complete).
		sessionState.Mu.RLock()
		killed := sessionState.Killed
		sessionState.Mu.RUnlock()
		if killed {
			continue
		}

		// Detect error frames so we can persist OutcomeErrored and trigger
		// the ACP wedge workaround below.
		var ft struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		}
		if json.Unmarshal(frame, &ft) == nil && ft.Type == "error" {
			sawErrorFrame = true
			errorFrameMsg = ft.Message
		}

		sessionState.AppendAndBroadcast(frame)
	}

	// Channel closed = turn complete.
	sessionState.Mu.Lock()
	killed := sessionState.Killed
	newResultCount := sessionState.ResultCount
	if !killed {
		// Don't count an errored turn as a "result" — there's nothing the
		// user should treat as unread output.
		if !sawErrorFrame {
			sessionState.ResultCount++
			newResultCount = sessionState.ResultCount
		}
		sessionState.SetProcessing(false, sourceLabel+"-prompt-complete")
	}
	sessionState.ClearPrompt()
	sessionState.Mu.Unlock()

	if killed {
		return
	}

	if sawErrorFrame {
		// ACP wedge workaround. After conn.Prompt returns an error,
		// claude-agent-acp's server is in a state where the next
		// conn.Prompt() returns stopReason=end_turn with zero content
		// frames, and the actual response to the next prompt is held back
		// internally and leaks out on the prompt AFTER that. Same desync
		// as the cancel case (see session.cancel handler in agent_ws.go),
		// so apply the same heavy-handed fix: kill the subprocess and let
		// ensureLiveACPSession respawn it on the next user prompt.
		// LoadSession on the lazy-create path restores in-session
		// conversation memory.
		if existing, exists := m.GetSession(sessionID); exists {
			m.RemoveSession(sessionID)
			existing.CancelAllPermissions()
			if err := existing.Close(); err != nil {
				log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to close ACP session after error frame")
			} else {
				log.Info().Str("sessionId", sessionID).Str("source", sourceLabel).Msg("closed ACP session after error frame — next prompt will respawn")
			}
		}
		if err := m.srv.AppDB().MarkTurnOutcome(context.Background(), sessionID, db.OutcomeErrored, errorFrameMsg, db.NowMs()); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist errored outcome")
		}
		m.notifService.NotifyAgentSessionUpdated(sessionID, "result")
		return
	}

	// Normal completion: persist outcome + count, notify clients.
	if err := m.srv.AppDB().MarkTurnOutcome(context.Background(), sessionID, db.OutcomeCompleted, "", db.NowMs()); err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist completed outcome")
	}
	if err := m.srv.AppDB().UpdateAgentSessionResultCount(context.Background(), sessionID, newResultCount); err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to persist result count")
	}
	m.notifService.NotifyAgentSessionUpdated(sessionID, "result")
}
