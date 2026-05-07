package agentsdk

import (
	"encoding/json"
	"errors"
	"testing"

	acp "github.com/coder/acp-go-sdk"
)

func TestHumanizeAgentError_PlainError(t *testing.T) {
	got, data := humanizeAgentError(errors.New("boom"))
	if got != "boom" {
		t.Errorf("plain error: got %q, want %q", got, "boom")
	}
	if data != nil {
		t.Errorf("plain error: data should be nil, got %v", data)
	}
}

func TestHumanizeAgentError_Nil(t *testing.T) {
	got, data := humanizeAgentError(nil)
	if got != "" || data != nil {
		t.Errorf("nil: got (%q, %v), want (\"\", nil)", got, data)
	}
}

// TestHumanizeAgentError_LiteLLMThinkingSignature reproduces the real-world
// failure the user reported: a LiteLLM-gateway 400 wrapping an Anthropic
// thinking-block-signature error, JSON-encoded three layers deep.
func TestHumanizeAgentError_LiteLLMThinkingSignature(t *testing.T) {
	// Layer 3 (innermost): Anthropic API envelope.
	innermost := `{"type":"error","error":{"type":"invalid_request_error","message":"messages.13.content.0: Invalid ` + "`signature`" + ` in ` + "`thinking`" + ` block"},"request_id":"req_011CantepzRyZjaLg3Xsn2rv"}`
	// Layer 2: LiteLLM error envelope holding the Anthropic envelope as a
	// JSON string. Note the trailing "Received Model Group=..." text after
	// the closing brace — humanizeAgentError must tolerate trailing data.
	gatewayBody, err := jsonEncodeString(innermost)
	if err != nil {
		t.Fatal(err)
	}
	layer2 := `{"error":{"message":` + gatewayBody + `,"type":"None","param":"None","code":"400"}}. Received Model Group=claude-opus-4-7\nAvailable Model Group Fallbacks=None`
	// Layer 1: gateway prefix, as the SDK delivers it via Data["error"].
	gatewayString := "API Error: 400 " + layer2

	rpc := &acp.RequestError{
		Code:    -32603,
		Message: "Internal error",
		Data:    map[string]any{"error": gatewayString},
	}

	got, data := humanizeAgentError(rpc)
	want := "messages.13.content.0: Invalid `signature` in `thinking` block"
	if got != want {
		t.Errorf("layered error message:\n got: %q\nwant: %q", got, want)
	}
	if data == nil {
		t.Fatal("expected diagnostic data to be populated")
	}
	if code, ok := data["rpcCode"].(int); !ok || code != -32603 {
		t.Errorf("data.rpcCode = %v, want -32603", data["rpcCode"])
	}
	if raw, ok := data["raw"].(string); !ok || raw == "" {
		t.Error("data.raw should be the original error string, got empty")
	}
}

// TestHumanizeAgentError_NonJSONBody confirms a *RequestError carrying
// a plain (non-JSON) gateway string just returns that string — no panic,
// no garbled output.
func TestHumanizeAgentError_NonJSONBody(t *testing.T) {
	rpc := &acp.RequestError{
		Code:    -32603,
		Message: "Internal error",
		Data:    map[string]any{"error": "some plain non-json text"},
	}
	got, data := humanizeAgentError(rpc)
	if got != "some plain non-json text" {
		t.Errorf("non-JSON body: got %q", got)
	}
	if data == nil || data["rpcCode"] != -32603 {
		t.Errorf("expected rpcCode=-32603, got %v", data)
	}
}

// TestHumanizeAgentError_MessageFallback confirms that when Data has no
// "error" key, we fall back to Message and still unwrap any JSON it holds.
func TestHumanizeAgentError_MessageFallback(t *testing.T) {
	// Simulates a wrapper whose Data carries unrelated metadata.
	rpc := &acp.RequestError{
		Code:    -32603,
		Message: `Internal error: API Error: 400 {"error":{"message":"upstream said no","type":"invalid_request_error"}}`,
		Data:    map[string]any{"errorKind": "unknown"},
	}
	got, _ := humanizeAgentError(rpc)
	if got != "upstream said no" {
		t.Errorf("message fallback: got %q, want %q", got, "upstream said no")
	}
}

// jsonEncodeString returns a JSON-encoded string literal of s (including the
// surrounding quotes), suitable for embedding inside another JSON object.
func jsonEncodeString(s string) (string, error) {
	b, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
