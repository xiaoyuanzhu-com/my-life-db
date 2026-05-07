package agentsdk

import (
	"encoding/json"

	acp "github.com/coder/acp-go-sdk"
)

// marshalAny marshals an arbitrary value to json.RawMessage.
// Returns nil if the value is nil.
func marshalAny(v any) (json.RawMessage, error) {
	if v == nil {
		return nil, nil
	}
	return json.Marshal(v)
}

// SynthUserMessageChunk builds a user_message_chunk JSON frame matching the
// ACP SessionUpdate wire format. Used by the host to inject user messages into
// the session state before calling Send(), so they survive burst replay.
//
// When messageId is non-empty, it is included in the frame so the frontend
// can match the chunk to the originating outbox item (the id the client
// minted on session.prompt). Pass "" for chunks that have no upstream id
// (historical replays, server-generated injections).
func SynthUserMessageChunk(text, messageId string) []byte {
	frame := map[string]any{
		"sessionUpdate": "user_message_chunk",
		"content": map[string]any{
			"type": "text",
			"text": text,
		},
	}
	if messageId != "" {
		frame["messageId"] = messageId
	}
	data, _ := json.Marshal(frame)
	return data
}

// extractToolCallOutput extracts readable text from tool call content.
func extractToolCallOutput(content []acp.ToolCallContent) string {
	var output string
	for _, c := range content {
		if c.Content != nil && c.Content.Content.Text != nil {
			output += c.Content.Content.Text.Text
		}
		if c.Diff != nil {
			output += "File: " + c.Diff.Path + "\n" + c.Diff.NewText
		}
		if c.Terminal != nil {
			output += "[terminal: " + c.Terminal.TerminalId + "]"
		}
	}
	return output
}
