package sdk

import (
	"context"
	"fmt"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/claude/sdk/transport"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ClaudeSDKClient is the high-level client for bidirectional, interactive
// conversations with Claude Code.
//
// This client provides full control over the conversation flow with support
// for streaming, interrupts, and dynamic message sending. For simple one-shot
// queries, consider using the Query function instead.
//
// Key features:
//   - Bidirectional: Send and receive messages at any time
//   - Stateful: Maintains conversation context across messages
//   - Interactive: Send follow-ups based on responses
//   - Control flow: Support for interrupts and session management
//
// When to use ClaudeSDKClient:
//   - Building chat interfaces or conversational UIs
//   - Interactive debugging or exploration sessions
//   - Multi-turn conversations with context
//   - When you need to react to Claude's responses
//   - Real-time applications with user input
//   - When you need interrupt capabilities
//
// When to use QueryOnce() instead:
//   - Simple one-off questions
//   - Batch processing of prompts
//   - Fire-and-forget automation scripts
//   - When all inputs are known upfront
//   - Stateless operations
type ClaudeSDKClient struct {
	options   ClaudeAgentOptions
	transport transport.Transport
	query     *Query

	mu     sync.RWMutex
	closed bool
}

// NewClaudeSDKClient creates a new Claude SDK client with the given options
func NewClaudeSDKClient(options ClaudeAgentOptions) *ClaudeSDKClient {
	return &ClaudeSDKClient{
		options: options,
	}
}

// NewClaudeSDKClientWithTransport creates a client with a custom transport
// (useful for testing with mock transports)
func NewClaudeSDKClientWithTransport(options ClaudeAgentOptions, t transport.Transport) *ClaudeSDKClient {
	return &ClaudeSDKClient{
		options:   options,
		transport: t,
	}
}

// Connect establishes connection to Claude CLI.
// If prompt is provided, it's sent as the initial message.
func (c *ClaudeSDKClient) Connect(ctx context.Context, prompt string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.query != nil {
		return ErrAlreadyConnected
	}

	if c.closed {
		return ErrConnectionClosed
	}

	// Validate options
	if c.options.CanUseTool != nil && c.options.PermissionPromptToolName != "" {
		return fmt.Errorf("can_use_tool callback cannot be used with permission_prompt_tool_name: please use one or the other")
	}

	// If canUseTool is provided, automatically set permission_prompt_tool_name to stdio
	options := c.options
	if options.CanUseTool != nil {
		options.PermissionPromptToolName = "stdio"
	}

	// Create transport if not provided
	var t transport.Transport
	var err error
	if c.transport != nil {
		t = c.transport
	} else {
		t, err = transport.NewSubprocessCLITransport(options.ToTransportOptions())
		if err != nil {
			return fmt.Errorf("failed to create transport: %w", err)
		}
	}

	// Connect transport
	if err := t.Connect(ctx); err != nil {
		return fmt.Errorf("failed to connect transport: %w", err)
	}

	c.transport = t

	// Create query handler
	c.query = NewQuery(QueryOptions{
		Transport:         t,
		IsStreamingMode:   true,
		CanUseTool:        options.CanUseTool,
		Hooks:             options.Hooks,
		InitializeTimeout: 5, // seconds (reduced for debugging)
	})

	// Start query message processing
	if err := c.query.Start(ctx); err != nil {
		t.Close()
		return fmt.Errorf("failed to start query: %w", err)
	}

	// Perform initialization handshake (unless skipped)
	if !options.SkipInitialization {
		if _, err := c.query.Initialize(); err != nil {
			t.Close()
			return fmt.Errorf("failed to initialize: %w", err)
		}
	} else {
		log.Debug().Msg("skipping SDK initialization handshake")
	}

	// Send initial prompt if provided
	if prompt != "" {
		if err := c.query.SendUserMessage(prompt, ""); err != nil {
			return fmt.Errorf("failed to send initial prompt: %w", err)
		}
	}

	log.Info().Msg("Claude SDK client connected")

	return nil
}

// SendMessage sends a user message to Claude
func (c *ClaudeSDKClient) SendMessage(content string) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return ErrNotConnected
	}

	return c.query.SendUserMessage(content, "")
}

// SendMessageWithSession sends a user message with a specific session ID
func (c *ClaudeSDKClient) SendMessageWithSession(content string, sessionID string) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return ErrNotConnected
	}

	return c.query.SendUserMessage(content, sessionID)
}

// Messages returns a channel for receiving parsed messages from Claude
func (c *ClaudeSDKClient) Messages() <-chan Message {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		// Return closed channel
		ch := make(chan Message)
		close(ch)
		return ch
	}

	return c.query.Messages()
}

// RawMessages returns a channel for receiving raw JSON messages
func (c *ClaudeSDKClient) RawMessages() <-chan []byte {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		ch := make(chan []byte)
		close(ch)
		return ch
	}

	return c.query.RawMessages()
}

// Interrupt sends an interrupt signal to stop the current operation
func (c *ClaudeSDKClient) Interrupt() error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return ErrNotConnected
	}

	return c.query.Interrupt()
}

// SetPermissionMode changes the permission mode during conversation
//
// Valid modes:
//   - PermissionModeDefault: CLI prompts for dangerous tools
//   - PermissionModeAcceptEdits: Auto-accept file edits
//   - PermissionModeBypassPermissions: Allow all tools (use with caution)
func (c *ClaudeSDKClient) SetPermissionMode(mode PermissionMode) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return ErrNotConnected
	}

	return c.query.SetPermissionMode(mode)
}

// SetModel changes the AI model during conversation
//
// Examples:
//   - "claude-sonnet-4-5"
//   - "claude-opus-4-1-20250805"
func (c *ClaudeSDKClient) SetModel(model string) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return ErrNotConnected
	}

	return c.query.SetModel(model)
}

// RewindFiles reverts tracked files to their state at a specific user message.
//
// Requires:
//   - EnableFileCheckpointing: true in options to track file changes
//   - "replay-user-messages" in ExtraArgs to receive UserMessage with UUID
func (c *ClaudeSDKClient) RewindFiles(userMessageID string) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return ErrNotConnected
	}

	return c.query.RewindFiles(userMessageID)
}

// GetServerInfo returns initialization info including available commands and output styles
func (c *ClaudeSDKClient) GetServerInfo() *ServerInfo {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return nil
	}

	return c.query.GetServerInfo()
}

// IsConnected returns whether the client is currently connected
func (c *ClaudeSDKClient) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()

	return c.query != nil && c.transport != nil && c.transport.IsConnected()
}

// Disconnect closes the connection to Claude
func (c *ClaudeSDKClient) Disconnect() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.query != nil {
		if err := c.query.Close(); err != nil {
			log.Debug().Err(err).Msg("error closing query")
		}
		c.query = nil
	}

	if c.transport != nil {
		if err := c.transport.Close(); err != nil {
			log.Debug().Err(err).Msg("error closing transport")
		}
		c.transport = nil
	}

	log.Debug().Msg("Claude SDK client disconnected")

	return nil
}

// Close is an alias for Disconnect
func (c *ClaudeSDKClient) Close() error {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()

	return c.Disconnect()
}

// --- One-shot Query Function ---

// QueryOnce performs a one-shot query to Claude Code.
// This is ideal for simple, stateless queries where you don't need
// bidirectional communication or conversation management.
//
// The function yields all messages until a ResultMessage is received,
// then automatically closes the connection.
func QueryOnce(ctx context.Context, prompt string, options ClaudeAgentOptions) (<-chan Message, <-chan error) {
	messages := make(chan Message, 100)
	errors := make(chan error, 1)

	go func() {
		defer close(messages)
		defer close(errors)

		// Create transport for non-streaming mode
		t, err := transport.NewSubprocessCLITransportWithPrompt(prompt, options.ToTransportOptions())
		if err != nil {
			errors <- fmt.Errorf("failed to create transport: %w", err)
			return
		}

		// Connect
		if err := t.Connect(ctx); err != nil {
			errors <- fmt.Errorf("failed to connect: %w", err)
			return
		}
		defer t.Close()

		// Read messages until result
		for {
			select {
			case <-ctx.Done():
				errors <- ctx.Err()
				return

			case data, ok := <-t.ReadMessages():
				if !ok {
					return
				}

				msg, err := ParseMessage(data)
				if err != nil {
					log.Debug().Err(err).Msg("failed to parse message")
					continue
				}

				messages <- msg

				// Stop on result message
				if _, ok := msg.(ResultMessage); ok {
					return
				}

			case err, ok := <-t.Errors():
				if !ok {
					return
				}
				errors <- err
				return
			}
		}
	}()

	return messages, errors
}

// --- Convenience Helpers ---

// WithAllowedTools returns options with the specified allowed tools
func WithAllowedTools(tools ...string) ClaudeAgentOptions {
	return ClaudeAgentOptions{
		AllowedTools: tools,
	}
}

// WithPermissionMode returns options with the specified permission mode
func WithPermissionMode(mode PermissionMode) ClaudeAgentOptions {
	return ClaudeAgentOptions{
		PermissionMode: mode,
	}
}

// WithModel returns options with the specified model
func WithModel(model string) ClaudeAgentOptions {
	return ClaudeAgentOptions{
		Model: model,
	}
}

// WithWorkingDir returns options with the specified working directory
func WithWorkingDir(cwd string) ClaudeAgentOptions {
	return ClaudeAgentOptions{
		Cwd: cwd,
	}
}

// WithCanUseTool returns options with a tool permission callback
func WithCanUseTool(callback CanUseToolFunc) ClaudeAgentOptions {
	return ClaudeAgentOptions{
		CanUseTool: callback,
	}
}

// ToTransportOptions converts ClaudeAgentOptions to transport.TransportOptions
func (o ClaudeAgentOptions) ToTransportOptions() transport.TransportOptions {
	permMode := ""
	if o.PermissionMode != "" {
		permMode = string(o.PermissionMode)
	}

	return transport.TransportOptions{
		Tools:                   o.Tools,
		AllowedTools:            o.AllowedTools,
		DisallowedTools:         o.DisallowedTools,
		SystemPrompt:            o.SystemPrompt,
		PermissionMode:          permMode,
		PermissionPromptToolName: o.PermissionPromptToolName,
		ContinueConversation:    o.ContinueConversation,
		Resume:                  o.Resume,
		MaxTurns:                o.MaxTurns,
		Model:                   o.Model,
		FallbackModel:           o.FallbackModel,
		Cwd:                     o.Cwd,
		CliPath:                 o.CliPath,
		AddDirs:                 o.AddDirs,
		Env:                     o.Env,
		ExtraArgs:               o.ExtraArgs,
		IncludePartialMessages:  o.IncludePartialMessages,
		MaxBufferSize:           o.MaxBufferSize,
		MaxThinkingTokens:       o.MaxThinkingTokens,
		EnableFileCheckpointing: o.EnableFileCheckpointing,
		Stderr:                  o.Stderr,
	}
}

// MergeOptions combines multiple option sets, with later options taking precedence
func MergeOptions(opts ...ClaudeAgentOptions) ClaudeAgentOptions {
	result := ClaudeAgentOptions{}

	for _, opt := range opts {
		if len(opt.Tools) > 0 {
			result.Tools = opt.Tools
		}
		if len(opt.AllowedTools) > 0 {
			result.AllowedTools = append(result.AllowedTools, opt.AllowedTools...)
		}
		if len(opt.DisallowedTools) > 0 {
			result.DisallowedTools = append(result.DisallowedTools, opt.DisallowedTools...)
		}
		if opt.SystemPrompt != "" {
			result.SystemPrompt = opt.SystemPrompt
		}
		if opt.PermissionMode != "" {
			result.PermissionMode = opt.PermissionMode
		}
		if opt.PermissionPromptToolName != "" {
			result.PermissionPromptToolName = opt.PermissionPromptToolName
		}
		if opt.Model != "" {
			result.Model = opt.Model
		}
		if opt.FallbackModel != "" {
			result.FallbackModel = opt.FallbackModel
		}
		if opt.Cwd != "" {
			result.Cwd = opt.Cwd
		}
		if opt.CliPath != "" {
			result.CliPath = opt.CliPath
		}
		if opt.Resume != "" {
			result.Resume = opt.Resume
		}
		if opt.MaxTurns != nil {
			result.MaxTurns = opt.MaxTurns
		}
		if opt.MaxBudgetUSD != nil {
			result.MaxBudgetUSD = opt.MaxBudgetUSD
		}
		if opt.CanUseTool != nil {
			result.CanUseTool = opt.CanUseTool
		}
		if opt.Hooks != nil {
			result.Hooks = opt.Hooks
		}
		if opt.Stderr != nil {
			result.Stderr = opt.Stderr
		}
		if opt.ContinueConversation {
			result.ContinueConversation = true
		}
		if opt.ForkSession {
			result.ForkSession = true
		}
		if opt.IncludePartialMessages {
			result.IncludePartialMessages = true
		}
		if opt.EnableFileCheckpointing {
			result.EnableFileCheckpointing = true
		}
		if len(opt.AddDirs) > 0 {
			result.AddDirs = append(result.AddDirs, opt.AddDirs...)
		}
		if len(opt.Env) > 0 {
			if result.Env == nil {
				result.Env = make(map[string]string)
			}
			for k, v := range opt.Env {
				result.Env[k] = v
			}
		}
		if len(opt.ExtraArgs) > 0 {
			if result.ExtraArgs == nil {
				result.ExtraArgs = make(map[string]*string)
			}
			for k, v := range opt.ExtraArgs {
				result.ExtraArgs[k] = v
			}
		}
	}

	return result
}
