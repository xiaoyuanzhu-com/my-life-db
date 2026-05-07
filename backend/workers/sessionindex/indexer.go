// Package sessionindex periodically re-indexes agent session transcripts into
// the agent_sessions_fts table so they can be full-text searched.
//
// Design (per design discussion):
//   - One FTS row per session — the entire transcript blob.
//   - Driven by a DB timestamp (agent_sessions.last_message_at), not file
//     mtime, so it works the same regardless of where transcript bytes live.
//   - Periodic sweep on a fixed interval (default 5m). Sweep compares
//     last_message_at vs last_indexed_at and re-indexes any session whose
//     activity moved forward.
//   - Eventually consistent: the user's actively-typed-in session may not be
//     searchable for up to one sweep interval. That's fine — recently-used
//     sessions are the ones the user is least likely to need to search.
//   - Deletes: any session present in the index but missing from app DB is
//     dropped on the next sweep.
package sessionindex

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// DefaultSweepInterval is the default period between sweep ticks.
const DefaultSweepInterval = 5 * time.Minute

// Indexer re-indexes agent session transcripts into agent_sessions_fts.
type Indexer struct {
	appDB      *db.DB
	indexDB    *db.DB
	frameStore *agentsdk.FrameStore
	interval   time.Duration
}

// New creates an Indexer. interval can be zero to use DefaultSweepInterval.
func New(appDB, indexDB *db.DB, frameStore *agentsdk.FrameStore, interval time.Duration) *Indexer {
	if interval <= 0 {
		interval = DefaultSweepInterval
	}
	return &Indexer{
		appDB:      appDB,
		indexDB:    indexDB,
		frameStore: frameStore,
		interval:   interval,
	}
}

// Start runs the periodic sweep. Returns when ctx is cancelled.
//
// Runs an initial sweep immediately on startup so a fresh database (or one
// that was offline through several activity windows) catches up without
// waiting a full interval.
func (idx *Indexer) Start(ctx context.Context) {
	log.Info().Dur("interval", idx.interval).Msg("session indexer: starting")

	idx.SweepOnce(ctx)

	t := time.NewTicker(idx.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("session indexer: stopping")
			return
		case <-t.C:
			idx.SweepOnce(ctx)
		}
	}
}

// SweepOnce performs a single sweep pass. Exposed for tests and the startup
// catch-up call in Start.
func (idx *Indexer) SweepOnce(ctx context.Context) {
	sessions, err := idx.appDB.ListAgentSessionsForIndex()
	if err != nil {
		log.Error().Err(err).Msg("session indexer: failed to list sessions")
		return
	}
	state, err := idx.indexDB.GetAllAgentSessionIndexState()
	if err != nil {
		log.Error().Err(err).Msg("session indexer: failed to load index state")
		return
	}

	indexed, skipped, failed := 0, 0, 0
	live := make(map[string]struct{}, len(sessions))
	for _, s := range sessions {
		live[s.SessionID] = struct{}{}

		if ctx.Err() != nil {
			return
		}

		lastIndexed := state[s.SessionID]
		if lastIndexed > 0 && lastIndexed >= s.LastMessageAt {
			skipped++
			continue
		}

		// Indexed-at is the moment we read the transcript; if more frames are
		// appended after this point, the next bump of last_message_at will be
		// strictly greater and the next sweep picks them up.
		indexedAt := db.NowMs()
		content := idx.extractTranscript(s.SessionID)
		if err := idx.indexDB.IndexAgentSession(ctx, s.SessionID, content, indexedAt); err != nil {
			log.Error().Err(err).Str("sessionId", s.SessionID).Msg("session indexer: failed to index session")
			failed++
			continue
		}
		indexed++
	}

	// Deletions: any session in the index that's no longer in the app DB.
	dropped := 0
	for sessionID := range state {
		if _, ok := live[sessionID]; ok {
			continue
		}
		if err := idx.indexDB.DeleteAgentSessionFromIndex(ctx, sessionID); err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("session indexer: failed to drop stale index row")
			continue
		}
		dropped++
	}

	log.Info().
		Int("indexed", indexed).
		Int("skipped", skipped).
		Int("failed", failed).
		Int("dropped", dropped).
		Int("total", len(sessions)).
		Msg("session indexer: sweep complete")
}

// extractTranscript reads the session's persisted ACP frames and concatenates
// the human-readable text into a single blob suitable for FTS5.
//
// We only pull text from message-chunk frames (user/agent/thought) — tool
// calls, permission prompts, and metadata frames are excluded so search
// results match what the user actually said and the assistant actually
// replied. If the frame store has no file for the session, we still index
// an empty blob so the FTS row exists (and can be updated later).
func (idx *Indexer) extractTranscript(sessionID string) string {
	if idx.frameStore == nil {
		return ""
	}
	frames, err := idx.frameStore.Load(sessionID)
	if err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("session indexer: failed to load frames")
		return ""
	}

	var b strings.Builder
	for _, frame := range frames {
		text := extractFrameText(frame)
		if text == "" {
			continue
		}
		b.WriteString(text)
		b.WriteByte('\n')
	}
	return b.String()
}

// extractFrameText pulls the text payload from a single ACP frame if it is one
// of the message-chunk variants. Returns "" for any other frame type or if the
// frame can't be parsed.
//
// Two shapes exist in the wild:
//
//   - ACP-emitted (real frames from the agent CLI): content is the ACP
//     ContentBlock union, marshalled as { "text": { "text": "..." } }.
//   - Synthesized by the host (agentsdk.SynthUserMessageChunk for user echoes
//     during live prompts): content is a flat { "type": "text", "text": "..." }.
//
// We accept both. Tool calls, permission requests, and metadata frames are
// excluded so search results match what the user actually said and the
// assistant actually replied.
func extractFrameText(frame []byte) string {
	var msg struct {
		SessionUpdate string          `json:"sessionUpdate"`
		Content       json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(frame, &msg); err != nil {
		return ""
	}
	switch msg.SessionUpdate {
	case "user_message_chunk", "agent_message_chunk", "agent_thought_chunk":
	default:
		return ""
	}
	if len(msg.Content) == 0 {
		return ""
	}

	// Try the ACP-emitted shape first: content.text.text.
	var nested struct {
		Text struct {
			Text string `json:"text"`
		} `json:"text"`
	}
	if err := json.Unmarshal(msg.Content, &nested); err == nil && nested.Text.Text != "" {
		return nested.Text.Text
	}

	// Fall back to the synth shape: { type: "text", text: "..." }.
	var flat struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(msg.Content, &flat); err == nil && flat.Type == "text" {
		return flat.Text
	}
	return ""
}
