# Claude Code Integration

This document covers the Claude Code integration - the embedded Claude CLI sessions with web UI.

## Core Principle: Proxy Only

**We proxy Claude CLI messages faithfully. We do not invent new message types.**

The backend acts as a transparent relay between Claude CLI and the browser. When Claude outputs a message, we parse it for rendering but preserve the original JSON. This ensures:
- Forward compatibility with new Claude versions
- No data loss through re-serialization
- Consistent behavior with native Claude CLI

**DO**: Parse messages for UI rendering, preserve raw JSON for storage/forwarding
**DON'T**: Create custom message types, modify message content, drop unknown fields

## Architecture Overview

```
Browser (React)
    ↕ WebSocket
Backend (Go)
    ↕ SDK Client (subprocess wrapper)
Claude CLI
```

### Two Operation Modes

| Mode | Transport | Use Case |
|------|-----------|----------|
| **UI Mode** (default) | SDK (structured JSON) | Chat interface with structured messages |
| **CLI Mode** | PTY (raw terminal) | Terminal emulator with xterm.js |

**UI Mode uses the SDK** - it's no longer direct PTY-based stdin/stdout.

## Key Components

| Location | Purpose |
|----------|---------|
| `backend/claude/manager.go` | Session pool, lifecycle management, index cache |
| `backend/claude/session.go` | Individual session state, client management |
| `backend/claude/sdk/client.go` | SDK wrapper for subprocess communication |
| `backend/claude/sdk/query.go` | Control protocol, permission callbacks |
| `backend/claude/sdk/message_parser.go` | Message type parsing |
| `backend/claude/session_reader.go` | Session history loading from JSONL |
| `backend/claude/session_index_cache.go` | Session index with pagination, deduplication |
| `backend/claude/session_watcher.go` | Filesystem watching for new sessions |
| `backend/claude/models/` | 13+ message type definitions |
| `frontend/app/components/claude/` | UI components |

## Session Structure

```go
type Session struct {
    ID           string
    ProcessID    int
    WorkingDir   string
    CreatedAt    time.Time
    LastActivity time.Time
    Status       string       // "archived", "active", "dead"
    Title        string
    Mode         SessionMode  // "cli" or "ui"

    // SDK-based UI mode
    sdkClient    *sdk.ClaudeSDKClient
    sdkCtx       context.Context
    sdkCancel    context.CancelFunc

    // Message caching (UI mode)
    cachedMessages [][]byte           // All messages for new clients
    seenUUIDs      map[string]bool    // Deduplication by UUID

    // Permission handling (SDK mode)
    pendingSDKPermissions map[string]*pendingPermission
    alwaysAllowedTools    map[string]bool

    // CLI mode (PTY-based, legacy)
    PTY       *os.File
    broadcast chan []byte
    backlog   []byte
}
```

## Session Lifecycle

### Creation

```go
// Manager creates session
session := manager.CreateSessionWithID(workingDir, title, resumeID, mode)
// Session struct exists but Claude CLI not started yet (lazy activation)
```

### Activation (Lazy)

Sessions are activated when:
1. First WebSocket client connects
2. First message is sent

```go
func (s *Session) EnsureActivated() error {
    if s.activated {
        return nil
    }
    // For UI mode, uses SDK
    return s.activateFn()  // Calls createSessionWithSDK or createSessionWithLegacy
}
```

### SDK vs Legacy Activation

```go
// UI Mode (default) - uses SDK
func (m *Manager) createSessionWithSDK(s *Session) error {
    sdkClient, err := sdk.NewClaudeSDKClient(sdk.Options{
        WorkingDir: s.WorkingDir,
        // Permission callback bridges async WebSocket flow
        CanUseTool: m.CreatePermissionCallback(s),
    })
    s.sdkClient = sdkClient
    // ...
}

// CLI Mode - uses PTY
func (m *Manager) createSessionWithLegacy(s *Session) error {
    // Creates PTY, spawns claude CLI directly
    // Raw terminal output to xterm.js
}
```

## Message Flow

### Outgoing (Browser → Claude)

```
User types message
    ↓
WebSocket sends: { type: "text", content: "..." }
    ↓
Backend Session.SendInputUI()
    ↓
SDK client writes to Claude stdin (formatted query)
    ↓
Claude processes
```

### Incoming (Claude → Browser)

```
Claude writes to stdout (JSONL)
    ↓
SDK client reads, parses message type
    ↓
Message cached in session (for new clients)
    ↓
Deduplication by UUID (merge JSONL history with live)
    ↓
Broadcast to all WebSocket clients
    ↓
Frontend renders based on type
```

## Message Types

Claude outputs JSONL (one JSON per line). Key types:

| Type | Description | Frontend Handling |
|------|-------------|-------------------|
| `user` | User's input | Show in chat |
| `assistant` | Claude's response | Render text, thinking, tool calls |
| `system` | System events | Handle subtypes (init, status) |
| `result` | Completion info | Show cost, duration |
| `control_request` | Permission request | Show permission modal |

### Message Type Registry

The `backend/claude/models/` package defines 13+ typed messages:

- `UserSessionMessage`
- `AssistantSessionMessage`
- `SystemInitMessage`
- `SystemSessionMessage`
- `ResultSessionMessage`
- `ProgressSessionMessage`
- `SummarySessionMessage`
- `CustomTitleSessionMessage`
- `TagSessionMessage`
- `AgentNameSessionMessage`
- `QueueOperationSessionMessage`
- `FileHistorySnapshotSessionMessage`
- `UnknownSessionMessage` (fallback)

Each implements `SessionMessageI` interface with `HasUsefulContent()` for filtering.

### Message Preservation

When loading session history, we preserve raw JSON:

```go
type messageWithRaw struct {
    Type    string
    RawJSON []byte  // Original JSON for serialization
}

func (m *messageWithRaw) MarshalJSON() ([]byte, error) {
    return m.RawJSON, nil  // Return original, not re-marshaled
}
```

## Permission Handling

Claude requests tool permissions via `control_request` messages. This creates a sync→async bridge:

```
Claude CLI (sync)              Backend                    Browser (async)
      |                           |                            |
      |-- control_request ------->|                            |
      |   (blocks waiting)        |-- broadcast --------------->|
      |                           |                            |
      |                           |    User sees permission UI |
      |                           |    User clicks Allow/Deny  |
      |                           |                            |
      |                           |<-- control_response -------|
      |<-- response --------------|                            |
      |   (unblocks)              |                            |
```

### Permission Response Structure

```go
type PermissionResponse struct {
    Behavior    string  // "allow" or "deny"
    Message     string  // Optional denial message
    AlwaysAllow bool    // Remember for this session
    ToolName    string  // Tool name for always-allow tracking
}
```

### SendControlResponse

```go
func (s *Session) SendControlResponse(
    requestID string,
    subtype string,
    behavior string,   // "allow" or "deny"
    message string,
    toolName string,
    alwaysAllow bool,
) {
    // Find pending permission
    s.pendingSDKPermissionsMu.Lock()
    pending, exists := s.pendingSDKPermissions[requestID]
    if !exists {
        s.pendingSDKPermissionsMu.Unlock()
        return
    }
    delete(s.pendingSDKPermissions, requestID)
    s.pendingSDKPermissionsMu.Unlock()

    // Track "always allow"
    if alwaysAllow && behavior == "allow" {
        s.alwaysAllowedToolsMu.Lock()
        s.alwaysAllowedTools[toolName] = true
        s.alwaysAllowedToolsMu.Unlock()

        // Auto-approve other pending requests for same tool
        s.autoApprovePendingForTool(toolName)
    }

    // Send response to blocked callback
    pending.ch <- PermissionResponse{
        Behavior:    behavior,
        Message:     message,
        AlwaysAllow: alwaysAllow,
        ToolName:    toolName,
    }
}
```

### Permission Callback Pattern

```go
func (m *Manager) CreatePermissionCallback(s *Session) func(string, string) bool {
    return func(toolName, toolInput string) bool {
        // Check if already always-allowed
        s.alwaysAllowedToolsMu.RLock()
        if s.alwaysAllowedTools[toolName] {
            s.alwaysAllowedToolsMu.RUnlock()
            return true
        }
        s.alwaysAllowedToolsMu.RUnlock()

        // Create pending permission request
        requestID := generateRequestID()
        responseChan := make(chan PermissionResponse, 1)

        s.pendingSDKPermissionsMu.Lock()
        s.pendingSDKPermissions[requestID] = &pendingPermission{
            toolName:  toolName,
            requestID: requestID,
            ch:        responseChan,
        }
        s.pendingSDKPermissionsMu.Unlock()

        // Broadcast control_request to all clients
        s.broadcastControlRequest(requestID, toolName, toolInput)

        // Block waiting for response
        response := <-responseChan
        return response.Behavior == "allow"
    }
}
```

## Session Index Cache

The `SessionIndexCache` provides efficient session listing:

```go
type SessionIndexCache struct {
    sessions     []SessionIndexEntry
    mu           sync.RWMutex
    initialized  bool

    // Deduplication by FirstUserMessageUUID
    seenUUIDs    map[string]bool
}

type SessionIndexEntry struct {
    SessionID          string
    SessionFile        string
    CreatedAt          time.Time
    UpdatedAt          time.Time
    FirstPrompt        string    // Lazily loaded
    FirstUserMessageUUID string  // For deduplication
}
```

### Features

- **Lazy initialization**: Scans `~/.claude/projects/` on first access
- **Deduplication**: Related sessions (same FirstUserMessageUUID) are collapsed
- **Pagination**: Cursor-based seeking for large session lists
- **Enrichment**: Lazily loads FirstPrompt from JSONL files
- **File watching**: fsnotify updates cache on new sessions

## WebSocket Protocol

### Client → Server

```typescript
{ type: "text", content: string }              // User message
{ type: "permission_response",
  requestId: string,
  subtype: string,
  behavior: "allow" | "deny",
  message?: string,
  toolName: string,
  alwaysAllow: boolean }                       // Permission decision
{ type: "question_answer", questionId, answers }  // AskUserQuestion response
{ type: "interrupt" }                          // Stop current operation
{ type: "set_model", model: string }           // Change model
```

### Server → Client

```typescript
// Raw Claude messages (forwarded as-is)
{ type: "user", ... }
{ type: "assistant", ... }
{ type: "system", ... }
{ type: "result", ... }

// Control messages
{ type: "control_request", data: { request_id, tool_name, tool_input } }
{ type: "todo_update", data: { todos } }
{ type: "connected" }
{ type: "error", error: string }
```

## Session History

Sessions are stored by Claude CLI in `~/.claude/projects/[project]/sessions.jsonl`.

### Loading History

```go
func ReadSessionHistoryRaw(sessionID string) ([]SessionMessageI, error) {
    // Find JSONL file
    sessionFile := findSessionFile(sessionID)

    // Read line by line
    scanner := bufio.NewScanner(file)
    for scanner.Scan() {
        // Parse each line, preserving raw JSON
        msg := parseTypedMessage(scanner.Bytes())
        messages = append(messages, msg)
    }

    return messages, nil
}
```

### UUID Deduplication

When merging JSONL history with live stdout:

```go
func (s *Session) AddMessage(rawJSON []byte) {
    // Extract UUID from message
    uuid := extractUUID(rawJSON)

    s.cacheMu.Lock()
    defer s.cacheMu.Unlock()

    // Skip if already seen
    if s.seenUUIDs[uuid] {
        return
    }
    s.seenUUIDs[uuid] = true
    s.cachedMessages = append(s.cachedMessages, rawJSON)
}
```

## Common Modifications

### Adding a New WebSocket Message Type

1. **Don't create new Claude message types** - proxy only
2. If you need app-specific messages (not from Claude):
   - Add type to `frontend/app/types/claude.ts`
   - Handle in `backend/api/claude.go` WebSocket handler
   - Keep it clearly separate from Claude messages

### Adding UI for a New Claude Feature

1. Check if Claude already outputs the relevant message type
2. Add TypeScript types if needed
3. Add rendering logic in message components
4. Test with real Claude output

### Modifying Permission Behavior

1. Permission logic lives in `session.go` (`SendControlResponse`)
2. Frontend UI in `permission-card.tsx`
3. SDK callback in `manager.go` (`CreatePermissionCallback`)

### Debugging Message Flow

1. Enable debug logging in SDK client
2. Check raw WebSocket messages in browser DevTools
3. Compare with Claude CLI direct output (`claude --output-format stream-json`)

## Files to Modify

| Task | Files |
|------|-------|
| New message rendering | `frontend/app/components/claude/chat/message-*.tsx` |
| Permission UI | `frontend/app/components/claude/chat/permission-card.tsx` |
| WebSocket handling | `backend/api/claude.go`, `frontend/.../use-session-websocket.ts` |
| Message parsing | `backend/claude/sdk/message_parser.go` |
| Session management | `backend/claude/manager.go`, `session.go` |
| Session index | `backend/claude/session_index_cache.go` |
| Message types | `backend/claude/models/*.go` |

## Session List SSE Notifications

The session list auto-refreshes when session titles change.

### How It Works

```
Claude CLI writes JSONL
    ↓
SessionIndexCache (fsnotify) — only notifies if DisplayTitle changed
    ↓
SSE "claude-session-updated" event
    ↓
Frontend calls loadSessions()
```

**Key point**: The backend filters out most file writes. Only title changes trigger notifications, so no debouncing needed on frontend.

### Files

- `backend/claude/session_index_cache.go` — compares DisplayTitle, calls callback
- `backend/notifications/service.go` — `NotifyClaudeSessionUpdated()`
- `frontend/app/hooks/use-notifications.ts` — `useClaudeSessionNotifications` hook
- `frontend/app/routes/claude.tsx` — uses hook to call `loadSessions()`

## Testing

- Use real Claude CLI sessions for integration testing
- Check message round-trip: Claude → Backend → Frontend → stored history
- Verify unknown message types are preserved (forward compatibility)
- Test permission flow: request → UI → response → Claude continues
- Test always-allow: subsequent requests for same tool auto-approve
- Test session list refresh: start a new session, verify title appears in sidebar after Claude generates summary
