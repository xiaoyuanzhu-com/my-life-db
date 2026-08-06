package agentsdk

import (
	"encoding/json"
	"strings"
)

// CompactCompletedTurnFrames coalesces adjacent text chunks only inside turns
// that have both explicit turn.start and turn.complete boundaries. Incomplete
// turns and frames outside a turn are returned unchanged.
func CompactCompletedTurnFrames(frames [][]byte) [][]byte {
	if len(frames) < 2 {
		return frames
	}

	compacted := make([][]byte, 0, len(frames))
	var pendingTurn [][]byte

	for _, frame := range frames {
		switch frameDiscriminator(frame) {
		case "turn.start":
			if len(pendingTurn) > 0 {
				compacted = append(compacted, pendingTurn...)
			}
			pendingTurn = [][]byte{frame}

		case "turn.complete":
			if len(pendingTurn) == 0 {
				compacted = append(compacted, frame)
				continue
			}
			pendingTurn = append(pendingTurn, frame)
			compacted = append(compacted, compactAdjacentTextChunks(pendingTurn)...)
			pendingTurn = nil

		default:
			if len(pendingTurn) > 0 {
				pendingTurn = append(pendingTurn, frame)
			} else {
				compacted = append(compacted, frame)
			}
		}
	}

	compacted = append(compacted, pendingTurn...)
	return compacted
}

func frameDiscriminator(frame []byte) string {
	var envelope struct {
		Type          string `json:"type"`
		SessionUpdate string `json:"sessionUpdate"`
	}
	if err := json.Unmarshal(frame, &envelope); err != nil {
		return ""
	}
	if envelope.Type != "" {
		return envelope.Type
	}
	return envelope.SessionUpdate
}

type mergeableTextChunk struct {
	frame     map[string]any
	signature string
	text      string
	original  []byte
}

func parseMergeableTextChunk(frame []byte) (*mergeableTextChunk, bool) {
	var envelope map[string]any
	if err := json.Unmarshal(frame, &envelope); err != nil {
		return nil, false
	}

	discriminator, _ := envelope["sessionUpdate"].(string)
	if discriminator != "agent_message_chunk" && discriminator != "agent_thought_chunk" {
		return nil, false
	}

	content, ok := envelope["content"].(map[string]any)
	if !ok || content["type"] != "text" {
		return nil, false
	}
	text, ok := content["text"].(string)
	if !ok {
		return nil, false
	}

	content["text"] = ""
	signature, err := json.Marshal(envelope)
	if err != nil {
		return nil, false
	}

	return &mergeableTextChunk{
		frame:     envelope,
		signature: string(signature),
		text:      text,
		original:  frame,
	}, true
}

func compactAdjacentTextChunks(frames [][]byte) [][]byte {
	compacted := make([][]byte, 0, len(frames))
	var current *mergeableTextChunk
	var text strings.Builder
	var originals [][]byte

	flush := func() {
		if current == nil {
			return
		}
		if len(originals) == 1 {
			compacted = append(compacted, current.original)
		} else {
			content := current.frame["content"].(map[string]any)
			content["text"] = text.String()
			merged, err := json.Marshal(current.frame)
			if err != nil {
				compacted = append(compacted, originals...)
			} else {
				compacted = append(compacted, merged)
			}
		}
		current = nil
		text.Reset()
		originals = nil
	}

	for _, frame := range frames {
		chunk, ok := parseMergeableTextChunk(frame)
		if !ok {
			flush()
			compacted = append(compacted, frame)
			continue
		}

		if current != nil && current.signature == chunk.signature {
			text.WriteString(chunk.text)
			originals = append(originals, frame)
			continue
		}

		flush()
		current = chunk
		text.WriteString(chunk.text)
		originals = append(originals, frame)
	}
	flush()

	return compacted
}
