package transport

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

const (
	// DefaultMaxBufferSize is the default maximum buffer size for JSON messages (1MB)
	DefaultMaxBufferSize = 1024 * 1024

	// MinimumClaudeCodeVersion is the minimum supported CLI version
	MinimumClaudeCodeVersion = "2.0.0"

	// SDKVersion is the version of this SDK
	SDKVersion = "0.1.0"
)

// Errors
var (
	ErrNotConnected     = fmt.Errorf("not connected")
	ErrAlreadyConnected = fmt.Errorf("already connected")
	ErrConnectionClosed = fmt.Errorf("connection closed")
)

// CLIConnectionError represents a connection error
type CLIConnectionError struct {
	Message string
	Cause   error
}

func (e *CLIConnectionError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("CLI connection error: %s: %v", e.Message, e.Cause)
	}
	return fmt.Sprintf("CLI connection error: %s", e.Message)
}

func (e *CLIConnectionError) Unwrap() error {
	return e.Cause
}

// SubprocessCLITransport implements Transport using a subprocess
type SubprocessCLITransport struct {
	options       TransportOptions
	prompt        string // Initial prompt (for non-streaming mode)
	isStreaming   bool   // Whether we're in streaming mode
	cliPath       string
	cwd           string
	maxBufferSize int

	// Process handles
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser

	// Channels for message streaming
	messages chan []byte
	errors   chan error

	// State
	connected bool
	closed    bool
	mu        sync.RWMutex
	writeMu   sync.Mutex // Protects stdin writes

	// Context for cancellation
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// Shutdown signaling - set early to expect process exit errors
	shuttingDown atomic.Bool
}

// NewSubprocessCLITransport creates a new subprocess transport
func NewSubprocessCLITransport(options TransportOptions) (*SubprocessCLITransport, error) {
	cliPath := options.CliPath
	if cliPath == "" {
		cliPath = "claude"
	}

	cwd := options.Cwd
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("failed to get working directory: %w", err)
		}
	}

	maxBufferSize := options.MaxBufferSize
	if maxBufferSize <= 0 {
		maxBufferSize = DefaultMaxBufferSize
	}

	return &SubprocessCLITransport{
		options:       options,
		isStreaming:   true, // Default to streaming mode
		cliPath:       cliPath,
		cwd:           cwd,
		maxBufferSize: maxBufferSize,
		messages:      make(chan []byte, 100),
		errors:        make(chan error, 10),
	}, nil
}

// NewSubprocessCLITransportWithPrompt creates a transport with an initial prompt (non-streaming)
func NewSubprocessCLITransportWithPrompt(prompt string, options TransportOptions) (*SubprocessCLITransport, error) {
	t, err := NewSubprocessCLITransport(options)
	if err != nil {
		return nil, err
	}
	t.prompt = prompt
	t.isStreaming = false
	return t, nil
}

// buildCommand constructs the CLI command with all arguments
func (t *SubprocessCLITransport) buildCommand() []string {
	cmd := []string{t.cliPath, "--output-format", "stream-json", "--verbose"}

	opts := t.options

	// System prompt
	if opts.SystemPrompt == "" {
		cmd = append(cmd, "--system-prompt", "")
	} else {
		cmd = append(cmd, "--system-prompt", opts.SystemPrompt)
	}

	// Tools configuration
	if len(opts.Tools) > 0 {
		cmd = append(cmd, "--tools", strings.Join(opts.Tools, ","))
	}

	// Allowed tools (comma-separated, matching Python SDK format)
	if len(opts.AllowedTools) > 0 {
		cmd = append(cmd, "--allowedTools", strings.Join(opts.AllowedTools, ","))
	}

	// Disallowed tools (comma-separated, matching Python SDK format)
	if len(opts.DisallowedTools) > 0 {
		cmd = append(cmd, "--disallowedTools", strings.Join(opts.DisallowedTools, ","))
	}

	// Permission mode
	if opts.PermissionMode != "" {
		cmd = append(cmd, "--permission-mode", opts.PermissionMode)
	}

	// Permission prompt tool name - enables control protocol for tool permissions
	// When set to "stdio", the CLI sends control_request messages for permission decisions
	// instead of prompting interactively. The SDK/caller must respond with control_response.
	if opts.PermissionPromptToolName != "" {
		cmd = append(cmd, "--permission-prompt-tool", opts.PermissionPromptToolName)
	}

	// Max turns
	if opts.MaxTurns != nil {
		cmd = append(cmd, "--max-turns", strconv.Itoa(*opts.MaxTurns))
	}

	// Model
	if opts.Model != "" {
		cmd = append(cmd, "--model", opts.Model)
	}

	// Fallback model
	if opts.FallbackModel != "" {
		cmd = append(cmd, "--fallback-model", opts.FallbackModel)
	}

	// Resume session
	if opts.Resume != "" {
		cmd = append(cmd, "--resume", opts.Resume)
	}

	// Continue conversation
	if opts.ContinueConversation {
		cmd = append(cmd, "--continue")
	}

	// Additional directories
	for _, dir := range opts.AddDirs {
		cmd = append(cmd, "--add-dir", dir)
	}

	// Include partial messages (enables stream_event messages with text deltas)
	if opts.IncludePartialMessages {
		cmd = append(cmd, "--include-partial-messages")
	}

	// Max thinking tokens
	if opts.MaxThinkingTokens != nil {
		cmd = append(cmd, "--max-thinking-tokens", strconv.Itoa(*opts.MaxThinkingTokens))
	}

	// File checkpointing
	if opts.EnableFileCheckpointing {
		// This is set via environment variable, not CLI flag
	}

	// Extra args (arbitrary CLI flags)
	for key, value := range opts.ExtraArgs {
		if value != nil {
			cmd = append(cmd, "--"+key, *value)
		} else {
			cmd = append(cmd, "--"+key)
		}
	}

	// Input format for streaming mode
	if t.isStreaming {
		cmd = append(cmd, "--input-format", "stream-json")
	} else {
		// Non-streaming mode: add prompt as argument
		cmd = append(cmd, "--print", "--", t.prompt)
	}

	return cmd
}

// Connect starts the subprocess and establishes communication
func (t *SubprocessCLITransport) Connect(ctx context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.connected {
		return ErrAlreadyConnected
	}

	if t.closed {
		return ErrConnectionClosed
	}

	// Create cancellable context
	t.ctx, t.cancel = context.WithCancel(ctx)

	// Build command
	cmdArgs := t.buildCommand()

	log.Info().
		Str("cli", t.cliPath).
		Strs("args", cmdArgs[1:]).
		Str("cwd", t.cwd).
		Msg("starting Claude CLI subprocess with args")

	// Create command
	t.cmd = exec.CommandContext(t.ctx, cmdArgs[0], cmdArgs[1:]...)
	t.cmd.Dir = t.cwd

	// Set up environment
	env := os.Environ()
	env = append(env, "CLAUDE_CODE_ENTRYPOINT=sdk-go")
	env = append(env, "CLAUDE_AGENT_SDK_VERSION="+SDKVersion)

	if t.options.EnableFileCheckpointing {
		env = append(env, "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true")
	}

	for key, value := range t.options.Env {
		env = append(env, key+"="+value)
	}
	t.cmd.Env = env

	// Create pipes
	var err error
	t.stdin, err = t.cmd.StdinPipe()
	if err != nil {
		return &CLIConnectionError{Message: "failed to create stdin pipe", Cause: err}
	}

	t.stdout, err = t.cmd.StdoutPipe()
	if err != nil {
		return &CLIConnectionError{Message: "failed to create stdout pipe", Cause: err}
	}

	t.stderr, err = t.cmd.StderrPipe()
	if err != nil {
		return &CLIConnectionError{Message: "failed to create stderr pipe", Cause: err}
	}

	// Start process
	if err := t.cmd.Start(); err != nil {
		return &CLIConnectionError{Message: "failed to start CLI process", Cause: err}
	}

	t.connected = true

	log.Info().
		Int("pid", t.cmd.Process.Pid).
		Str("cwd", t.cwd).
		Bool("streaming", t.isStreaming).
		Msg("Claude CLI subprocess started")

	// Start readers
	t.wg.Add(2)
	go t.readStdout()
	go t.readStderr()

	// Monitor process exit
	t.wg.Add(1)
	go t.monitorProcess()

	return nil
}

// readStdout reads JSON messages from stdout
func (t *SubprocessCLITransport) readStdout() {
	defer t.wg.Done()

	log.Debug().Msg("transport: starting stdout reader")

	scanner := bufio.NewScanner(t.stdout)
	// Set large buffer for potentially large JSON messages
	buf := make([]byte, t.maxBufferSize)
	scanner.Buffer(buf, t.maxBufferSize)

	for scanner.Scan() {
		select {
		case <-t.ctx.Done():
			log.Debug().Msg("transport: stdout reader cancelled")
			return
		default:
		}

		line := scanner.Bytes()
		log.Debug().Str("line", string(line)).Msg("transport: received line from stdout")
		if len(line) == 0 {
			continue
		}

		// Split concatenated JSON objects (Claude may output multiple on one line)
		jsonObjects := splitConcatenatedJSON(line)

		for _, jsonData := range jsonObjects {
			// Make a copy to avoid data races
			dataCopy := make([]byte, len(jsonData))
			copy(dataCopy, jsonData)

			select {
			case t.messages <- dataCopy:
			case <-t.ctx.Done():
				return
			}
		}
	}

	if err := scanner.Err(); err != nil {
		log.Error().Err(err).Msg("transport: stdout scanner error")
		select {
		case t.errors <- &CLIConnectionError{Message: "stdout read error", Cause: err}:
		case <-t.ctx.Done():
		}
	}

	log.Debug().Msg("transport: stdout reader finished")
}

// splitConcatenatedJSON splits a byte slice containing concatenated JSON objects
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

// readStderr reads and handles stderr output
func (t *SubprocessCLITransport) readStderr() {
	defer t.wg.Done()

	log.Debug().Msg("transport: starting stderr reader")

	scanner := bufio.NewScanner(t.stderr)

	for scanner.Scan() {
		select {
		case <-t.ctx.Done():
			return
		default:
		}

		line := scanner.Text()
		if line == "" {
			continue
		}

		// Call stderr callback if provided
		if t.options.Stderr != nil {
			t.options.Stderr(line)
		}

		// Log stderr for debugging
		log.Debug().Str("stderr", line).Msg("Claude CLI stderr")
	}

	log.Debug().Msg("transport: stderr reader finished")
}

// monitorProcess watches for process exit
func (t *SubprocessCLITransport) monitorProcess() {
	defer t.wg.Done()

	err := t.cmd.Wait()

	t.mu.Lock()
	t.connected = false
	t.mu.Unlock()

	// Log exit status
	if t.cmd.ProcessState != nil {
		log.Info().
			Int("exitCode", t.cmd.ProcessState.ExitCode()).
			Str("state", t.cmd.ProcessState.String()).
			Msg("Claude CLI process exited")
	}

	if err != nil {
		// Only report error if we didn't cancel (graceful shutdown)
		// Check shuttingDown flag first - it's set early in shutdown sequence
		// before context cancellation propagates
		if t.shuttingDown.Load() {
			log.Debug().Err(err).Msg("Claude CLI process terminated during shutdown")
		} else {
			select {
			case <-t.ctx.Done():
				// Context was cancelled - this is expected during graceful shutdown
				log.Debug().Err(err).Msg("Claude CLI process terminated during shutdown")
			default:
				// Unexpected error - process died on its own
				log.Error().Err(err).Msg("Claude CLI process error")
				select {
				case t.errors <- &CLIConnectionError{Message: "process exited", Cause: err}:
				default:
				}
			}
		}
	}

	// Close channels to signal end
	close(t.messages)
}

// Write sends data to Claude CLI's stdin
func (t *SubprocessCLITransport) Write(data string) error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()

	t.mu.RLock()
	if !t.connected {
		t.mu.RUnlock()
		return ErrNotConnected
	}
	if t.closed {
		t.mu.RUnlock()
		return ErrConnectionClosed
	}
	t.mu.RUnlock()

	_, err := io.WriteString(t.stdin, data)
	if err != nil {
		return &CLIConnectionError{Message: "failed to write to stdin", Cause: err}
	}

	return nil
}

// ReadMessages returns the channel for receiving messages
func (t *SubprocessCLITransport) ReadMessages() <-chan []byte {
	return t.messages
}

// Errors returns the channel for receiving errors
func (t *SubprocessCLITransport) Errors() <-chan error {
	return t.errors
}

// EndInput closes the stdin stream
func (t *SubprocessCLITransport) EndInput() error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()

	if t.stdin != nil {
		return t.stdin.Close()
	}
	return nil
}

// Close terminates the connection and cleans up resources.
//
// Signal behavior (Claude CLI is Node.js):
//   - SIGINT (Ctrl+C): ✅ Works - Node.js has built-in handler for graceful exit
//   - SIGTERM:         ❌ Ignored - No default handler in Node.js CLI apps
//   - SIGKILL:         ✅ Works - Kernel-level force kill (last resort)
//
// Shutdown sequence:
//  1. Cancel context (signals goroutines to stop)
//  2. Close stdin (signals EOF to Claude CLI)
//  3. Send SIGINT (graceful shutdown request)
//  4. Wait up to 3 seconds for exit
//  5. Send SIGKILL if still running (force kill)
//  6. Close stdout/stderr pipes
//  7. Wait for reader goroutines (up to 2 seconds)
//
// Used by: SDK mode sessions (UI mode)
func (t *SubprocessCLITransport) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	t.mu.Unlock()

	// Cancel context to signal all goroutines
	if t.cancel != nil {
		t.cancel()
	}

	// Close stdin first to signal EOF
	if t.stdin != nil {
		t.stdin.Close()
	}

	// Gracefully terminate process
	if t.cmd != nil && t.cmd.Process != nil {
		// Send SIGINT first (Claude CLI responds to SIGINT but not SIGTERM)
		if err := t.cmd.Process.Signal(syscall.SIGINT); err == nil {
			// Wait briefly for graceful exit
			processDone := make(chan struct{})
			go func() {
				t.cmd.Wait()
				close(processDone)
			}()

			select {
			case <-processDone:
				// Process exited gracefully
			case <-time.After(5 * time.Second):
				// Force kill after timeout
				log.Warn().Int("pid", t.cmd.Process.Pid).Msg("process didn't exit gracefully, sending SIGKILL")
				t.cmd.Process.Kill()
			}
		} else {
			// Signal failed - process likely already dead
			t.cmd.Process.Kill()
		}
	}

	// Close stdout/stderr to unblock readers
	// This forces scanner.Scan() to return immediately with EOF
	if t.stdout != nil {
		t.stdout.Close()
	}
	if t.stderr != nil {
		t.stderr.Close()
	}

	// Wait for all goroutines to finish with timeout
	// Readers may be blocked on I/O even after process termination
	wgDone := make(chan struct{})
	go func() {
		t.wg.Wait()
		close(wgDone)
	}()

	select {
	case <-wgDone:
		// All goroutines finished cleanly
	case <-time.After(2 * time.Second):
		log.Warn().Msg("transport goroutines did not finish in time, proceeding with close")
	}

	t.mu.Lock()
	t.connected = false
	t.mu.Unlock()

	log.Debug().Msg("Claude CLI transport closed")

	return nil
}

// IsConnected returns whether the transport is currently connected
func (t *SubprocessCLITransport) IsConnected() bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.connected && !t.closed
}

// SignalShutdown marks the transport as shutting down.
// Call this early in shutdown sequence so process exit errors are expected.
func (t *SubprocessCLITransport) SignalShutdown() {
	t.shuttingDown.Store(true)
}
