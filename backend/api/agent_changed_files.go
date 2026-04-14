package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ChangedFile represents a single file change.
type ChangedFile struct {
	Path   string `json:"path"`
	Status string `json:"status"` // "added", "modified", "deleted", "renamed", "untracked"
}

// ChangedFilesResponse is the response for GET /api/agent/sessions/:id/changed-files.
type ChangedFilesResponse struct {
	Source string        `json:"source"` // "git" or "tools"
	Files  []ChangedFile `json:"files"`
}

// GetAgentChangedFiles returns files changed during an agent session.
// For git directories: runs git status --porcelain.
// For non-git directories: parses tool calls from session messages.
// GET /api/agent/sessions/:id/changed-files
func (h *Handlers) GetAgentChangedFiles(c *gin.Context) {
	sessionID := c.Param("id")

	session, err := db.GetAgentSession(sessionID)
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to get agent session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get session"})
		return
	}
	if session == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}

	workingDir := session.WorkingDir
	if workingDir == "" {
		c.JSON(http.StatusOK, ChangedFilesResponse{Source: "tools", Files: []ChangedFile{}})
		return
	}

	// Check if workingDir is a git repo
	if isGitDir(workingDir) {
		files := gitChangedFiles(workingDir)
		c.JSON(http.StatusOK, ChangedFilesResponse{Source: "git", Files: files})
		return
	}

	// Non-git: parse tool calls from session messages
	files := toolChangedFiles(sessionID)
	c.JSON(http.StatusOK, ChangedFilesResponse{Source: "tools", Files: files})
}

// isGitDir checks if a directory is inside a git repository.
func isGitDir(dir string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "rev-parse", "--git-dir")
	cmd.Dir = dir
	return cmd.Run() == nil
}

// gitChangedFiles runs git status --porcelain and parses the output.
func gitChangedFiles(dir string) []ChangedFile {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "--no-optional-locks", "status", "--porcelain")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		log.Warn().Err(err).Str("dir", dir).Msg("git status failed")
		return []ChangedFile{}
	}

	files := []ChangedFile{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if len(line) < 4 {
			continue
		}
		xy := line[:2]
		path := strings.TrimSpace(line[3:])

		// Handle renames: "R  old -> new"
		if strings.Contains(path, " -> ") {
			parts := strings.SplitN(path, " -> ", 2)
			path = parts[1]
		}

		status := parseGitStatus(xy)
		files = append(files, ChangedFile{Path: path, Status: status})
	}
	return files
}

// parseGitStatus maps git status --porcelain XY codes to our status strings.
func parseGitStatus(xy string) string {
	x := xy[0]
	y := xy[1]

	switch {
	case x == 'R' || y == 'R':
		return "renamed"
	case x == 'A' || y == 'A':
		return "added"
	case x == 'D' || y == 'D':
		return "deleted"
	case x == 'M' || y == 'M':
		return "modified"
	case x == '?' && y == '?':
		return "untracked"
	default:
		return "modified"
	}
}

// toolChangedFiles extracts file paths from tool_call frames in session messages.
func toolChangedFiles(sessionID string) []ChangedFile {
	ss := PeekSessionState(sessionID)
	if ss == nil {
		return []ChangedFile{}
	}

	raw := ss.GetRecentMessages(0)

	// Track unique paths and their status (last tool wins)
	seen := make(map[string]string)

	for _, msg := range raw {
		var frame struct {
			SessionUpdate string `json:"sessionUpdate"`
			Meta          *struct {
				ClaudeCode *struct {
					ToolName string `json:"toolName"`
				} `json:"claudeCode"`
			} `json:"_meta"`
			RawInput json.RawMessage `json:"rawInput"`
		}
		if err := json.Unmarshal(msg, &frame); err != nil {
			continue
		}
		if frame.SessionUpdate != "tool_call" {
			continue
		}

		toolName := ""
		if frame.Meta != nil && frame.Meta.ClaudeCode != nil {
			toolName = frame.Meta.ClaudeCode.ToolName
		}

		var input map[string]any
		if frame.RawInput != nil {
			json.Unmarshal(frame.RawInput, &input)
		}
		if input == nil {
			continue
		}

		switch toolName {
		case "Write":
			if fp, ok := input["file_path"].(string); ok && fp != "" {
				seen[fp] = "added"
			}
		case "Edit":
			if fp, ok := input["file_path"].(string); ok && fp != "" {
				seen[fp] = "modified"
			}
		case "mcp__agent-apps__putFile":
			if app, ok := input["app"].(string); ok {
				path := "apps/" + app
				if p, ok := input["path"].(string); ok {
					path += "/" + p
				}
				seen[path] = "added"
			}
		case "mcp__agent-apps__deleteFile":
			if app, ok := input["app"].(string); ok {
				path := "apps/" + app
				if p, ok := input["path"].(string); ok {
					path += "/" + p
				}
				seen[path] = "deleted"
			}
		}
	}

	files := make([]ChangedFile, 0, len(seen))
	for path, status := range seen {
		files = append(files, ChangedFile{Path: path, Status: status})
	}
	return files
}
