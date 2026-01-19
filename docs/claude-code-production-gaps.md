# Claude Code Web UI - Production Readiness Gaps

This document identifies gaps in the Claude Code web UI implementation (Phase 1) and tracks their resolution.

**Analysis Date:** 2026-01-19
**Implementation Commit:** c04c7ab
**Last Updated:** 2026-01-19

---

## Status Summary

| Issue | Status | Notes |
|-------|--------|-------|
| Authentication | ✅ Accepted | OAuth covers all API access |
| WebSocket Origin | ✅ Accepted | OAuth provides protection |
| Path Traversal | ✅ Accepted | Docker isolation for cloud, user-owned for self-hosted |
| Rate Limiting | ⏭️ Skipped | Not needed for Phase 1 |
| Chat WebSocket | ✅ Fixed | Basic implementation added |
| Goroutine Leaks | ✅ Fixed | Context cancellation added |
| Graceful Shutdown | ✅ Fixed | ClaudeManager.Shutdown() integrated |
| Tests | ⏭️ Deferred | Phase 2 |
| Other items | ⏭️ Deferred | Phase 2 |

---

## ✅ Fixed Items

### Chat WebSocket Endpoint

**Location:** `backend/api/claude.go:244-378`, `backend/api/routes.go:97`

Added `/api/claude/sessions/:id/chat` WebSocket endpoint that:
- Sends `connected` message on connection
- Forwards PTY output as `text_delta` messages (with `raw: true` flag)
- Accepts `user_message` type and writes to PTY
- Includes ping/pong for connection keep-alive

**Note:** This is a basic implementation that forwards raw terminal output. Future enhancements could parse Claude's output into structured messages (tool_use, permission_request, etc.).

---

### Goroutine Leaks Fixed

**Location:** `backend/claude/manager.go`

Changes:
1. Added `context.Context` and `cancel` function to Manager struct
2. Added `sync.WaitGroup` to track all goroutines
3. `cleanupWorker()` now respects context cancellation
4. `readPTY()` and `monitorProcess()` use `defer m.wg.Done()`
5. All goroutines check for shutdown signal

---

### Graceful Shutdown Implemented

**Location:** `backend/claude/manager.go:51-86`, `backend/api/claude.go:28-34`, `backend/main.go:83-86`

Changes:
1. Added `Manager.Shutdown(ctx)` method that:
   - Cancels the manager context (signals goroutines to stop)
   - Kills all active sessions and processes
   - Waits for all goroutines to finish (with timeout)
2. Added `api.ShutdownClaudeManager(ctx)` wrapper function
3. Called during server shutdown in `main.go`

---

## ⏭️ Accepted Items (No Action Needed)

### 1. Authentication

OAuth is configured at the application level and covers all API access. Claude endpoints at `/api/claude/*` are protected by the same auth mechanism as other endpoints.

### 2. WebSocket Origin Check

`InsecureSkipVerify: true` is acceptable since OAuth authentication is enforced at a higher layer.

### 3. Path Traversal in workingDir

Accepted because:
- **Cloud deployment:** Docker isolation prevents access outside container
- **Self-hosted:** User owns the machine and can access any directory anyway

---

## ⏭️ Deferred to Phase 2

The following items are documented but deferred to future phases:

| Item | Description |
|------|-------------|
| Rate Limiting | Per-user/per-IP limits on session creation |
| Unbounded Backlog | Add size limit to session backlog (circular buffer) |
| Tests | Unit tests for backend and frontend Claude components |
| Per-User Limits | Track sessions per user instead of global limit |
| Session Timeout | Idle timeout for inactive sessions |
| Audit Logging | Log session lifecycle events |
| Metrics | Prometheus metrics for observability |
| Terminal Resize | Handle PTY resize commands |
| Session Export | Export session transcripts |

---

## Original Analysis Reference

The original analysis identified 20 potential gaps. After review:
- 3 items fixed (Chat WebSocket, Goroutine Leaks, Graceful Shutdown)
- 3 items accepted (Auth, WebSocket Origin, Path Traversal)
- 1 item skipped (Rate Limiting)
- 13 items deferred to Phase 2
