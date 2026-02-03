package claude

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

var (
	ErrSessionNotFound = fmt.Errorf("session not found")
)

// Permission configuration for Claude CLI
// These control which tools are auto-approved vs blocked
// Reference: https://code.claude.com/docs/en/settings#tools-available-to-claude
//
// IMPORTANT: Bash pattern matching limitations
// ============================================
// Claude Code uses glob patterns for bash command matching, but these have significant limitations:
//
// 1. Pipes and shell metacharacters don't match reliably
//   - "Bash(find *)" matches "find /path" but NOT "find /path | wc -l"
//   - The entire command string (including pipes) must match the pattern
//
// 2. Pattern matching is fragile for security
//   - "Bash(curl http://example.com/ *)" won't match "curl -X GET http://example.com/..."
//   - Flag ordering, shell variables, and subshells can bypass restrictions
//
// 3. Industry guidance (from Claude Code docs):
//
//	"Bash permission patterns that try to constrain command arguments are fragile
//	 and should not be relied upon as a security boundary."
//
// Alternative approaches:
//
// Option A: Allow all bash with Bash(*)
//   - Since we already allow Edit/Write, bash restrictions provide little real security
//   - Claude can write a script and execute it anyway
//   - Simpler but loses visibility into what's being run
//
// Option B: Custom callback logic in CreatePermissionCallback()
//   - Don't put Bash patterns in allowedTools
//   - Implement isDangerousBashCommand(cmd) to check for rm, sudo, etc.
//   - Auto-allow safe commands, prompt only for dangerous ones
//   - More control but adds custom code complexity
//
// Option C: Sandboxing (recommended for high-security)
//   - Use DevContainers or Claude's sandbox mode
//   - True isolation regardless of what commands run
//   - See: https://code.claude.com/docs/en/settings (sandbox section)
//
// Current approach: Enumerate common safe patterns, accept that complex commands
// (pipes, etc.) will prompt for permission. This provides visibility into operations
// without false security guarantees.
//
// References:
// - https://code.claude.com/docs/en/settings
// - https://www.joinformal.com/blog/allowlisting-some-bash-commands-is-often-the-same-as-allowlisting-all-with-claude-code/
var (
	// Tools that are always allowed without prompting
	allowedTools = []string{
		// === No permission required by default ===
		"AskUserQuestion", // Asks multiple-choice questions
		"Glob",            // Finds files based on pattern matching
		"Grep",            // Searches for patterns in file contents
		"KillShell",       // Kills a running background bash shell
		"LSP",             // Code intelligence via language servers
		"MCPSearch",       // Searches for and loads MCP tools
		"Read",            // Reads the contents of files
		"Task",            // Runs a sub-agent for multi-step tasks
		"TaskCreate",      // Creates a new task in the task list
		"TaskGet",         // Retrieves full details for a specific task
		"TaskList",        // Lists all tasks with their current status
		"TaskOutput",      // Retrieves output from a background task
		"TaskUpdate",      // Updates task status/dependencies/details
		"TodoWrite",       // Tracks progress with todo list

		// === Permission required by default, we allow ===
		"Edit",         // Makes targeted edits to specific files
		"NotebookEdit", // Modifies Jupyter notebook cells
		"Skill",        // Executes a skill within the conversation
		"WebFetch",     // Fetches content from a specified URL
		"WebSearch",    // Performs web searches
		"Write",        // Creates or overwrites files

		// === Bash commands (selective patterns) ===
		// NOTE: These patterns only match simple commands without pipes or complex shell syntax.
		// Commands like "find /path | wc -l" will still prompt for permission.
		// See the comment block above for why this is a known limitation.
		"Bash(ls *)",
		"Bash(cat *)",
		"Bash(head *)",
		"Bash(tail *)",
		"Bash(wc *)",
		"Bash(find *)",
		"Bash(tree *)",
		"Bash(pwd)",
		"Bash(which *)",
		"Bash(echo *)",
		"Bash(sed *)",
		// Git commands
		"Bash(git *)",
	}

	// Tools/commands that are never allowed (dangerous operations)
	// NOTE: These use the deprecated ":*" syntax (equivalent to " *").
	// However, like allowedTools, these patterns have the same limitations -
	// they won't match if flags are reordered or pipes are used.
	// Deny rules take precedence over allow rules.
	disallowedTools = []string{
		"Bash(rm -rf *)",
		"Bash(sudo *)",
	}
)

// isToolAllowed checks if a tool should be auto-approved based on the allowedTools list.
// This is called by CreatePermissionCallback to determine if a tool permission request
// should be auto-approved without prompting the user.
//
// For simple tools (Read, Write, etc.), it checks exact name match.
// For Bash tools, it checks if the command matches any allowed Bash pattern.
// Deny rules take precedence over allow rules.
func isToolAllowed(toolName string, input map[string]any) bool {
	// For Bash commands, check patterns
	if toolName == "Bash" {
		command, ok := input["command"].(string)
		if !ok || command == "" {
			return false
		}

		// Check disallowed patterns first (deny takes precedence)
		for _, pattern := range disallowedTools {
			if matchBashPattern(pattern, command) {
				return false
			}
		}

		// Check allowed Bash patterns
		for _, pattern := range allowedTools {
			if matchBashPattern(pattern, command) {
				return true
			}
		}

		return false
	}

	// For non-Bash tools, check simple name match
	for _, allowed := range allowedTools {
		// Skip Bash patterns when checking simple tools
		if strings.HasPrefix(allowed, "Bash(") {
			continue
		}
		if allowed == toolName {
			return true
		}
	}

	return false
}

// matchBashPattern checks if a command matches a Bash pattern like "Bash(git *)".
// Patterns use simple glob matching where * matches any characters.
// Returns false if the pattern is not a Bash pattern.
func matchBashPattern(pattern, command string) bool {
	// Check if it's a Bash pattern
	if !strings.HasPrefix(pattern, "Bash(") || !strings.HasSuffix(pattern, ")") {
		return false
	}

	// Extract the command pattern from "Bash(pattern)"
	cmdPattern := pattern[5 : len(pattern)-1] // Remove "Bash(" and ")"

	// Handle exact match (no wildcard)
	if !strings.Contains(cmdPattern, "*") {
		return command == cmdPattern
	}

	// Handle wildcard patterns
	// "git *" should match "git status" but not "gitk"
	// "ls *" should match "ls -la" but not "lsof"
	if strings.HasSuffix(cmdPattern, " *") {
		// Pattern like "git *" - prefix match with space boundary
		prefix := cmdPattern[:len(cmdPattern)-2] // Remove " *"
		return command == prefix || strings.HasPrefix(command, prefix+" ")
	} else if strings.HasSuffix(cmdPattern, "*") {
		// Pattern like "ls*" - simple prefix match (no boundary)
		prefix := cmdPattern[:len(cmdPattern)-1]
		return strings.HasPrefix(command, prefix)
	}

	// For patterns with * in the middle, use simple contains check
	// This is a simplification - full glob matching would be more complex
	parts := strings.Split(cmdPattern, "*")
	if len(parts) == 2 {
		return strings.HasPrefix(command, parts[0]) && strings.HasSuffix(command, parts[1])
	}

	return false
}

// gracefulTerminate attempts to gracefully terminate a Claude CLI process.
//
// Signal behavior (Claude CLI is Node.js):
//   - SIGINT (Ctrl+C): ✅ Works - Node.js has built-in handler for graceful exit
//   - SIGTERM:         ❌ Ignored - No default handler in Node.js CLI apps
//   - SIGKILL:         ✅ Works - Kernel-level force kill (last resort)
//
// This function sends SIGINT first, waits for the timeout period, then falls back
// to SIGKILL if the process doesn't exit. This allows Claude to finish writing
// any pending data (like JSONL session files).
//
// Used by: PTY mode sessions (legacy CLI mode)
func gracefulTerminate(cmd *exec.Cmd, timeout time.Duration) {
	if cmd == nil || cmd.Process == nil {
		return
	}

	// Send SIGINT for graceful shutdown (Claude CLI responds to SIGINT, not SIGTERM)
	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		// Process might already be dead, try Kill anyway
		cmd.Process.Kill()
		return
	}

	// Wait for process to exit gracefully
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		close(done)
	}()

	select {
	case <-done:
		// Process exited gracefully
		return
	case <-time.After(timeout):
		// Timeout, force kill
		log.Warn().Int("pid", cmd.Process.Pid).Msg("process didn't exit gracefully, sending SIGKILL")
		cmd.Process.Kill()
	}
}

// buildClaudeArgs constructs the command-line arguments for launching Claude
// with appropriate permission settings for web UI usage
func buildClaudeArgs(sessionID string, resume bool, mode SessionMode) []string {
	var args []string

	if mode == ModeUI {
		// UI mode: JSON streaming with interactive permission handling
		args = []string{
			"--output-format", "stream-json",
			"--input-format", "stream-json",
			"--permission-mode", "default", // Enable control_request for permission handling
			"--verbose",
		}

		// Add allowed tools (comma-separated, matching Python SDK format)
		if len(allowedTools) > 0 {
			args = append(args, "--allowedTools", strings.Join(allowedTools, ","))
		}
	} else {
		// CLI mode: PTY with skipped permissions (legacy behavior)
		args = []string{
			"--dangerously-skip-permissions", // Skip interactive permission prompts
		}

		// Add allowed tools (comma-separated, matching Python SDK format)
		if len(allowedTools) > 0 {
			args = append(args, "--allowedTools", strings.Join(allowedTools, ","))
		}

		// Add disallowed tools (comma-separated, matching Python SDK format)
		if len(disallowedTools) > 0 {
			args = append(args, "--disallowedTools", strings.Join(disallowedTools, ","))
		}
	}

	// Add session flag
	if resume {
		args = append(args, "--resume", sessionID)
	} else {
		args = append(args, "--session-id", sessionID)
	}

	return args
}

// splitConcatenatedJSON splits a byte slice containing concatenated JSON objects
// e.g., `{"a":1}{"b":2}` becomes `[{"a":1}, {"b":2}]`
func splitConcatenatedJSON(data []byte) [][]byte {
	if len(data) == 0 {
		return nil
	}

	var result [][]byte
	decoder := json.NewDecoder(bytes.NewReader(data))

	for {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			break
		}
		// Make a copy since raw may be backed by the original slice
		obj := make([]byte, len(raw))
		copy(obj, raw)
		result = append(result, obj)
	}

	return result
}
