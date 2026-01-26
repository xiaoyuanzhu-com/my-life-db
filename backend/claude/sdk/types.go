// Package claudesdk provides a Go SDK for interacting with Claude Code CLI.
// This SDK mirrors the design of the official Python Claude Agent SDK.
package sdk

import (
	"encoding/json"
	"time"
)

// PermissionMode controls how tools are authorized
type PermissionMode string

const (
	PermissionModeDefault           PermissionMode = "default"           // CLI prompts for dangerous tools
	PermissionModeAcceptEdits       PermissionMode = "acceptEdits"       // Auto-accept file edits
	PermissionModePlan              PermissionMode = "plan"              // Planning mode
	PermissionModeBypassPermissions PermissionMode = "bypassPermissions" // Allow all tools (use with caution)
)

// PermissionBehavior is the response to a permission request
type PermissionBehavior string

const (
	PermissionAllow PermissionBehavior = "allow"
	PermissionDeny  PermissionBehavior = "deny"
	PermissionAsk   PermissionBehavior = "ask"
)

// HookEvent represents the type of hook event
type HookEvent string

const (
	HookPreToolUse       HookEvent = "PreToolUse"
	HookPostToolUse      HookEvent = "PostToolUse"
	HookUserPromptSubmit HookEvent = "UserPromptSubmit"
	HookStop             HookEvent = "Stop"
	HookSubagentStop     HookEvent = "SubagentStop"
	HookPreCompact       HookEvent = "PreCompact"
)

// SettingSource indicates where a setting comes from
type SettingSource string

const (
	SettingSourceUser    SettingSource = "user"
	SettingSourceProject SettingSource = "project"
	SettingSourceLocal   SettingSource = "local"
)

// PermissionUpdateDestination specifies where permission updates are stored
type PermissionUpdateDestination string

const (
	DestinationUserSettings    PermissionUpdateDestination = "userSettings"
	DestinationProjectSettings PermissionUpdateDestination = "projectSettings"
	DestinationLocalSettings   PermissionUpdateDestination = "localSettings"
	DestinationSession         PermissionUpdateDestination = "session"
)

// PermissionUpdateType specifies the type of permission update
type PermissionUpdateType string

const (
	UpdateTypeAddRules          PermissionUpdateType = "addRules"
	UpdateTypeReplaceRules      PermissionUpdateType = "replaceRules"
	UpdateTypeRemoveRules       PermissionUpdateType = "removeRules"
	UpdateTypeSetMode           PermissionUpdateType = "setMode"
	UpdateTypeAddDirectories    PermissionUpdateType = "addDirectories"
	UpdateTypeRemoveDirectories PermissionUpdateType = "removeDirectories"
)

// PermissionRuleValue represents a permission rule
type PermissionRuleValue struct {
	ToolName    string  `json:"toolName"`
	RuleContent *string `json:"ruleContent,omitempty"`
}

// PermissionUpdate represents a permission configuration change
type PermissionUpdate struct {
	Type        PermissionUpdateType        `json:"type"`
	Rules       []PermissionRuleValue       `json:"rules,omitempty"`
	Behavior    PermissionBehavior          `json:"behavior,omitempty"`
	Mode        PermissionMode              `json:"mode,omitempty"`
	Directories []string                    `json:"directories,omitempty"`
	Destination PermissionUpdateDestination `json:"destination,omitempty"`
}

// ToolPermissionContext provides context for tool permission callbacks
type ToolPermissionContext struct {
	Signal      interface{}        `json:"-"` // Reserved for future abort signal support
	Suggestions []PermissionUpdate `json:"suggestions,omitempty"`
}

// PermissionResult is the result of a permission check
type PermissionResult interface {
	isPermissionResult()
}

// PermissionResultAllow indicates the tool use is allowed
type PermissionResultAllow struct {
	Behavior           PermissionBehavior `json:"behavior"`
	UpdatedInput       map[string]any     `json:"updatedInput,omitempty"`
	UpdatedPermissions []PermissionUpdate `json:"updatedPermissions,omitempty"`
}

func (PermissionResultAllow) isPermissionResult() {}

// PermissionResultDeny indicates the tool use is denied
type PermissionResultDeny struct {
	Behavior  PermissionBehavior `json:"behavior"`
	Message   string             `json:"message,omitempty"`
	Interrupt bool               `json:"interrupt,omitempty"`
}

func (PermissionResultDeny) isPermissionResult() {}

// CanUseToolFunc is the callback type for tool permission checks
type CanUseToolFunc func(toolName string, input map[string]any, ctx ToolPermissionContext) (PermissionResult, error)

// HookContext provides context for hook callbacks
type HookContext struct {
	Signal interface{} `json:"-"` // Reserved for future abort signal support
}

// BaseHookInput contains common fields for all hook inputs
type BaseHookInput struct {
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
	Cwd            string `json:"cwd"`
	PermissionMode string `json:"permission_mode,omitempty"`
}

// PreToolUseHookInput is input data for PreToolUse hook events
type PreToolUseHookInput struct {
	BaseHookInput
	HookEventName string         `json:"hook_event_name"`
	ToolName      string         `json:"tool_name"`
	ToolInput     map[string]any `json:"tool_input"`
}

// PostToolUseHookInput is input data for PostToolUse hook events
type PostToolUseHookInput struct {
	BaseHookInput
	HookEventName string         `json:"hook_event_name"`
	ToolName      string         `json:"tool_name"`
	ToolInput     map[string]any `json:"tool_input"`
	ToolResponse  any            `json:"tool_response"`
}

// UserPromptSubmitHookInput is input data for UserPromptSubmit hook events
type UserPromptSubmitHookInput struct {
	BaseHookInput
	HookEventName string `json:"hook_event_name"`
	Prompt        string `json:"prompt"`
}

// StopHookInput is input data for Stop hook events
type StopHookInput struct {
	BaseHookInput
	HookEventName  string `json:"hook_event_name"`
	StopHookActive bool   `json:"stop_hook_active"`
}

// HookInput is a union type for all hook inputs
type HookInput interface {
	GetHookEventName() string
}

func (h PreToolUseHookInput) GetHookEventName() string       { return h.HookEventName }
func (h PostToolUseHookInput) GetHookEventName() string      { return h.HookEventName }
func (h UserPromptSubmitHookInput) GetHookEventName() string { return h.HookEventName }
func (h StopHookInput) GetHookEventName() string             { return h.HookEventName }

// HookSpecificOutput contains hook-specific output fields
type HookSpecificOutput struct {
	HookEventName            string         `json:"hookEventName"`
	PermissionDecision       string         `json:"permissionDecision,omitempty"`       // PreToolUse only
	PermissionDecisionReason string         `json:"permissionDecisionReason,omitempty"` // PreToolUse only
	UpdatedInput             map[string]any `json:"updatedInput,omitempty"`             // PreToolUse only
	AdditionalContext        string         `json:"additionalContext,omitempty"`        // PostToolUse, UserPromptSubmit
}

// HookOutput is the output from a hook callback
type HookOutput struct {
	// Control fields
	Continue       *bool  `json:"continue,omitempty"`
	SuppressOutput bool   `json:"suppressOutput,omitempty"`
	StopReason     string `json:"stopReason,omitempty"`

	// Decision fields
	Decision      string `json:"decision,omitempty"` // "block"
	SystemMessage string `json:"systemMessage,omitempty"`
	Reason        string `json:"reason,omitempty"`

	// Hook-specific output
	HookSpecificOutput *HookSpecificOutput `json:"hookSpecificOutput,omitempty"`
}

// HookCallback is the function signature for hook handlers
type HookCallback func(input HookInput, toolUseID *string, ctx HookContext) (HookOutput, error)

// HookMatcher configures which hooks match which events
type HookMatcher struct {
	Matcher string         `json:"matcher,omitempty"` // Tool name pattern (e.g., "Bash", "Write|Edit")
	Hooks   []HookCallback `json:"-"`                 // Callback functions
	Timeout *float64       `json:"timeout,omitempty"` // Timeout in seconds
}

// McpServerConfig represents MCP server configuration (union type)
type McpServerConfig struct {
	Type    string            `json:"type,omitempty"` // "stdio", "sse", "http", "sdk"
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Name    string            `json:"name,omitempty"`
}

// AgentDefinition defines a custom agent
type AgentDefinition struct {
	Description string   `json:"description"`
	Prompt      string   `json:"prompt"`
	Tools       []string `json:"tools,omitempty"`
	Model       string   `json:"model,omitempty"` // "sonnet", "opus", "haiku", "inherit"
}

// SandboxNetworkConfig configures network access in sandbox
type SandboxNetworkConfig struct {
	AllowUnixSockets    []string `json:"allowUnixSockets,omitempty"`
	AllowAllUnixSockets bool     `json:"allowAllUnixSockets,omitempty"`
	AllowLocalBinding   bool     `json:"allowLocalBinding,omitempty"`
	HTTPProxyPort       int      `json:"httpProxyPort,omitempty"`
	SOCKSProxyPort      int      `json:"socksProxyPort,omitempty"`
}

// SandboxSettings configures bash command sandboxing
type SandboxSettings struct {
	Enabled                   bool                 `json:"enabled,omitempty"`
	AutoAllowBashIfSandboxed  bool                 `json:"autoAllowBashIfSandboxed,omitempty"`
	ExcludedCommands          []string             `json:"excludedCommands,omitempty"`
	AllowUnsandboxedCommands  bool                 `json:"allowUnsandboxedCommands,omitempty"`
	Network                   SandboxNetworkConfig `json:"network,omitempty"`
	EnableWeakerNestedSandbox bool                 `json:"enableWeakerNestedSandbox,omitempty"`
}

// ClaudeAgentOptions configures the Claude SDK client
type ClaudeAgentOptions struct {
	// Tools configuration
	Tools          []string `json:"tools,omitempty"`
	AllowedTools   []string `json:"allowedTools,omitempty"`
	DisallowedTools []string `json:"disallowedTools,omitempty"`

	// Prompts
	SystemPrompt string `json:"systemPrompt,omitempty"`

	// MCP servers
	McpServers map[string]McpServerConfig `json:"mcpServers,omitempty"`

	// Permission settings
	PermissionMode           PermissionMode `json:"permissionMode,omitempty"`
	PermissionPromptToolName string         `json:"permissionPromptToolName,omitempty"`
	CanUseTool               CanUseToolFunc `json:"-"`

	// Session management
	ContinueConversation bool   `json:"continueConversation,omitempty"`
	Resume               string `json:"resume,omitempty"`
	ForkSession          bool   `json:"forkSession,omitempty"`

	// Limits
	MaxTurns     *int     `json:"maxTurns,omitempty"`
	MaxBudgetUSD *float64 `json:"maxBudgetUsd,omitempty"`

	// Model configuration
	Model         string `json:"model,omitempty"`
	FallbackModel string `json:"fallbackModel,omitempty"`

	// Paths
	Cwd     string `json:"cwd,omitempty"`
	CliPath string `json:"cliPath,omitempty"`
	AddDirs []string `json:"addDirs,omitempty"`

	// Environment
	Env       map[string]string  `json:"env,omitempty"`
	ExtraArgs map[string]*string `json:"extraArgs,omitempty"` // Arbitrary CLI flags

	// Streaming
	IncludePartialMessages bool `json:"includePartialMessages,omitempty"`

	// Hooks
	Hooks map[HookEvent][]HookMatcher `json:"-"`

	// Custom agents
	Agents map[string]AgentDefinition `json:"agents,omitempty"`

	// Setting sources
	SettingSources []SettingSource `json:"settingSources,omitempty"`

	// Sandbox
	Sandbox *SandboxSettings `json:"sandbox,omitempty"`

	// Advanced
	MaxBufferSize           int  `json:"maxBufferSize,omitempty"`
	MaxThinkingTokens       *int `json:"maxThinkingTokens,omitempty"`
	EnableFileCheckpointing bool `json:"enableFileCheckpointing,omitempty"`
	SkipInitialization      bool `json:"-"` // Skip the initialize control request handshake

	// Output format for structured outputs
	OutputFormat map[string]any `json:"outputFormat,omitempty"`

	// Stderr callback
	Stderr func(string) `json:"-"`

	// User identifier
	User string `json:"user,omitempty"`
}

// --- Content Block Types ---

// ContentBlock is the interface for all content blocks
type ContentBlock interface {
	BlockType() string
}

// TextBlock represents text content
type TextBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func (TextBlock) BlockType() string { return "text" }

// ThinkingBlock represents Claude's thinking/reasoning
type ThinkingBlock struct {
	Type      string `json:"type"`
	Thinking  string `json:"thinking"`
	Signature string `json:"signature"`
}

func (ThinkingBlock) BlockType() string { return "thinking" }

// ToolUseBlock represents a tool invocation
type ToolUseBlock struct {
	Type  string         `json:"type"`
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Input map[string]any `json:"input"`
}

func (ToolUseBlock) BlockType() string { return "tool_use" }

// ToolResultBlock represents the result of a tool execution
type ToolResultBlock struct {
	Type      string `json:"type"`
	ToolUseID string `json:"tool_use_id"`
	Content   any    `json:"content,omitempty"`
	IsError   bool   `json:"is_error,omitempty"`
}

func (ToolResultBlock) BlockType() string { return "tool_result" }

// --- Message Types ---

// MessageType identifies the type of message
type MessageType string

const (
	MessageTypeUser            MessageType = "user"
	MessageTypeAssistant       MessageType = "assistant"
	MessageTypeSystem          MessageType = "system"
	MessageTypeResult          MessageType = "result"
	MessageTypeStreamEvent     MessageType = "stream_event"
	MessageTypeControlRequest  MessageType = "control_request"
	MessageTypeControlResponse MessageType = "control_response"
)

// Message is the interface for all message types
type Message interface {
	GetType() MessageType
	GetUUID() string
}

// UserMessage represents a user message
type UserMessage struct {
	Type            MessageType    `json:"type"`
	UUID            string         `json:"uuid,omitempty"`
	Timestamp       time.Time      `json:"timestamp,omitempty"`
	SessionID       string         `json:"sessionId,omitempty"`
	ParentToolUseID *string        `json:"parent_tool_use_id,omitempty"`
	ToolUseResult   map[string]any `json:"tool_use_result,omitempty"`
	Message         struct {
		Role    string `json:"role"`
		Content any    `json:"content"` // string or []ContentBlock
	} `json:"message"`
}

func (m UserMessage) GetType() MessageType { return MessageTypeUser }
func (m UserMessage) GetUUID() string      { return m.UUID }

// AssistantMessage represents Claude's response
type AssistantMessage struct {
	Type            MessageType    `json:"type"`
	UUID            string         `json:"uuid,omitempty"`
	Timestamp       time.Time      `json:"timestamp,omitempty"`
	SessionID       string         `json:"sessionId,omitempty"`
	ParentToolUseID *string        `json:"parent_tool_use_id,omitempty"`
	Message         struct {
		Role    string         `json:"role"`
		Content []ContentBlock `json:"content"`
		Model   string         `json:"model"`
	} `json:"message"`
	Error string `json:"error,omitempty"` // authentication_failed, billing_error, rate_limit, etc.
}

func (m AssistantMessage) GetType() MessageType { return MessageTypeAssistant }
func (m AssistantMessage) GetUUID() string      { return m.UUID }

// SystemMessage represents internal system events
type SystemMessage struct {
	Type      MessageType    `json:"type"`
	UUID      string         `json:"uuid,omitempty"`
	Subtype   string         `json:"subtype"`
	Timestamp time.Time      `json:"timestamp,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
	Data      map[string]any `json:"data,omitempty"`
}

func (m SystemMessage) GetType() MessageType { return MessageTypeSystem }
func (m SystemMessage) GetUUID() string      { return m.UUID }

// ResultMessage represents the final result with cost/usage info
type ResultMessage struct {
	Type             MessageType    `json:"type"`
	UUID             string         `json:"uuid,omitempty"`
	Subtype          string         `json:"subtype"`
	DurationMs       int            `json:"duration_ms"`
	DurationAPIMs    int            `json:"duration_api_ms"`
	IsError          bool           `json:"is_error"`
	NumTurns         int            `json:"num_turns"`
	SessionID        string         `json:"session_id"`
	TotalCostUSD     *float64       `json:"total_cost_usd,omitempty"`
	Usage            map[string]any `json:"usage,omitempty"`
	Result           string         `json:"result,omitempty"`
	StructuredOutput any            `json:"structured_output,omitempty"`
}

func (m ResultMessage) GetType() MessageType { return MessageTypeResult }
func (m ResultMessage) GetUUID() string      { return m.UUID }

// StreamEvent represents partial message updates during streaming
type StreamEvent struct {
	Type            MessageType    `json:"type"`
	UUID            string         `json:"uuid"`
	SessionID       string         `json:"session_id"`
	Event           map[string]any `json:"event"`
	ParentToolUseID *string        `json:"parent_tool_use_id,omitempty"`
}

func (m StreamEvent) GetType() MessageType { return MessageTypeStreamEvent }
func (m StreamEvent) GetUUID() string      { return m.UUID }

// --- Control Protocol Types ---

// ControlRequestSubtype identifies the type of control request
type ControlRequestSubtype string

const (
	ControlSubtypeInterrupt         ControlRequestSubtype = "interrupt"
	ControlSubtypeCanUseTool        ControlRequestSubtype = "can_use_tool"
	ControlSubtypeInitialize        ControlRequestSubtype = "initialize"
	ControlSubtypeSetPermissionMode ControlRequestSubtype = "set_permission_mode"
	ControlSubtypeSetModel          ControlRequestSubtype = "set_model"
	ControlSubtypeHookCallback      ControlRequestSubtype = "hook_callback"
	ControlSubtypeMcpMessage        ControlRequestSubtype = "mcp_message"
	ControlSubtypeRewindFiles       ControlRequestSubtype = "rewind_files"
)

// ControlRequest represents a control request from Claude CLI
type ControlRequest struct {
	Type      string         `json:"type"` // "control_request"
	RequestID string         `json:"request_id"`
	Request   map[string]any `json:"request"`
}

// ControlResponse represents a response to a control request
type ControlResponse struct {
	Type     string `json:"type"` // "control_response"
	Response struct {
		Subtype   string         `json:"subtype"` // "success" or "error"
		RequestID string         `json:"request_id"`
		Response  map[string]any `json:"response,omitempty"`
		Error     string         `json:"error,omitempty"`
	} `json:"response"`
}

// --- Raw Message for passthrough ---

// RawMessage preserves the original JSON for passthrough
type RawMessage struct {
	Type MessageType     `json:"type"`
	UUID string          `json:"uuid,omitempty"`
	Raw  json.RawMessage `json:"-"`
}

func (m RawMessage) GetType() MessageType { return m.Type }
func (m RawMessage) GetUUID() string      { return m.UUID }

// MarshalJSON returns the original raw JSON
func (m RawMessage) MarshalJSON() ([]byte, error) {
	return m.Raw, nil
}

// ServerInfo contains initialization response data
type ServerInfo struct {
	Commands     []map[string]any `json:"commands,omitempty"`
	OutputStyle  string           `json:"output_style,omitempty"`
	OutputStyles []string         `json:"output_styles,omitempty"`
}
