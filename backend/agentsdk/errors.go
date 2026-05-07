package agentsdk

import (
	"encoding/json"
	"fmt"
	"strings"

	acp "github.com/coder/acp-go-sdk"
)

// ErrorType categorizes agent errors.
type ErrorType string

const (
	ErrQuotaExceeded   ErrorType = "quota_exceeded"    // 429 from LLM proxy
	ErrNoCredentials   ErrorType = "no_credentials"    // no API key configured
	ErrAgentCrash ErrorType = "agent_crash" // CLI process died unexpectedly
	ErrTimeout         ErrorType = "timeout"           // task exceeded time limit
	ErrNotFound        ErrorType = "not_found"         // agent or session not found
)

// AgentError wraps errors with agent context.
type AgentError struct {
	Type    ErrorType
	Agent   AgentType
	Message string
	Cause   error
}

func (e *AgentError) Error() string {
	base := fmt.Sprintf("agent: %s: %s", e.Type, e.Message)
	if e.Agent != "" {
		base = fmt.Sprintf("agent %s: %s: %s", e.Agent, e.Type, e.Message)
	}
	if e.Cause != nil {
		return base + ": " + e.Cause.Error()
	}
	return base
}

func (e *AgentError) Unwrap() error { return e.Cause }

// humanizeAgentError extracts the most user-facing message from a deeply
// nested error returned by the ACP SDK.
//
// Errors arriving from the LiteLLM/OpenAI gateway can be wrapped up to four
// times — *acp.RequestError JSON-marshals itself, its Data carries a string
// from the gateway, the gateway packs the upstream provider envelope as a
// JSON string, and the provider's envelope contains the actual message. The
// frontend surfaces `message` directly, so we descend through those layers
// here and return the leaf.
//
// `data` carries diagnostics for non-UI consumers (logs, future inspector):
// the JSON-RPC code (when present) and the original err.Error() string.
func humanizeAgentError(err error) (message string, data map[string]any) {
	if err == nil {
		return "", nil
	}
	rpcErr, ok := err.(*acp.RequestError)
	if !ok {
		return err.Error(), nil
	}

	data = map[string]any{
		"rpcCode": rpcErr.Code,
		"raw":     rpcErr.Error(),
	}

	current := pickInitial(rpcErr)
	for i := 0; i < 5; i++ {
		next, ok := unwrapOnce(current)
		if !ok {
			break
		}
		current = next
	}
	return strings.TrimSpace(current), data
}

// pickInitial chooses the starting string for unwrapping. Prefer the gateway
// payload in Data over the generic top-level Message ("Internal error").
func pickInitial(e *acp.RequestError) string {
	if m, ok := e.Data.(map[string]any); ok {
		if s, ok := m["error"].(string); ok && s != "" {
			return s
		}
	}
	return e.Message
}

// unwrapOnce peels one JSON-encoded layer off s. Returns the inner string and
// true if a known shape matched, otherwise the input unchanged and false.
//
// Handles three observed shapes:
//   - {"error": {"message": "..."}}        ← Anthropic envelope
//   - {"error": "..."}                     ← gateway wrapper with string body
//   - {"message": "..."}                   ← bare error object
func unwrapOnce(s string) (string, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "API Error: ")
	// Strip a leading "<status> " token (e.g. "400 ") so we land on the JSON.
	if i := strings.Index(s, " "); i > 0 && i < 5 {
		if isAllDigits(s[:i]) {
			s = s[i+1:]
		}
	}
	start := strings.Index(s, "{")
	if start < 0 {
		return s, false
	}
	candidate := s[start:]

	dec := json.NewDecoder(strings.NewReader(candidate))
	var v any
	if err := dec.Decode(&v); err != nil {
		return s, false
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return s, false
	}

	if errVal, ok := obj["error"]; ok {
		switch e := errVal.(type) {
		case map[string]any:
			if m, ok := e["message"].(string); ok && m != "" {
				return m, true
			}
		case string:
			if e != "" {
				return e, true
			}
		}
	}
	if m, ok := obj["message"].(string); ok && m != "" {
		return m, true
	}
	return s, false
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
