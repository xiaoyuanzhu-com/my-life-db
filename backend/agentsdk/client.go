package agentsdk

import (
	"context"
	"fmt"
	"sync"
)

// Client is the entry point for all agent interactions.
// It wraps ACP connections with MyLifeDB-specific concerns.
type Client struct {
	agents       map[AgentType]AgentConfig
	defaults     SessionConfig
	maxSessions  int
	proxyBaseURL string

	mu     sync.Mutex
	active map[string]Session // sessionID → Session
}

// NewClient creates a Client with registered agents and default config.
func NewClient(defaults SessionConfig, agents ...AgentConfig) *Client {
	m := make(map[AgentType]AgentConfig, len(agents))
	for _, a := range agents {
		m[a.Type] = a
	}
	return &Client{
		agents:      m,
		defaults:    defaults,
		maxSessions: 5,
		active:      make(map[string]Session),
	}
}

// SetMaxSessions sets the maximum number of concurrent agent processes.
func (c *Client) SetMaxSessions(n int) { c.maxSessions = n }

// SetProxyBaseURL sets the LLM proxy base URL for Complete() calls.
func (c *Client) SetProxyBaseURL(url string) { c.proxyBaseURL = url }

// AvailableAgents returns metadata about all registered agents.
func (c *Client) AvailableAgents() []AgentInfo {
	infos := make([]AgentInfo, 0, len(c.agents))
	for _, a := range c.agents {
		infos = append(infos, AgentInfo{Type: a.Type, Name: a.Name})
	}
	return infos
}

// CreateSession starts an interactive, multi-turn agent session via ACP.
// TODO: Implement ACP connection once coder/acp-go-sdk is added.
func (c *Client) CreateSession(ctx context.Context, config SessionConfig) (Session, error) {
	if _, err := c.getAgent(config.Agent); err != nil {
		return nil, err
	}

	c.mu.Lock()
	if len(c.active) >= c.maxSessions {
		c.mu.Unlock()
		return nil, &AgentError{
			Type:    ErrTooManySessions,
			Agent:   config.Agent,
			Message: fmt.Sprintf("limit is %d concurrent sessions", c.maxSessions),
		}
	}
	c.mu.Unlock()

	// TODO: Spawn agent binary, create ACP connection
	return nil, &AgentError{
		Type:    ErrNotFound,
		Agent:   config.Agent,
		Message: "ACP session creation not yet implemented",
	}
}

// ResumeSession resumes an existing session by ID via ACP.
func (c *Client) ResumeSession(ctx context.Context, sessionID string, config SessionConfig) (Session, error) {
	return nil, &AgentError{
		Type:    ErrNotFound,
		Agent:   config.Agent,
		Message: "ACP session resume not yet implemented",
	}
}

// RunTask runs a one-off agent task to completion.
func (c *Client) RunTask(ctx context.Context, config TaskConfig) (TaskResult, error) {
	if config.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, config.Timeout)
		defer cancel()
	}

	session, err := c.CreateSession(ctx, config.SessionConfig)
	if err != nil {
		return TaskResult{}, err
	}
	defer session.Close()

	events, err := session.Send(ctx, config.Prompt)
	if err != nil {
		return TaskResult{}, err
	}

	var messages []Message
	var usage Usage
	for event := range events {
		switch event.Type {
		case EventMessage:
			if event.Message != nil {
				messages = append(messages, *event.Message)
			}
		case EventComplete:
			if event.Usage != nil {
				usage = *event.Usage
			}
		case EventError:
			return TaskResult{}, event.Error
		}
	}

	return TaskResult{
		SessionID: session.ID(),
		Messages:  messages,
		Usage:     usage,
	}, nil
}

// Complete sends a simple prompt to the LLM proxy directly (no agent).
// Provider selects which proxy route to use: "anthropic" or "openai".
func (c *Client) Complete(ctx context.Context, provider string, prompt string, model string) (string, Usage, error) {
	// TODO: Implement direct HTTP call to LLM proxy
	return "", Usage{}, fmt.Errorf("Complete() not yet implemented")
}

// Shutdown terminates all active sessions gracefully.
func (c *Client) Shutdown(ctx context.Context) error {
	c.mu.Lock()
	sessions := make([]Session, 0, len(c.active))
	for _, s := range c.active {
		sessions = append(sessions, s)
	}
	c.mu.Unlock()

	for _, s := range sessions {
		s.Close()
	}
	return nil
}

// getAgent returns the config for the given agent type.
func (c *Client) getAgent(agent AgentType) (AgentConfig, error) {
	cfg, ok := c.agents[agent]
	if !ok {
		return AgentConfig{}, &AgentError{
			Type:    ErrNotFound,
			Agent:   agent,
			Message: fmt.Sprintf("no agent registered for %q", agent),
		}
	}
	return cfg, nil
}

// MergeEnv merges default env with per-call env. Per-call takes precedence.
func (c *Client) MergeEnv(config SessionConfig) map[string]string {
	merged := make(map[string]string)
	for k, v := range c.defaults.Env {
		merged[k] = v
	}
	for k, v := range config.Env {
		merged[k] = v
	}
	return merged
}
