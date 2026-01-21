package claude

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ContentBlock represents a content block in a Claude message.
// Messages can contain different types of blocks:
// - "text": Text content from the assistant
// - "thinking": Extended thinking from the assistant (Opus 4.5+)
// - "tool_use": A tool invocation (e.g., Bash, Read, Edit)
// - "tool_result": The result of a tool execution
type ContentBlock struct {
	Type      string                 `json:"type"`                  // "text", "thinking", "tool_use", "tool_result"
	Text      string                 `json:"text,omitempty"`        // For text blocks
	Thinking  string                 `json:"thinking,omitempty"`    // For thinking blocks
	Signature string                 `json:"signature,omitempty"`   // For thinking blocks (verification signature)
	ID        string                 `json:"id,omitempty"`          // For tool_use blocks
	Name      string                 `json:"name,omitempty"`        // For tool_use blocks
	Input     map[string]interface{} `json:"input,omitempty"`       // For tool_use blocks
	ToolUseID string                 `json:"tool_use_id,omitempty"` // For tool_result blocks
	Content   interface{}            `json:"content,omitempty"`     // For tool_result blocks (string or array)
	IsError   *bool                  `json:"is_error,omitempty"`    // For tool_result blocks
}

// ClaudeMessage represents a message in the Claude API format.
// The Content field has different types depending on the role:
// - User messages: string (plain text)
// - Assistant messages: []ContentBlock (structured content with text and tool calls)
type ClaudeMessage struct {
	Role         string      `json:"role"`                    // "user" or "assistant"
	Content      interface{} `json:"content,omitempty"`       // string for user, []ContentBlock for assistant
	Model        string      `json:"model,omitempty"`         // Model used (e.g., "claude-opus-4-5-20251101")
	ID           string      `json:"id,omitempty"`            // Message ID from Claude API
	Type         string      `json:"type,omitempty"`          // "message" for assistant responses
	StopReason   *string     `json:"stop_reason,omitempty"`   // Why generation stopped (e.g., "end_turn", "tool_use")
	StopSequence *string     `json:"stop_sequence,omitempty"` // Stop sequence that triggered stop (if any)
	Usage        *TokenUsage `json:"usage,omitempty"`         // Token usage for this message
}

// TokenUsage represents token usage statistics
type TokenUsage struct {
	InputTokens              int           `json:"input_tokens,omitempty"`
	OutputTokens             int           `json:"output_tokens,omitempty"`
	CacheCreationInputTokens int           `json:"cache_creation_input_tokens,omitempty"`
	CacheReadInputTokens     int           `json:"cache_read_input_tokens,omitempty"`
	CacheCreation            *CacheDetails `json:"cache_creation,omitempty"`
	ServiceTier              string        `json:"service_tier,omitempty"` // e.g., "standard"
}

// CacheDetails represents cache creation details
type CacheDetails struct {
	Ephemeral5mInputTokens int `json:"ephemeral_5m_input_tokens,omitempty"`
	Ephemeral1hInputTokens int `json:"ephemeral_1h_input_tokens,omitempty"`
}

// SessionMessage represents a single message in a session JSONL file
type SessionMessage struct {
	Type       string         `json:"type"`       // "user", "assistant", "tool_result", "queue-operation", "summary", etc.
	UUID       string         `json:"uuid"`       // Message ID
	ParentUUID *string        `json:"parentUuid"` // Parent message ID (null for root)
	Timestamp  string         `json:"timestamp"`  // ISO 8601 timestamp
	Message    *ClaudeMessage `json:"message"`    // Full message object (role, content, etc.)

	// Additional fields that may be present
	IsSidechain            *bool         `json:"isSidechain,omitempty"`
	UserType               string        `json:"userType,omitempty"`
	CWD                    string        `json:"cwd,omitempty"`
	SessionID              string        `json:"sessionId,omitempty"`
	Version                string        `json:"version,omitempty"`
	GitBranch              string        `json:"gitBranch,omitempty"`
	RequestID              string        `json:"requestId,omitempty"`
	ToolUseResult          ToolUseResult `json:"toolUseResult,omitempty"`
	SourceToolAssistantUUID string       `json:"sourceToolAssistantUUID,omitempty"` // For tool results: UUID of the assistant message that initiated the tool call
}

// ToolUseResult represents the toolUseResult field which varies by tool type.
// Can be:
// - string: For errors (e.g., "Error: Exit code 1\n...")
// - object: Tool-specific metadata (Bash: stdout/stderr, Read: file content, etc.)
//
// See docs/claude-code/data-models.md for full schema documentation.
type ToolUseResult = interface{}

// SessionIndex represents the sessions-index.json file
type SessionIndex struct {
	Version int                  `json:"version"`
	Entries []SessionIndexEntry `json:"entries"`
}

// SessionIndexEntry represents a single session in the index
type SessionIndexEntry struct {
	SessionID    string `json:"sessionId"`
	FullPath     string `json:"fullPath"`
	FileMtime    int64  `json:"fileMtime"`
	FirstPrompt  string `json:"firstPrompt"`
	Summary      string `json:"summary,omitempty"`      // Claude-generated 5-10 word title
	CustomTitle  string `json:"customTitle,omitempty"`  // User-set custom title (via /title command)
	MessageCount int    `json:"messageCount"`
	Created      string `json:"created"`
	Modified     string `json:"modified"`
	GitBranch    string `json:"gitBranch"`
	ProjectPath  string `json:"projectPath"`
	IsSidechain  bool   `json:"isSidechain"`
}

// ReadSessionHistory reads and parses a session JSONL file
func ReadSessionHistory(sessionID, projectPath string) ([]SessionMessage, error) {
	// Find the JSONL file
	filePath, err := findSessionFile(sessionID, projectPath)
	if err != nil {
		return nil, err
	}

	// Open the file
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open session file: %w", err)
	}
	defer file.Close()

	var messages []SessionMessage
	reader := bufio.NewReader(file)
	lineNum := 0

	for {
		lineNum++

		// ReadBytes reads until delimiter, no size limit
		lineBytes, err := reader.ReadBytes('\n')
		if err != nil {
			if err.Error() == "EOF" {
				// Process last line if it exists
				if len(lineBytes) > 0 {
					line := strings.TrimSpace(string(lineBytes))
					if line != "" {
						var msg SessionMessage
						if err := json.Unmarshal([]byte(line), &msg); err == nil {
							messages = append(messages, msg)
						}
					}
				}
				break
			}
			return nil, fmt.Errorf("error reading session file: %w", err)
		}

		line := strings.TrimSpace(string(lineBytes))

		// Skip empty lines
		if line == "" {
			continue
		}

		// Try to parse the line as JSON
		var msg SessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			// Skip lines that fail to parse (may be mid-write or malformed)
			log.Debug().
				Err(err).
				Int("line", lineNum).
				Str("sessionId", sessionID).
				Msg("skipped unparseable line in session file")
			continue
		}

		messages = append(messages, msg)
	}

	return messages, nil
}

// findSessionFile locates the JSONL file for a session
func findSessionFile(sessionID, projectPath string) (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}

	claudeDir := filepath.Join(homeDir, ".claude")

	// Try to read sessions-index.json to get the exact path
	if projectPath != "" {
		sanitizedPath := sanitizeProjectPath(projectPath)
		indexPath := filepath.Join(claudeDir, "projects", sanitizedPath, "sessions-index.json")

		if index, err := readSessionIndex(indexPath); err == nil {
			// Find the session in the index
			for _, entry := range index.Entries {
				if entry.SessionID == sessionID {
					return entry.FullPath, nil
				}
			}
		}
	}

	// Fallback: search all project directories
	projectsDir := filepath.Join(claudeDir, "projects")
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return "", fmt.Errorf("failed to read projects directory: %w", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		// Check if this project has the session
		sessionFile := filepath.Join(projectsDir, entry.Name(), sessionID+".jsonl")
		if _, err := os.Stat(sessionFile); err == nil {
			return sessionFile, nil
		}
	}

	return "", fmt.Errorf("session file not found for session %s", sessionID)
}

// readSessionIndex reads and parses a sessions-index.json file
func readSessionIndex(path string) (*SessionIndex, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var index SessionIndex
	if err := json.Unmarshal(data, &index); err != nil {
		return nil, err
	}

	return &index, nil
}

// sanitizeProjectPath converts a project path to the Claude directory format
// e.g., "/Users/foo/projects/bar" -> "-Users-foo-projects-bar"
func sanitizeProjectPath(path string) string {
	// Replace slashes with hyphens
	sanitized := strings.ReplaceAll(path, "/", "-")

	// Remove leading hyphen if present (from absolute paths)
	if strings.HasPrefix(sanitized, "-") {
		sanitized = sanitized[1:]
	}

	// Prepend hyphen (Claude's format)
	return "-" + sanitized
}

// GetSessionIndexForProject returns all sessions for a project
func GetSessionIndexForProject(projectPath string) (*SessionIndex, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}

	sanitizedPath := sanitizeProjectPath(projectPath)
	indexPath := filepath.Join(homeDir, ".claude", "projects", sanitizedPath, "sessions-index.json")

	return readSessionIndex(indexPath)
}

// GetAllSessionIndexes returns sessions from all Claude project directories
func GetAllSessionIndexes() (*SessionIndex, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}

	projectsDir := filepath.Join(homeDir, ".claude", "projects")
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read projects directory: %w", err)
	}

	// Collect all sessions from all project directories
	allEntries := make([]SessionIndexEntry, 0)
	seenSessions := make(map[string]bool)

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		indexPath := filepath.Join(projectsDir, entry.Name(), "sessions-index.json")
		index, err := readSessionIndex(indexPath)
		if err != nil {
			// Skip directories without index files
			continue
		}

		for _, sessionEntry := range index.Entries {
			// Avoid duplicates (same session could theoretically appear in multiple indexes)
			if seenSessions[sessionEntry.SessionID] {
				continue
			}
			seenSessions[sessionEntry.SessionID] = true
			allEntries = append(allEntries, sessionEntry)
		}
	}

	return &SessionIndex{
		Version: 1,
		Entries: allEntries,
	}, nil
}

// GetTextContent extracts text content from a message
// For user messages: returns the string content directly
// For assistant messages: extracts and joins text from all text blocks
func (m *SessionMessage) GetTextContent() string {
	if m.Message == nil || m.Message.Content == nil {
		return ""
	}

	// User messages have string content
	if str, ok := m.Message.Content.(string); ok {
		return str
	}

	// Assistant messages have []ContentBlock (comes as []interface{})
	if blocks, ok := m.Message.Content.([]interface{}); ok {
		var texts []string
		for _, block := range blocks {
			if blockMap, ok := block.(map[string]interface{}); ok {
				if blockMap["type"] == "text" {
					if text, ok := blockMap["text"].(string); ok {
						texts = append(texts, text)
					}
				}
			}
		}
		return strings.Join(texts, "\n")
	}

	return ""
}

// GetUserPrompt extracts the actual user-typed text from a user message,
// filtering out system-injected tags like <ide_opened_file>, <ide_selection>, <system-reminder>
func (m *SessionMessage) GetUserPrompt() string {
	if m.Message == nil || m.Message.Content == nil || m.Type != "user" {
		return ""
	}

	var userTexts []string

	// User messages can be string or []ContentBlock
	if str, ok := m.Message.Content.(string); ok {
		// Single string content - filter out system tags
		filtered := filterSystemTags(str)
		if filtered != "" {
			userTexts = append(userTexts, filtered)
		}
	} else if blocks, ok := m.Message.Content.([]interface{}); ok {
		// Array of content blocks
		for _, block := range blocks {
			if blockMap, ok := block.(map[string]interface{}); ok {
				if blockMap["type"] == "text" {
					if text, ok := blockMap["text"].(string); ok {
						// Filter out system-injected tags
						filtered := filterSystemTags(text)
						if filtered != "" {
							userTexts = append(userTexts, filtered)
						}
					}
				}
			}
		}
	}

	return strings.Join(userTexts, "\n")
}

// filterSystemTags removes system-injected XML tags from text
// Returns empty string if text is only system tags
func filterSystemTags(text string) string {
	// Check if text starts with a system tag
	if strings.HasPrefix(text, "<ide_") ||
		strings.HasPrefix(text, "<system-reminder>") {
		return ""
	}
	return strings.TrimSpace(text)
}

// GetToolCalls extracts tool use blocks from an assistant message
func (m *SessionMessage) GetToolCalls() []ContentBlock {
	if m.Message == nil || m.Message.Content == nil {
		return nil
	}

	// Only assistant messages have tool calls
	if m.Type != "assistant" {
		return nil
	}

	blocks, ok := m.Message.Content.([]interface{})
	if !ok {
		return nil
	}

	var toolCalls []ContentBlock
	for _, block := range blocks {
		blockMap, ok := block.(map[string]interface{})
		if !ok {
			continue
		}

		if blockMap["type"] == "tool_use" {
			toolCall := ContentBlock{
				Type: "tool_use",
			}
			if id, ok := blockMap["id"].(string); ok {
				toolCall.ID = id
			}
			if name, ok := blockMap["name"].(string); ok {
				toolCall.Name = name
			}
			if input, ok := blockMap["input"].(map[string]interface{}); ok {
				toolCall.Input = input
			}
			toolCalls = append(toolCalls, toolCall)
		}
	}

	return toolCalls
}

// GetFirstUserPrompt reads the session JSONL and extracts the actual first user prompt
// (filtering out system-injected tags). Returns empty string if no user prompt found.
func GetFirstUserPrompt(sessionID, projectPath string) string {
	messages, err := ReadSessionHistory(sessionID, projectPath)
	if err != nil {
		return ""
	}

	// Find first user message with actual user content
	for _, msg := range messages {
		if msg.Type == "user" {
			userPrompt := msg.GetUserPrompt()
			if userPrompt != "" {
				return userPrompt
			}
		}
	}

	return ""
}

// GetSessionDisplayTitle computes the display title for a session with priority:
// 1. CustomTitle (user-set via /title command)
// 2. Summary (Claude-generated)
// 3. First actual user prompt from JSONL (only read if needed)
// 4. "Untitled" as fallback
func GetSessionDisplayTitle(entry SessionIndexEntry) string {
	// Priority 1: User-set custom title
	if entry.CustomTitle != "" {
		return entry.CustomTitle
	}

	// Priority 2: Claude-generated summary
	if entry.Summary != "" {
		return entry.Summary
	}

	// Priority 3: Check if firstPrompt has actual user content (not just system tags)
	// If firstPrompt starts with system tags, we need to read the JSONL
	if !strings.HasPrefix(entry.FirstPrompt, "<ide_") &&
		!strings.HasPrefix(entry.FirstPrompt, "<system-reminder>") {
		// FirstPrompt contains actual user text
		return entry.FirstPrompt
	}

	// FirstPrompt is only system tags - read JSONL to get real first user prompt
	if userPrompt := GetFirstUserPrompt(entry.SessionID, entry.ProjectPath); userPrompt != "" {
		return userPrompt
	}

	// Priority 4: Fallback
	return "Untitled"
}

// TodoItem represents a task in a Claude Code session
type TodoItem struct {
	Content    string `json:"content"`
	Status     string `json:"status"`     // "pending", "in_progress", "completed"
	ActiveForm string `json:"activeForm"` // Present continuous form (e.g., "Running tests")
}

// ReadSessionTodos reads the todo file for a session
// Todo files are stored at ~/.claude/todos/{sessionId}-agent-{agentId}.json
// For now, we only read the main agent's todos ({sessionId}-agent-main.json)
func ReadSessionTodos(sessionID string) ([]TodoItem, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}

	// Try to read main agent todos
	todoPath := filepath.Join(homeDir, ".claude", "todos", sessionID+"-agent-main.json")

	// Check if file exists
	if _, err := os.Stat(todoPath); os.IsNotExist(err) {
		// No todos file - return empty array (not an error)
		return []TodoItem{}, nil
	}

	// Read file
	data, err := os.ReadFile(todoPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read todos file: %w", err)
	}

	// Parse JSON
	var todos []TodoItem
	if err := json.Unmarshal(data, &todos); err != nil {
		return nil, fmt.Errorf("failed to parse todos file: %w", err)
	}

	return todos, nil
}
