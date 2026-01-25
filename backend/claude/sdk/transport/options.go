package transport

// TransportOptions contains options for the subprocess transport.
// This is a subset of ClaudeAgentOptions relevant to the transport layer.
type TransportOptions struct {
	// Tools configuration
	Tools           []string
	AllowedTools    []string
	DisallowedTools []string

	// Prompts
	SystemPrompt string

	// Permission settings
	PermissionMode           string
	PermissionPromptToolName string

	// Session management
	ContinueConversation bool
	Resume               string

	// Limits
	MaxTurns *int

	// Model configuration
	Model         string
	FallbackModel string

	// Paths
	Cwd     string
	CliPath string
	AddDirs []string

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
