# Claude Code Web UI - Production Readiness Gaps

This document identifies gaps in the Claude Code web UI implementation (Phase 1) that must be addressed before production deployment.

**Analysis Date:** 2026-01-19
**Implementation Commit:** c04c7ab

---

## 🔴 Critical Security Issues

### 1. Missing Authentication on Claude Endpoints

**Location:** `backend/api/routes.go:88-96`

The Claude API endpoints are registered without authentication middleware:

```go
// Claude Code routes - NO AUTH MIDDLEWARE
api.GET("/claude/sessions", h.ListClaudeSessions)
api.POST("/claude/sessions", h.CreateClaudeSession)
api.GET("/claude/sessions/:id", h.GetClaudeSession)
api.PATCH("/claude/sessions/:id", h.UpdateClaudeSession)
api.DELETE("/claude/sessions/:id", h.DeleteClaudeSession)
```

**Risk:** Any unauthenticated user can create/access Claude sessions, spawn processes, and potentially execute arbitrary commands.

**Remediation:** Add authentication middleware to the Claude routes group.

---

### 2. Insecure WebSocket Origin Check

**Location:** `backend/api/claude.go:149-151`

```go
conn, err := websocket.Accept(w, c.Request, &websocket.AcceptOptions{
    InsecureSkipVerify: true, // Skip origin check
})
```

**Risk:** Cross-Site WebSocket Hijacking (CSWSH) attacks are possible. Malicious websites can connect to WebSocket endpoints if the user has an authenticated session.

**Remediation:** Implement proper origin validation or use a CSRF-token-based handshake.

---

### 3. Path Traversal Vulnerability

**Location:** `backend/claude/manager.go:52-56`

```go
if workingDir == "" {
    workingDir = config.Get().UserDataDir
}
// No validation - user could pass "../../../etc" or "/etc/passwd"
```

**Risk:** Users can spawn Claude processes in arbitrary directories, potentially accessing sensitive system files.

**Remediation:** Validate `workingDir` is within allowed directories (e.g., `USER_DATA_DIR`).

---

### 4. No Rate Limiting

Session creation has no rate limiting beyond the global 10-session cap.

**Risk:** DoS via rapid session creation/deletion cycles that exhaust server resources.

**Remediation:** Add rate limiting per IP/user for session operations.

---

## 🔴 Missing Backend Functionality

### 5. Chat WebSocket Endpoint Not Implemented

**Location:** `frontend/app/components/claude/chat/chat-interface.tsx:51-52`

The chat interface connects to a non-existent endpoint:

```typescript
const wsUrl = `${protocol}//${window.location.host}/api/claude/sessions/${sessionId}/chat`
```

But `routes.go:96` only registers the terminal WebSocket:

```go
r.GET("/api/claude/sessions/:id/ws", h.ClaudeWebSocket)  // Terminal only!
```

**Impact:** The entire Chat UI mode is non-functional - WebSocket connection will fail.

**Remediation:** Either:
1. Implement the `/chat` WebSocket endpoint with JSON message protocol
2. Or remove the Chat UI mode until it's ready

---

## 🟠 Memory & Resource Leaks

### 6. Unbounded Session Backlog

**Location:** `backend/claude/session.go:74-77`

```go
func (s *Session) Broadcast(data []byte) {
    s.backlogMu.Lock()
    s.backlog = append(s.backlog, data...)  // Grows forever!
    s.backlogMu.Unlock()
}
```

**Risk:** Memory exhaustion for long-running sessions. A verbose session could accumulate gigabytes of backlog data.

**Remediation:** Implement a circular buffer or size limit (e.g., keep last 1MB of backlog).

---

### 7. Goroutines Never Cleaned Up

**Location:** `backend/claude/manager.go:35, 90, 93`

```go
go m.cleanupWorker()    // Never stops - no context cancellation
go m.readPTY(session)   // No context cancellation
go m.monitorProcess(session)
```

The `cleanupWorker` runs forever with no shutdown mechanism. PTY readers have no graceful cancellation.

**Remediation:** Pass `context.Context` to all goroutines and cancel on shutdown.

---

### 8. Manager Not Integrated with Server Shutdown

**Location:** `backend/main.go`

The `claudeManager` is a global singleton initialized via `api.InitClaudeManager()` but there's no `Shutdown()` method called during graceful server shutdown, leaving orphaned `claude` processes.

**Remediation:**
1. Add `Shutdown(ctx)` method to Manager
2. Call it from `server.Shutdown()`

---

## 🟠 Missing Error Handling

### 9. Silent Frontend Errors

**Location:** `frontend/app/routes/claude.tsx:115-118, 140-142`

```typescript
} catch (error) {
    console.error('Failed to load sessions:', error)
    // No user feedback, no retry UI
}
```

Users see no indication when operations fail.

**Remediation:** Add toast notifications or error state UI for failed operations.

---

### 10. PTY Write Errors Not Propagated

**Location:** `backend/api/claude.go:213-217`

```go
if _, err := session.PTY.Write(msg); err != nil {
    log.Error().Err(err).Str("sessionId", sessionID).Msg("PTY write failed")
    conn.Close(websocket.StatusInternalError, "PTY write error")
    break
}
```

The client gets disconnected with no explanation of why.

**Remediation:** Send error message to client before closing connection.

---

## 🟡 Zero Test Coverage

### 11. No Backend Tests

No `*_test.go` files exist in `backend/claude/` directory.

**Tests needed:**
- Session CRUD operations
- WebSocket connection handling
- Process lifecycle management
- Concurrent client handling
- Error conditions

---

### 12. No Frontend Tests

No `.test.tsx` or `.spec.tsx` files exist for the 21 Claude components.

**Tests needed:**
- Component rendering
- WebSocket message handling
- Tool visualization rendering
- Permission modal interactions
- Mobile responsiveness

---

## 🟡 Configuration & Scalability Issues

### 13. Hard-coded Limits

**Location:** `backend/claude/manager.go:20`

```go
const MaxSessions = 10  // Not configurable
```

**Remediation:** Make configurable via environment variable `CLAUDE_MAX_SESSIONS`.

---

### 14. No Per-User Session Limits

Current limit is global (10 total). A single user could consume all sessions.

**Remediation:** Track sessions per user and enforce per-user limits.

---

### 15. No Session Timeout/Idle Cleanup

Sessions remain active indefinitely until manually deleted or process dies.

**Remediation:** Add configurable idle timeout (e.g., kill session after 30min of no WebSocket activity).

---

### 16. Ephemeral Sessions (No Persistence)

Sessions are stored in-memory only. Server restart loses all active sessions.

**Remediation:**
- For Phase 1: Document this limitation
- For Phase 2: Consider persisting session metadata to database

---

## 🟡 Missing Production Features

### 17. No Audit Logging

No logging of who created sessions, what commands were executed, or access patterns.

**Remediation:** Add audit log entries for session lifecycle events.

---

### 18. No Metrics/Observability

No Prometheus metrics, no health checks specific to Claude sessions.

**Metrics needed:**
- `claude_sessions_total` (gauge)
- `claude_session_duration_seconds` (histogram)
- `claude_websocket_connections` (gauge)
- `claude_pty_errors_total` (counter)

---

### 19. No Terminal Resize Support

**Location:** `backend/api/claude.go:208-212`

Only binary messages are handled:

```go
if msgType != websocket.MessageBinary {
    continue  // Text messages (like resize commands) are ignored
}
```

The frontend has no mechanism to send resize commands to the PTY. Terminal is fixed at startup dimensions.

**Remediation:** Handle text messages for resize commands, use `pty.Setsize()`.

---

### 20. No Session History/Export

No way to export session transcripts or persist conversation history.

**Remediation:** Phase 2 feature - add export API endpoint.

---

## Summary Table

| ID | Category | Issue | Severity | Effort |
|----|----------|-------|----------|--------|
| 1 | Security | No auth on Claude endpoints | 🔴 Critical | Low |
| 2 | Security | Insecure WebSocket origin | 🔴 Critical | Low |
| 3 | Security | Path traversal in workingDir | 🔴 Critical | Low |
| 4 | Security | No rate limiting | 🔴 High | Medium |
| 5 | Backend | Chat WebSocket not implemented | 🔴 Critical | High |
| 6 | Resources | Unbounded backlog memory | 🟠 High | Medium |
| 7 | Resources | Goroutine leaks | 🟠 High | Medium |
| 8 | Resources | No graceful shutdown | 🟠 High | Medium |
| 9 | UX | Silent frontend errors | 🟠 Medium | Low |
| 10 | UX | PTY errors not propagated | 🟠 Medium | Low |
| 11 | Quality | No backend tests | 🟡 High | High |
| 12 | Quality | No frontend tests | 🟡 High | High |
| 13 | Config | Hard-coded limits | 🟡 Medium | Low |
| 14 | Config | No per-user limits | 🟡 Medium | Medium |
| 15 | Config | No session timeout | 🟡 Medium | Medium |
| 16 | Config | No persistence | 🟡 Medium | High |
| 17 | Feature | No audit logging | 🟡 Medium | Medium |
| 18 | Feature | No metrics | 🟡 Medium | Medium |
| 19 | Feature | No terminal resize | 🟡 Medium | Medium |
| 20 | Feature | No session export | 🟡 Low | Medium |

---

## Recommended Priority Order

### Must-Fix Before Any Deployment

1. **Add authentication middleware** to Claude endpoints
2. **Implement proper WebSocket origin validation**
3. **Validate workingDir** against allowed paths
4. **Implement the Chat WebSocket endpoint** or remove Chat UI mode

### Should-Fix Before Production

5. **Add backlog size limit** (e.g., keep last 1MB)
6. **Integrate ClaudeManager shutdown** with server lifecycle
7. **Add context cancellation** to goroutines
8. **Add basic tests** for session CRUD and WebSocket handling

### Nice-to-Have

9. **Make MaxSessions configurable** via environment variable
10. **Add session idle timeout**
11. **Add rate limiting** on session creation
12. **Add user-facing error notifications**
