package agentsdk

import "fmt"

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
