package claude

import (
	"encoding/json"
	"strings"
)

// StripReadToolContent removes file content from Read tool results in a message.
// This reduces message size significantly — Read results can be 50–65 KB each due to
// full file contents embedded in both toolUseResult.file.content and message.content[].
//
// After stripping, the message retains line count metadata (numLines, totalLines) so
// the frontend can still render "Read N lines" summaries.
//
// Non-user messages and non-Read tool results are returned unchanged.
func StripReadToolContent(data []byte) []byte {
	// Quick-check: only transform "user" type messages (most messages are skipped here)
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil || envelope.Type != "user" {
		return data
	}

	// Parse into generic map to preserve all unknown fields during re-serialization
	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		return data
	}

	stripped := false

	// Strip toolUseResult.file.content for Read results
	if stripped = stripToolUseResult(msg); !stripped {
		return data
	}

	// Also strip the raw tool_result content in message.content[] —
	// this is the API-level content block that also contains the full file text.
	stripToolResultBlocks(msg)

	// Re-serialize
	result, err := json.Marshal(msg)
	if err != nil {
		return data // Fall back to original on marshal error
	}
	return result
}

// stripToolUseResult checks if toolUseResult is a Read result and strips file content.
// Returns true if the message was a Read result (regardless of whether content was present).
func stripToolUseResult(msg map[string]interface{}) bool {
	toolUseResult, ok := msg["toolUseResult"].(map[string]interface{})
	if !ok {
		return false
	}

	// Read results have { type: "text", file: { ... } }
	if toolUseResult["type"] != "text" {
		return false
	}
	fileObj, ok := toolUseResult["file"].(map[string]interface{})
	if !ok {
		return false
	}

	// Extract content to count lines before stripping
	content, _ := fileObj["content"].(string)
	if content == "" {
		// No content to strip, but still a Read result
		return true
	}

	lineCount := countLines(content)

	// Preserve line count metadata if not already present
	if _, exists := fileObj["numLines"]; !exists {
		fileObj["numLines"] = lineCount
	}
	if _, exists := fileObj["totalLines"]; !exists {
		fileObj["totalLines"] = lineCount
	}

	// Strip the content
	delete(fileObj, "content")
	return true
}

// stripToolResultBlocks replaces the content of tool_result blocks in message.content[].
// These blocks contain the same file text as toolUseResult and are used only as a fallback.
func stripToolResultBlocks(msg map[string]interface{}) {
	msgObj, ok := msg["message"].(map[string]interface{})
	if !ok {
		return
	}
	contentArr, ok := msgObj["content"].([]interface{})
	if !ok {
		return
	}
	for _, block := range contentArr {
		blockMap, ok := block.(map[string]interface{})
		if !ok {
			continue
		}
		if blockMap["type"] == "tool_result" {
			blockMap["content"] = ""
		}
	}
}

// countLines returns the number of lines in a string.
// An empty string returns 0; a non-empty string returns at least 1.
func countLines(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}
