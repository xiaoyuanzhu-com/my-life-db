package claude

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/claude/models"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ReadSessionHistoryRaw reads a session JSONL file and returns typed messages.
// Each message is parsed into its specific type (UserSessionMessage, AssistantSessionMessage, etc.)
// All messages preserve raw JSON for passthrough serialization via MarshalJSON().
//
// This is the ONLY session reader function - use for both API responses and internal operations.
// For typed access (e.g., extracting user prompts), use type assertion:
//
//	if userMsg, ok := msg.(*models.UserSessionMessage); ok {
//	    prompt := userMsg.GetUserPrompt()
//	}
func ReadSessionHistoryRaw(sessionID, projectPath string) ([]models.SessionMessageI, error) {
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

	var messages []models.SessionMessageI
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
					msg := parseTypedMessage(lineBytes, lineNum, sessionID)
					if msg != nil {
						messages = append(messages, msg)
					}
				}
				break
			}
			return nil, fmt.Errorf("error reading session file: %w", err)
		}

		msg := parseTypedMessage(lineBytes, lineNum, sessionID)
		if msg != nil {
			messages = append(messages, msg)
		}
	}

	return messages, nil
}

// parseTypedMessage parses a line into the appropriate typed message struct.
// Raw JSON is always preserved for passthrough serialization.
// Returns nil only for empty lines.
func parseTypedMessage(lineBytes []byte, lineNum int, sessionID string) models.SessionMessageI {
	line := strings.TrimSpace(string(lineBytes))
	if line == "" {
		return nil
	}

	// Make a copy for the Raw field - used for serialization
	rawCopy := make([]byte, len(line))
	copy(rawCopy, []byte(line))

	// Extract type to determine which struct to use
	var typeOnly struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(line), &typeOnly); err != nil {
		log.Warn().
			Err(err).
			Int("line", lineNum).
			Str("sessionId", sessionID).
			Msg("failed to parse message type, returning unknown")
		return &models.UnknownSessionMessage{
			RawJSON: models.RawJSON{Raw: rawCopy},
		}
	}

	// Parse into appropriate typed struct based on type
	switch typeOnly.Type {
	case "user":
		var msg models.UserSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse user message")
		}
		msg.Raw = rawCopy
		return &msg

	case "assistant":
		var msg models.AssistantSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse assistant message")
		}
		msg.Raw = rawCopy
		return &msg

	case "system":
		// Check subtype to determine which struct to use
		var subtypeOnly struct {
			Subtype string `json:"subtype"`
		}
		json.Unmarshal([]byte(line), &subtypeOnly)

		if subtypeOnly.Subtype == "init" {
			var msg models.SystemInitMessage
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse system init message")
			}
			msg.Raw = rawCopy
			return &msg
		}

		var msg models.SystemSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse system message")
		}
		msg.Raw = rawCopy
		return &msg

	case "result":
		var msg models.ResultSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse result message")
		}
		msg.Raw = rawCopy
		return &msg

	case "progress":
		var msg models.ProgressSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse progress message")
		}
		msg.Raw = rawCopy
		return &msg

	case "summary":
		var msg models.SummarySessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse summary message")
		}
		msg.Raw = rawCopy
		return &msg

	case "custom-title":
		var msg models.CustomTitleSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse custom-title message")
		}
		msg.Raw = rawCopy
		return &msg

	case "tag":
		var msg models.TagSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse tag message")
		}
		msg.Raw = rawCopy
		return &msg

	case "agent-name":
		var msg models.AgentNameSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse agent-name message")
		}
		msg.Raw = rawCopy
		return &msg

	case "queue-operation":
		var msg models.QueueOperationSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse queue-operation message")
		}
		msg.Raw = rawCopy
		return &msg

	case "file-history-snapshot":
		var msg models.FileHistorySnapshotSessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			log.Warn().Err(err).Int("line", lineNum).Str("type", typeOnly.Type).Msg("failed to parse file-history-snapshot message")
		}
		msg.Raw = rawCopy
		return &msg

	default:
		// Unknown type - return as unknown with raw JSON preserved
		log.Debug().
			Str("type", typeOnly.Type).
			Int("line", lineNum).
			Str("sessionId", sessionID).
			Msg("unknown message type, returning raw")
		return &models.UnknownSessionMessage{
			RawJSON:     models.RawJSON{Raw: rawCopy},
			BaseMessage: models.BaseMessage{Type: typeOnly.Type},
		}
	}
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

// findSessionByJSONL searches for a session JSONL file directly in all project directories.
// Returns the project path (working directory) if found, and a boolean indicating if found.
// This is used as a fallback when the session isn't in the index yet (Claude updates index asynchronously).
func findSessionByJSONL(sessionID string) (projectPath string, found bool) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}

	projectsDir := filepath.Join(homeDir, ".claude", "projects")
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return "", false
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		// Check if this project has the session JSONL file
		sessionFile := filepath.Join(projectsDir, entry.Name(), sessionID+".jsonl")
		if _, err := os.Stat(sessionFile); err == nil {
			// Found the JSONL file - extract project path from directory name
			// Directory names are sanitized paths like "-Users-foo-projects-myapp"
			// We can't reliably reverse this, so return empty and let caller use default
			return "", true
		}
	}

	return "", false
}

// readSessionIndex reads and parses a sessions-index.json file
func readSessionIndex(path string) (*models.SessionIndex, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var index models.SessionIndex
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
func GetSessionIndexForProject(projectPath string) (*models.SessionIndex, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}

	sanitizedPath := sanitizeProjectPath(projectPath)
	indexPath := filepath.Join(homeDir, ".claude", "projects", sanitizedPath, "sessions-index.json")

	return readSessionIndex(indexPath)
}

// GetAllSessionIndexes returns sessions from all Claude project directories
func GetAllSessionIndexes() (*models.SessionIndex, error) {
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
	allEntries := make([]models.SessionIndexEntry, 0)
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

	return &models.SessionIndex{
		Version: 1,
		Entries: allEntries,
	}, nil
}

// GetFirstUserPrompt reads the session JSONL and extracts the actual first user prompt
// (filtering out system-injected tags). Returns empty string if no user prompt found.
func GetFirstUserPrompt(sessionID, projectPath string) string {
	messages, err := ReadSessionHistoryRaw(sessionID, projectPath)
	if err != nil {
		return ""
	}

	// Find first user message with actual user content
	for _, msg := range messages {
		if msg.GetType() == "user" {
			// Type assert to UserSessionMessage to access GetUserPrompt()
			if userMsg, ok := msg.(*models.UserSessionMessage); ok {
				userPrompt := userMsg.GetUserPrompt()
				if userPrompt != "" {
					return userPrompt
				}
			}
		}
	}

	return ""
}

// ReadSessionTodos reads the todo file for a session
// Todo files are stored at ~/.claude/todos/{sessionId}-agent-{agentId}.json
// For now, we only read the main agent's todos ({sessionId}-agent-main.json)
func ReadSessionTodos(sessionID string) ([]models.TodoItem, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}

	// Try to read main agent todos
	todoPath := filepath.Join(homeDir, ".claude", "todos", sessionID+"-agent-main.json")

	// Check if file exists
	if _, err := os.Stat(todoPath); os.IsNotExist(err) {
		// No todos file - return empty array (not an error)
		return []models.TodoItem{}, nil
	}

	// Read file
	data, err := os.ReadFile(todoPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read todos file: %w", err)
	}

	// Parse JSON
	var todos []models.TodoItem
	if err := json.Unmarshal(data, &todos); err != nil {
		return nil, fmt.Errorf("failed to parse todos file: %w", err)
	}

	return todos, nil
}
