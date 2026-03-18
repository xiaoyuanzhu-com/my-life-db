package agentsdk

import "fmt"

// ErrorType categorizes agent errors.
type ErrorType string

const (
	ErrQuotaExceeded   ErrorType = "quota_exceeded"    // 429 from LLM proxy
	ErrNoCredentials   ErrorType = "no_credentials"    // no API key configured
	ErrTooManySessions ErrorType = "too_many_sessions" // concurrent session limit reached
	ErrAgentCrash      ErrorType = "agent_crash"       // CLI process died unexpectedly
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
	if e.Agent != "" {
		return fmt.Sprintf("agent %s: %s: %s", e.Agent, e.Type, e.Message)
	}
	return fmt.Sprintf("agent: %s: %s", e.Type, e.Message)
}

func (e *AgentError) Unwrap() error { return e.Cause }
