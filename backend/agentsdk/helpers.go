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
