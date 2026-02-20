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
		// Strip large Read tool content at the source — all downstream consumers
		// (HTTP endpoint, WebSocket, cache) get stripped messages via MarshalJSON().
		msg.Raw = StripReadToolContent(rawCopy)
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

// ReadSessionWithSubagents reads a session JSONL file and includes subagent messages.
// Subagent messages are stored in separate files at {sessionId}/subagents/agent-{agentId}.jsonl
// This function:
// 1. Reads the main session JSONL
// 2. Extracts agentId -> parentToolUseID mapping from agent_progress messages
// 3. Loads subagent files and adds parentToolUseID to each message
// 4. Returns all messages merged together
func ReadSessionWithSubagents(sessionID, projectPath string) ([]models.SessionMessageI, error) {
	// Read main session messages
	messages, err := ReadSessionHistoryRaw(sessionID, projectPath)
	if err != nil {
		return nil, err
	}

	// Extract agentId -> parentToolUseID mapping from progress messages
	agentToParentMap := extractAgentParentMapping(messages)
	if len(agentToParentMap) == 0 {
		// No subagents, return main messages as-is
		return messages, nil
	}

	// Find session directory for subagent files
	sessionDir, err := findSessionDirectory(sessionID, projectPath)
	if err != nil {
		// No session directory - return main messages only
		log.Debug().Err(err).Str("sessionId", sessionID).Msg("no session directory for subagents")
		return messages, nil
	}

	// Load subagent messages
	subagentMessages, err := readSubagentMessages(sessionDir, agentToParentMap)
	if err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to read some subagent messages")
		// Continue with partial results
	}

	// Merge subagent messages into main list
	if len(subagentMessages) > 0 {
		messages = append(messages, subagentMessages...)
	}

	return messages, nil
}

// extractAgentParentMapping extracts agentId -> parentToolUseID mapping from progress messages.
// This mapping tells us which Task tool_use spawned each subagent.
func extractAgentParentMapping(messages []models.SessionMessageI) map[string]string {
	mapping := make(map[string]string)

	for _, msg := range messages {
		progressMsg, ok := msg.(*models.ProgressSessionMessage)
		if !ok {
			continue
		}

		// Check if this is an agent_progress message
		agentData, err := progressMsg.GetAgentProgressData()
		if err != nil || agentData == nil {
			continue
		}

		// Map agentId to parentToolUseID
		if agentData.AgentID != "" && progressMsg.ParentToolUseID != "" {
			mapping[agentData.AgentID] = progressMsg.ParentToolUseID
		}
	}

	return mapping
}

// findSessionDirectory finds the session subdirectory (if it exists).
// Returns the path to {projectDir}/{sessionId}/ directory.
func findSessionDirectory(sessionID, projectPath string) (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}

	claudeDir := filepath.Join(homeDir, ".claude")

	// Try using project path first
	if projectPath != "" {
		sanitizedPath := sanitizeProjectPath(projectPath)
		sessionDir := filepath.Join(claudeDir, "projects", sanitizedPath, sessionID)
		if info, err := os.Stat(sessionDir); err == nil && info.IsDir() {
			return sessionDir, nil
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

		sessionDir := filepath.Join(projectsDir, entry.Name(), sessionID)
		if info, err := os.Stat(sessionDir); err == nil && info.IsDir() {
			return sessionDir, nil
		}
	}

	return "", fmt.Errorf("session directory not found for session %s", sessionID)
}

// readSubagentMessages reads all subagent JSONL files and adds parentToolUseID to each message.
func readSubagentMessages(sessionDir string, agentToParentMap map[string]string) ([]models.SessionMessageI, error) {
	subagentsDir := filepath.Join(sessionDir, "subagents")
	entries, err := os.ReadDir(subagentsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // No subagents directory
		}
		return nil, fmt.Errorf("failed to read subagents directory: %w", err)
	}

	var allMessages []models.SessionMessageI

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}

		// Extract agentId from filename: "agent-{agentId}.jsonl"
		name := entry.Name()
		if !strings.HasPrefix(name, "agent-") {
			continue
		}
		agentID := strings.TrimSuffix(strings.TrimPrefix(name, "agent-"), ".jsonl")

		// Get parentToolUseID for this agent
		parentToolUseID, ok := agentToParentMap[agentID]
		if !ok {
			log.Debug().Str("agentId", agentID).Msg("no parent mapping found for subagent")
			continue
		}

		// Read subagent JSONL file
		agentFilePath := filepath.Join(subagentsDir, name)
		agentMessages, err := readSubagentJSONL(agentFilePath, parentToolUseID)
		if err != nil {
			log.Warn().Err(err).Str("file", agentFilePath).Msg("failed to read subagent file")
			continue
		}

		allMessages = append(allMessages, agentMessages...)
	}

	return allMessages, nil
}

// readSubagentJSONL reads a single subagent JSONL file and injects parentToolUseID into each message.
func readSubagentJSONL(filePath, parentToolUseID string) ([]models.SessionMessageI, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open subagent file: %w", err)
	}
	defer file.Close()

	var messages []models.SessionMessageI
	reader := bufio.NewReader(file)
	lineNum := 0

	for {
		lineNum++
		lineBytes, err := reader.ReadBytes('\n')
		if err != nil {
			if err.Error() == "EOF" {
				if len(lineBytes) > 0 {
					msg := parseSubagentMessage(lineBytes, parentToolUseID, lineNum, filePath)
					if msg != nil {
						messages = append(messages, msg)
					}
				}
				break
			}
			return nil, fmt.Errorf("error reading subagent file: %w", err)
		}

		msg := parseSubagentMessage(lineBytes, parentToolUseID, lineNum, filePath)
		if msg != nil {
			messages = append(messages, msg)
		}
	}

	return messages, nil
}

// parseSubagentMessage parses a line from a subagent JSONL and injects parentToolUseID.
// We modify the raw JSON to include parentToolUseID before parsing.
func parseSubagentMessage(lineBytes []byte, parentToolUseID string, lineNum int, filePath string) models.SessionMessageI {
	line := strings.TrimSpace(string(lineBytes))
	if line == "" {
		return nil
	}

	// Inject parentToolUseID into the JSON
	// We add it as a top-level field to the raw JSON
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		log.Warn().Err(err).Int("line", lineNum).Str("file", filePath).Msg("failed to parse subagent message as JSON")
		return nil
	}

	// Add parentToolUseID field
	parentIDJSON, _ := json.Marshal(parentToolUseID)
	raw["parentToolUseID"] = parentIDJSON

	// Re-serialize to get modified JSON
	modifiedJSON, err := json.Marshal(raw)
	if err != nil {
		log.Warn().Err(err).Int("line", lineNum).Str("file", filePath).Msg("failed to re-serialize subagent message")
		return nil
	}

	// Use the existing parseTypedMessage with modified JSON
	// Extract sessionID from the message for logging (it's in the raw JSON)
	var sessionOnly struct {
		SessionID string `json:"sessionId"`
	}
	json.Unmarshal(modifiedJSON, &sessionOnly)

	return parseTypedMessage(modifiedJSON, lineNum, sessionOnly.SessionID)
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
// (filtering out system-injected tags and compact summary messages).
// Returns empty string if no user prompt found.
func GetFirstUserPrompt(sessionID, projectPath string) string {
	prompt, _ := GetFirstUserPromptAndUUID(sessionID, projectPath)
	return prompt
}

// GetFirstUserPromptAndUUID reads the session JSONL and extracts the first user prompt
// along with its UUID. The UUID can be used to detect related/continued sessions
// (sessions that share the same first user message UUID are continuations of each other).
func GetFirstUserPromptAndUUID(sessionID, projectPath string) (prompt string, uuid string) {
	messages, err := ReadSessionHistoryRaw(sessionID, projectPath)
	if err != nil {
		return "", ""
	}

	// Find first user message with actual user content
	// Skip compact summary messages (context compaction auto-generated messages)
	for _, msg := range messages {
		if msg.GetType() == "user" {
			// Type assert to UserSessionMessage to access GetUserPrompt()
			if userMsg, ok := msg.(*models.UserSessionMessage); ok {
				// Skip compact summary messages
				if userMsg.IsCompactSummary {
					continue
				}
				userPrompt := userMsg.GetUserPrompt()
				if userPrompt != "" {
					return userPrompt, userMsg.GetUUID()
				}
			}
		}
	}

	return "", ""
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
