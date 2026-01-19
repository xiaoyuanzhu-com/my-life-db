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

// SessionMessage represents a single message in a session JSONL file
type SessionMessage struct {
	Type       string          `json:"type"`       // "user", "assistant", "tool_result", etc.
	UUID       string          `json:"uuid"`       // Message ID
	ParentUUID *string         `json:"parentUuid"` // Parent message ID (null for root)
	Timestamp  string          `json:"timestamp"`  // ISO 8601 timestamp
	Message    json.RawMessage `json:"message"`    // Full message object (role, content, etc.)

	// Additional fields that may be present
	IsSidechain  *bool           `json:"isSidechain,omitempty"`
	UserType     string          `json:"userType,omitempty"`
	CWD          string          `json:"cwd,omitempty"`
	SessionID    string          `json:"sessionId,omitempty"`
	Version      string          `json:"version,omitempty"`
	GitBranch    string          `json:"gitBranch,omitempty"`
	RequestID    string          `json:"requestId,omitempty"`
	ToolUseResult json.RawMessage `json:"toolUseResult,omitempty"`
}

// SessionIndex represents the sessions-index.json file
type SessionIndex struct {
	Version int                  `json:"version"`
	Entries []SessionIndexEntry `json:"entries"`
}

// SessionIndexEntry represents a single session in the index
type SessionIndexEntry struct {
	SessionID   string `json:"sessionId"`
	FullPath    string `json:"fullPath"`
	FileMtime   int64  `json:"fileMtime"`
	FirstPrompt string `json:"firstPrompt"`
	MessageCount int   `json:"messageCount"`
	Created     string `json:"created"`
	Modified    string `json:"modified"`
	GitBranch   string `json:"gitBranch"`
	ProjectPath string `json:"projectPath"`
	IsSidechain bool   `json:"isSidechain"`
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
	scanner := bufio.NewScanner(file)

	// Increase buffer size for large lines (some tool results can be huge)
	const maxCapacity = 1024 * 1024 // 1MB
	buf := make([]byte, maxCapacity)
	scanner.Buffer(buf, maxCapacity)

	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())

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

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading session file: %w", err)
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
