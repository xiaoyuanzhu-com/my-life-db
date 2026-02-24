package transport

// TransportOptions contains options for the subprocess transport.
// This is a subset of ClaudeAgentOptions relevant to the transport layer.
type TransportOptions struct {
	// Prompts
	SystemPrompt string

	// Permission settings
	PermissionMode           string
	PermissionPromptToolName string

	// Session management
	Resume string

	// Model configuration
	Model string

	// Paths
	Cwd     string
	CliPath string

	// Environment
	Env       map[string]string
	ExtraArgs map[string]*string

	// Streaming
	IncludePartialMessages bool

	// Advanced
	MaxBufferSize           int
	MaxThinkingTokens       *int
	EnableFileCheckpointing bool

	// Stderr callback
	Stderr func(string)
}
