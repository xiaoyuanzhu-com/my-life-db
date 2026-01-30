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
    ↕ PTY/Subprocess
Claude CLI
```

### Key Components

| Location | Purpose |
|----------|---------|
| `backend/claude/manager.go` | Session pool, lifecycle management |
| `backend/claude/session.go` | Individual session state, client management |
| `backend/claude/sdk/client.go` | SDK wrapper for subprocess communication |
| `backend/claude/sdk/query.go` | Control protocol, permission handling |
| `backend/claude/sdk/message_parser.go` | Message type parsing |
| `backend/claude/session_reader.go` | Session history loading |
| `frontend/app/components/claude/` | UI components |
| `frontend/app/types/claude.ts` | TypeScript type definitions |

## Session Lifecycle

### Creation

```go
// Manager creates session with lazy activation
session := manager.CreateSessionWithID(workingDir, title, resumeID, mode)
// Session exists but Claude CLI not started yet
```

### Activation (Lazy)

```go
// First WebSocket client triggers activation
session.EnsureActivated()
// Now Claude CLI subprocess is running
```

### Modes

- **CLI Mode** (`ModeCLI`): PTY-based, raw terminal output for xterm.js
- **UI Mode** (`ModeUI`): JSON streaming, structured messages for chat interface

Most modifications should focus on UI mode.

## Message Flow

### Outgoing (Browser → Claude)

```
User types message
    ↓
WebSocket sends: { type: "text", content: "..." }
    ↓
Backend Session.SendInputUI()
    ↓
SDK client writes to Claude stdin
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
| `system` | System events | Handle subtypes (init, status, etc.) |
| `result` | Completion info | Show cost, duration |
| `control_request` | Permission request | Show permission modal |

### Parsing Pattern

```go
// backend/claude/sdk/message_parser.go
func parseMessage(data []byte) (Message, error) {
    var base struct{ Type string }
    json.Unmarshal(data, &base)

    switch base.Type {
    case "user":
        return parseUserMessage(data)
    case "assistant":
        return parseAssistantMessage(data)
    // ...
    default:
        // CRITICAL: Preserve unknown types
        return RawMessage{Type: base.Type, Raw: data}, nil
    }
}
```

**The `default` case is critical** - unknown message types must be preserved as `RawMessage` for forward compatibility.

### Message Preservation

When loading session history, we preserve raw JSON:

```go
// backend/claude/session_reader.go
type messageWithRaw struct {
    // Parsed fields for querying
    Type string
    // Original JSON for serialization
    RawJSON []byte
}

func (m *messageWithRaw) MarshalJSON() ([]byte, error) {
    return m.RawJSON, nil  // Return original, not re-marshaled
}
```

This prevents data loss when messages have fields we don't explicitly model.

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

### Backend Implementation

```go
// session.go
type Session struct {
    // Pending permission requests awaiting browser response
    pendingSDKPermissions map[string]chan PermissionResponse

    // Tools user has "always allowed" for this session
    alwaysAllowedTools map[string]bool
}

func (s *Session) SendControlResponse(requestID string, response PermissionResponse) {
    if ch, ok := s.pendingSDKPermissions[requestID]; ok {
        ch <- response
        delete(s.pendingSDKPermissions, requestID)
    }

    // Track "always allow" choices
    if response.Decision == "allowSession" {
        s.alwaysAllowedTools[response.ToolName] = true
    }
}
```

### Frontend Implementation

```typescript
// Permission card shows tool name, input preview
// User choices: Allow, Deny, Always Allow (this session)

const handlePermission = (decision: 'allow' | 'deny' | 'allowSession') => {
    ws.send({
        type: 'permission_response',
        requestId: request.request_id,
        decision
    })
}
```

## WebSocket Protocol

### Client → Server

```typescript
{ type: "text", content: string }              // User message
{ type: "permission_response", requestId, decision }  // Permission decision
{ type: "question_answer", questionId, answers }      // AskUserQuestion response
```

### Server → Client

```typescript
{ type: "text_delta", data: { delta, messageId } }    // Streaming text
{ type: "tool_use", data: { id, name, parameters } }  // Tool invocation
{ type: "tool_result", data: { toolCallId, result } } // Tool completion
{ type: "control_request", data: { request_id, request } }  // Permission request
{ type: "todo_update", data: { todos } }              // Todo list update
{ type: "connected" }                                  // Connection established
{ type: "error", error: string }                       // Error message
```

## Session History

Sessions are stored by Claude CLI in `~/.claude/projects/[project]/sessions.jsonl`.

### Loading History

```go
// backend/claude/session_reader.go
func ReadSessionHistoryRaw(sessionID string) ([]Message, error) {
    // Read JSONL file
    // Parse each line, preserving raw JSON
    // Return typed messages with RawJSON field
}
```

### Index Cache

The Manager maintains a `SessionIndexCache` for listing sessions without parsing full history:

```go
type SessionIndexCache struct {
    // Lazily loads and caches session metadata
    // Watches filesystem for new sessions
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
3. SDK callback in `sdk/client.go` (`CanUseTool`)

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

## Testing

- Use real Claude CLI sessions for integration testing
- Check message round-trip: Claude → Backend → Frontend → stored history
- Verify unknown message types are preserved (forward compatibility)
- Test permission flow: request → UI → response → Claude continues
