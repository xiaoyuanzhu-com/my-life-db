package api

import "github.com/xiaoyuanzhu-com/my-life-db/agentsdk"

// SessionParams configures a new agent session. Used by both the REST API
// (user-initiated) and the agent runner (auto-triggered). Gateway models are
// derived internally by AgentManager from AgentType — callers don't pass them.
type SessionParams struct {
	AgentType      string // "claude_code" or "codex"
	WorkingDir     string
	Title          string
	Message        string // initial prompt; empty = no prompt sent
	PermissionMode string // e.g. "bypassPermissions"; empty = default
	DefaultModel   string // default model to set via ACP (from AGENT_MODELS)
	Source         string // "user" or "auto"
	AgentName      string // agent folder name (auto-run only)
	TriggerKind    string // event type that fired the session, e.g. "cron.tick", "file.created" (auto-run only)
	TriggerData    string // JSON-encoded hooks.Payload.Data (auto-run only)
	StorageID string // optional; when empty, agent_manager mints one
}

// SessionHandle is returned by AgentManager.CreateSession so the caller can
// manage the session lifecycle (e.g. close after completion for auto-run).
type SessionHandle struct {
	ID           string
	AcpSession   agentsdk.Session
	SessionState *agentsdk.SessionState
	// PromptDone is closed when the initial prompt completes.
	// Nil if no message was provided.
	PromptDone <-chan struct{}
	StorageID string
}
