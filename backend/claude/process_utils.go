package claude

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
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

		// Add allowed tools (auto-approved without prompting)
		for _, tool := range allowedTools {
			args = append(args, "--allowedTools", tool)
		}
	} else {
		// CLI mode: PTY with skipped permissions (legacy behavior)
		args = []string{
			"--dangerously-skip-permissions", // Skip interactive permission prompts
		}

		// Add allowed tools
		for _, tool := range allowedTools {
			args = append(args, "--allowedTools", tool)
		}

		// Add disallowed tools
		for _, tool := range disallowedTools {
			args = append(args, "--disallowedTools", tool)
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
