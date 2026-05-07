package agentsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// createSessionMaxAttempts caps how many times CreateSession retries when an
// ACP agent process crashes mid-handshake. The original failure ("Query closed
// before response received" from session/new) is racy: a warm pool conn can
// die between Acquire and NewSession, and a freshly-spawned process can crash
// during init for transient reasons. One retry recovers most cases; we go up
// to 3 to ride out a brief window where a buggy agent build kills its first
// few sessions before stabilizing.
const createSessionMaxAttempts = 3

// Client is the entry point for all agent interactions.
// It wraps ACP connections with MyLifeDB-specific concerns.
type Client struct {
	agents   map[AgentType]AgentConfig
	defaults SessionConfig

	mu     sync.Mutex
	active map[string]Session // sessionID → Session

	pool *ProcessPool // pre-warmed ACP connections
}

// NewClient creates a Client with registered agents and default config.
func NewClient(defaults SessionConfig, agents ...AgentConfig) *Client {
	m := make(map[AgentType]AgentConfig, len(agents))
	for _, a := range agents {
		m[a.Type] = a
	}
	return &Client{
		agents:   m,
		defaults: defaults,
		active:   make(map[string]Session),
	}
}

// StartPool begins pre-warming ACP connections for the given agent type.
// Call this once during server startup. poolSize=0 uses the default (3).
func (c *Client) StartPool(ctx context.Context, agent AgentType, poolSize int) {
	agentCfg, err := c.getAgent(agent)
	if err != nil {
		log.Warn().Err(err).Str("agent", string(agent)).Msg("cannot start pool: agent not registered")
		return
	}

	env := c.MergeEnv(agentCfg, c.defaults)

	c.pool = newProcessPool(PoolConfig{
		Size:      poolSize,
		AgentType: agent,
		Spawn: func(ctx context.Context) (*warmConn, error) {
			return spawnWarmConn(ctx, agentCfg, env)
		},
	})
	c.pool.Start(ctx)

	log.Info().
		Str("agent", string(agent)).
		Int("size", c.pool.cfg.Size).
		Msg("ACP process pool started")
}

// ShutdownPool stops the pool and kills all warm connections.
func (c *Client) ShutdownPool() {
	if c.pool != nil {
		c.pool.Shutdown()
	}
}

// AvailableAgents returns metadata about all registered agents.
func (c *Client) AvailableAgents() []AgentInfo {
	infos := make([]AgentInfo, 0, len(c.agents))
	for _, a := range c.agents {
		infos = append(infos, AgentInfo{Type: a.Type, Name: a.Name})
	}
	return infos
}

// CreateSession starts an interactive, multi-turn agent session via ACP.
// Spawns the agent binary, establishes ACP connection, creates session.
func (c *Client) CreateSession(ctx context.Context, config SessionConfig) (Session, error) {
	agentCfg, err := c.getAgent(config.Agent)
	if err != nil {
		return nil, err
	}

	// Inherit default system prompt if not explicitly set
	if config.SystemPrompt == "" && c.defaults.SystemPrompt != "" {
		config.SystemPrompt = c.defaults.SystemPrompt
	}

	// Inherit default MCP servers if not explicitly set
	if len(config.McpServers) == 0 && len(c.defaults.McpServers) > 0 {
		config.McpServers = c.defaults.McpServers
	}

	// Use the pre-warmed pool only when there is no per-session env override.
	// Pool processes are spawned once with a fixed env (from AgentConfig.Env),
	// so a session that needs different env vars (e.g. ANTHROPIC_MODEL tied to
	// a specific user-selected gateway model) must spawn fresh.
	canUsePool := c.pool != nil && config.Agent == c.pool.cfg.AgentType && len(config.Env) == 0

	// Retry transparently on agent_crash. The pool's dead-conn check is racy
	// (a warm conn can die between Acquire and NewSession); a buggy agent build
	// can also kill its first few subprocesses before stabilizing. Both surface
	// to the user as "Query closed before response received" otherwise. Only
	// agent_crash is retried — quota/credentials/not-found errors are terminal
	// and shouldn't be retried.
	session, err := c.createSessionWithRetry(ctx, agentCfg, config, canUsePool)
	if err != nil {
		return nil, err
	}

	// Track active session
	c.mu.Lock()
	c.active[session.ID()] = session
	c.mu.Unlock()

	go func() {
		<-session.Done()
		c.mu.Lock()
		delete(c.active, session.ID())
		c.mu.Unlock()
	}()

	return session, nil
}

// createSessionWithRetry attempts to create an ACP session, retrying on
// agent_crash up to createSessionMaxAttempts times. Each attempt either pulls
// a fresh warm conn from the pool (preferred) or spawns a new process. The
// pool path falls through to a fresh spawn on the final attempt to avoid an
// infinite loop if every warm conn in the pool is dying for the same reason.
func (c *Client) createSessionWithRetry(
	ctx context.Context,
	agentCfg AgentConfig,
	config SessionConfig,
	canUsePool bool,
) (*acpSession, error) {
	var lastErr error
	for attempt := 1; attempt <= createSessionMaxAttempts; attempt++ {
		// On the last attempt, bypass the pool — if pool conns keep crashing,
		// a fresh spawn isolates the failure (still uses the same agent binary,
		// but rules out a stale-pool race).
		usePool := canUsePool && attempt < createSessionMaxAttempts

		var session *acpSession
		var err error
		if usePool {
			var warm *warmConn
			warm, err = c.pool.Acquire(ctx)
			if err == nil {
				session, err = newSessionFromWarm(ctx, warm, agentCfg, config)
			}
		} else {
			env := c.MergeEnv(agentCfg, config)
			session, err = spawnACPSession(ctx, agentCfg, config, env)
		}

		if err == nil {
			if attempt > 1 {
				log.Info().
					Int("attempt", attempt).
					Str("agent", string(agentCfg.Type)).
					Msg("agent session created after retry")
			}
			return session, nil
		}

		// Only retry on agent_crash; quota/credentials/not-found are terminal.
		var ae *AgentError
		isCrash := errors.As(err, &ae) && ae.Type == ErrAgentCrash
		lastErr = err

		if !isCrash || ctx.Err() != nil || attempt == createSessionMaxAttempts {
			return nil, err
		}

		log.Warn().
			Err(err).
			Int("attempt", attempt).
			Int("maxAttempts", createSessionMaxAttempts).
			Str("agent", string(agentCfg.Type)).
			Bool("usedPool", usePool).
			Msg("agent session create failed (agent_crash); retrying")
	}
	return nil, lastErr
}

// ResumeSession resumes an existing session by ID via ACP.
// Note: LoadSession fails across process restarts (verified finding).
// For now, this creates a new session — history is not replayed.
func (c *Client) ResumeSession(ctx context.Context, sessionID string, config SessionConfig) (Session, error) {
	// ACP LoadSession fails across process restarts.
	// Create a new session instead.
	return c.CreateSession(ctx, config)
}

// CreateSessionWithLoad creates an ACP session and immediately tries to load
// a historical session by ID. This spawns the agent process, establishes the
// ACP connection, then calls session/load to replay history events.
// If LoadSession fails (e.g., session not found on disk), the session is still
// usable — just without history. The returned events slice may be nil if
// history loading failed.
func (c *Client) CreateSessionWithLoad(ctx context.Context, cfg SessionConfig, historicalSessionID string) (Session, error) {
	// Create the ACP session normally (spawns agent process)
	sess, err := c.CreateSession(ctx, cfg)
	if err != nil {
		return nil, err
	}

	// Load the historical session. Frames are delivered via the onFrame handler
	// (must be set by the caller before this call).
	if err := sess.LoadSession(ctx, historicalSessionID, cfg.WorkingDir); err != nil {
		// LoadSession failed — session is still usable, just no history
		log.Warn().Err(err).
			Str("sessionId", historicalSessionID).
			Msg("CreateSessionWithLoad: LoadSession failed, continuing without history")
	}

	return sess, nil
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

	frames, err := session.Send(ctx, config.Prompt)
	if err != nil {
		return TaskResult{}, err
	}

	// Drain frames — for RunTask we just need to detect errors
	for frame := range frames {
		var msg struct {
			Type    string `json:"type"`
			Message string `json:"message"`
			Code    string `json:"code"`
		}
		if json.Unmarshal(frame, &msg) == nil && msg.Type == "error" {
			return TaskResult{}, fmt.Errorf("%s: %s", msg.Code, msg.Message)
		}
	}

	return TaskResult{
		SessionID: session.ID(),
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
func (c *Client) MergeEnv(agentCfg AgentConfig, config SessionConfig) map[string]string {
	merged := make(map[string]string)
	for k, v := range c.defaults.Env {
		merged[k] = v
	}
	for k, v := range agentCfg.Env {
		merged[k] = v
	}
	for k, v := range config.Env {
		merged[k] = v
	}
	return merged
}
