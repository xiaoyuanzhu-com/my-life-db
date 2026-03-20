package agentsdk

import (
	"encoding/json"
	"testing"
)

func TestMarshalEnvelope_BasicFields(t *testing.T) {
	data, err := MarshalEnvelope("agent.messageChunk", "sess-123", map[string]any{
		"content": map[string]any{"type": "text", "text": "hello"},
	})
	if err != nil {
		t.Fatal(err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}

	if parsed["type"] != "agent.messageChunk" {
		t.Errorf("type = %v, want agent.messageChunk", parsed["type"])
	}
	if parsed["sessionId"] != "sess-123" {
		t.Errorf("sessionId = %v, want sess-123", parsed["sessionId"])
	}
	if _, ok := parsed["ts"]; !ok {
		t.Error("missing ts field")
	}
	content, ok := parsed["content"].(map[string]any)
	if !ok {
		t.Fatal("missing or wrong content field")
	}
	if content["text"] != "hello" {
		t.Errorf("content.text = %v, want hello", content["text"])
	}
}

func TestMarshalEnvelope_EmptyPayload(t *testing.T) {
	data, err := MarshalEnvelope("turn.start", "sess-123", nil)
	if err != nil {
		t.Fatal(err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}

	if len(parsed) != 3 {
		t.Errorf("expected 3 fields (type, sessionId, ts), got %d", len(parsed))
	}
}

func TestSessionInfoEnvelope(t *testing.T) {
	data, err := SessionInfoEnvelope("s1", 42, true)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["type"] != "session.info" {
		t.Errorf("type = %v", parsed["type"])
	}
	if parsed["totalMessages"] != float64(42) {
		t.Errorf("totalMessages = %v", parsed["totalMessages"])
	}
	if parsed["isProcessing"] != true {
		t.Errorf("isProcessing = %v", parsed["isProcessing"])
	}
}

func TestPermissionRequestEnvelope(t *testing.T) {
	data, err := PermissionRequestEnvelope("s1",
		map[string]any{"toolCallId": "tc1", "title": "Write foo", "kind": "edit"},
		[]map[string]any{
			{"optionId": "o1", "name": "Allow", "kind": "allow_once"},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["type"] != "permission.request" {
		t.Errorf("type = %v", parsed["type"])
	}
	tc := parsed["toolCall"].(map[string]any)
	if tc["toolCallId"] != "tc1" {
		t.Errorf("toolCallId = %v", tc["toolCallId"])
	}
}
