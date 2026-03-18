// Package acptest provides behavioral tests for ACP (Agent Client Protocol)
// agent binaries. These tests launch real agent processes and verify their
// behavior against documented expectations.
//
// These are integration tests — they require:
//   - claude-agent-acp binary installed (npm install -g @zed-industries/claude-agent-acp)
//   - ANTHROPIC_API_KEY environment variable (or MLD_LLM_ANTHROPIC_KEY)
//   - Network access to Anthropic API
//
// Run with: go test -v -tags=acptest ./agentsdk/acptest/ -timeout 5m
//
// Results are logged in detail and can be used to update the ACP migration
// design doc (tech-design/claude-code/acp.md) when the protocol changes.
//
// The test suite verifies:
//   - Connection lifecycle (initialize, session, prompt, close)
//   - Streaming behavior (message chunks, thought chunks, tool calls)
//   - Permission flow (request, approve, deny, always-allow)
//   - Session management (create, load/resume)
//   - Interruption (cancel mid-prompt)
//   - File I/O callbacks (read, write)
//   - Terminal callbacks (create, output, kill)
//   - Error handling (invalid requests, process crash)
package acptest
