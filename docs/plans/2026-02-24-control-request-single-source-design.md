# Control Request Single Source of Truth — End-to-End

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix double-popup bug for `AskUserQuestion` by aligning control_request/response with the single-source-of-truth principle (D5). Claude's original `control_request` flows through to the frontend unchanged — no re-creation, one request_id namespace.

**Root cause:** Today the backend intercepts the SDK's `can_use_tool` callback, creates a *new* `control_request` with a `sdk-perm-xxx` ID, and broadcasts it. The frontend also detects `AskUserQuestion` tool_use blocks in `rawMessages` via a `useEffect` scan. Two writers, different IDs, two popups.

**Fix:** Remove both writers. Let Claude's original `control_request` enter `rawMessages`. Derive pending permissions/questions via `useMemo`.

**Scope:** Phase 1 only — `control_request` + `control_response`. Phase 2 (`progress`, `todo_update`, `error`) is a separate plan.

**Tech Stack:** Go (backend SDK + session), TypeScript/React (frontend).

---

## Architecture

Three layers change:

```
Claude CLI  ──stdout──▶  SDK (query.go)  ──msg channel──▶  Backend (session.go)  ──WebSocket──▶  Frontend
                             │                                     │
                        Fast-path auto-allow               Holds "always allow" state
                        Forward if not auto                Calls SDK.RespondToPermission()
```

**Key principle:** A `control_request` from Claude is either handled (auto-allow) or forwarded. Never re-created.

**Resolution heuristic (frontend `useMemo`):** A `control_request` is resolved if:
- A `control_response` with the same `request_id` exists in `rawMessages`, OR
- A `result` message exists after it (turn completed without needing approval)

---

## Task 1: SDK — Add `PermissionResultAsk` + `RespondToPermission()`

**Files:**
- Modify: `backend/claude/sdk/types.go`
- Modify: `backend/claude/sdk/query.go`

### Step 1: Add `PermissionResultAsk` type

In `types.go`, add after `PermissionResultDeny`:

```go
// PermissionResultAsk indicates the SDK should forward the control_request
// to the message channel for external handling (e.g., UI prompt).
type PermissionResultAsk struct{}

func (PermissionResultAsk) isPermissionResult() {}
```

### Step 2: Add pending permission state to Query

In `query.go`, add to the `Query` struct:

```go
// Forwarded permissions waiting for external response
pendingPermissions   map[string]chan PermissionResult
pendingPermissionsMu sync.Mutex
```

Initialize in `NewQuery()`:

```go
pendingPermissions: make(map[string]chan PermissionResult),
```

### Step 3: Update `handleControlRequest()` for `can_use_tool`

Current behavior: always calls `canUseTool` callback, sends response from return value.

New behavior for `can_use_tool`:

```go
case "can_use_tool":
    // Fast path: callback returns Allow or Deny
    if q.canUseTool != nil {
        result, err := q.handleCanUseTool(request)
        if err != nil {
            respErr = err
            break
        }
        // If callback returned a concrete decision, use it
        if result != nil {
            responseData = result
            break
        }
        // result == nil means PermissionResultAsk — fall through to forward
    }

    // Forward original control_request to message channel for external handling
    q.pendingPermissionsMu.Lock()
    ch := make(chan PermissionResult, 1)
    q.pendingPermissions[requestID] = ch
    q.pendingPermissionsMu.Unlock()

    // Forward the raw message
    q.forwardMessage(data)

    // Block until external response
    select {
    case result := <-ch:
        // Convert PermissionResult to response format
        responseData, respErr = q.permissionResultToResponse(result, request)
    case <-q.ctx.Done():
        respErr = q.ctx.Err()
    }

    // Cleanup
    q.pendingPermissionsMu.Lock()
    delete(q.pendingPermissions, requestID)
    q.pendingPermissionsMu.Unlock()

    // Skip the normal response-sending below — we handle it here
    // (need to restructure the function slightly)
```

Update `handleCanUseTool()` to return `nil, nil` for `PermissionResultAsk`:

```go
case PermissionResultAsk:
    return nil, nil
```

### Step 4: Add `RespondToPermission()` public method

```go
// RespondToPermission provides the permission decision for a forwarded control_request.
// Called by the backend when the frontend/user has made a decision.
func (q *Query) RespondToPermission(requestID string, result PermissionResult) error {
    q.pendingPermissionsMu.Lock()
    ch, ok := q.pendingPermissions[requestID]
    q.pendingPermissionsMu.Unlock()

    if !ok {
        return fmt.Errorf("no pending permission for request_id: %s", requestID)
    }

    select {
    case ch <- result:
        return nil
    default:
        return fmt.Errorf("permission channel full for request_id: %s", requestID)
    }
}
```

### Step 5: Expose `RespondToPermission()` on `ClaudeSDKClient`

In `client.go`, add:

```go
func (c *ClaudeSDKClient) RespondToPermission(requestID string, result PermissionResult) error {
    c.mu.RLock()
    defer c.mu.RUnlock()

    if c.query == nil {
        return ErrNotConnected
    }

    return c.query.RespondToPermission(requestID, result)
}
```

### Step 6: Add helper to convert PermissionResult to response map

In `query.go`, extract the existing conversion logic from `handleCanUseTool()` into a reusable helper:

```go
func (q *Query) permissionResultToResponse(result PermissionResult, request map[string]any) (map[string]any, error) {
    input, _ := request["input"].(map[string]any)
    switch r := result.(type) {
    case PermissionResultAllow:
        resp := map[string]any{"behavior": "allow"}
        if r.UpdatedInput != nil {
            resp["updatedInput"] = r.UpdatedInput
        } else {
            resp["updatedInput"] = input
        }
        if len(r.UpdatedPermissions) > 0 {
            resp["updatedPermissions"] = r.UpdatedPermissions
        }
        return resp, nil
    case PermissionResultDeny:
        resp := map[string]any{"behavior": "deny", "message": r.Message}
        if r.Interrupt {
            resp["interrupt"] = true
        }
        return resp, nil
    default:
        return nil, fmt.Errorf("unknown permission result type")
    }
}
```

### Step 7: Verify build

```bash
cd backend && go build ./...
```

### Step 8: Run existing tests

```bash
cd backend && go test ./claude/sdk/... -v -count=1
```

### Step 9: Commit

```bash
git add backend/claude/sdk/types.go backend/claude/sdk/query.go backend/claude/sdk/client.go
git commit -m "feat(sdk): add PermissionResultAsk + RespondToPermission for forwarded permissions"
```

---

## Task 2: Backend — Simplify `CreatePermissionCallback()` + `SendControlResponse()`

**Files:**
- Modify: `backend/claude/session.go`

### Step 1: Simplify `CreatePermissionCallback()`

Replace the current implementation. The callback now only handles fast-path auto-allow. Everything else returns `PermissionResultAsk{}`.

```go
func (s *Session) CreatePermissionCallback() sdk.CanUseToolFunc {
    return func(toolName string, input map[string]any, ctx sdk.ToolPermissionContext) (sdk.PermissionResult, error) {
        // Fast path: tool in configured allowedTools list
        if isToolAllowed(toolName, input) {
            return sdk.PermissionResultAllow{Behavior: sdk.PermissionAllow}, nil
        }

        // Fast path: tool in session "always allow" list
        s.alwaysAllowedToolsMu.RLock()
        isAlwaysAllowed := s.alwaysAllowedTools != nil && s.alwaysAllowedTools[toolName]
        s.alwaysAllowedToolsMu.RUnlock()

        if isAlwaysAllowed {
            return sdk.PermissionResultAllow{Behavior: sdk.PermissionAllow}, nil
        }

        // Not auto-allowed — tell SDK to forward the original control_request
        return sdk.PermissionResultAsk{}, nil
    }
}
```

### Step 2: Delete dead state

Remove from `Session` struct:
- `pendingSDKPermissions` map
- `pendingSDKPermissionsMu` mutex
- `pendingPermission` type
- `PermissionResponse` type (if only used here)

Remove from `BroadcastUIMessage()`:
- The `pendingPermissionCount` tracking for `control_request`/`control_response` (lines 814-832) — no longer needed since the SDK handles forwarding

### Step 3: Update `SendControlResponse()`

Replace the current implementation. Instead of routing to a channel, call the SDK:

```go
func (s *Session) SendControlResponse(requestID string, subtype string, behavior string, message string, toolName string, alwaysAllow bool, updatedInput map[string]any) error {
    // Handle "always allow"
    if alwaysAllow && behavior == "allow" && toolName != "" {
        s.alwaysAllowedToolsMu.Lock()
        if s.alwaysAllowedTools == nil {
            s.alwaysAllowedTools = make(map[string]bool)
        }
        s.alwaysAllowedTools[toolName] = true
        s.alwaysAllowedToolsMu.Unlock()
    }

    // Build SDK permission result
    var result sdk.PermissionResult
    if behavior == "allow" {
        allow := sdk.PermissionResultAllow{Behavior: sdk.PermissionAllow}
        if updatedInput != nil {
            allow.UpdatedInput = updatedInput
        }
        result = allow
    } else {
        denyMessage := message
        if denyMessage == "" {
            denyMessage = fmt.Sprintf("Permission denied by user for tool: %s", toolName)
        }
        result = sdk.PermissionResultDeny{
            Behavior:  sdk.PermissionDeny,
            Message:   denyMessage,
            Interrupt: true,
        }
    }

    // Send to SDK
    if err := s.sdkClient.RespondToPermission(requestID, result); err != nil {
        return err
    }

    // Broadcast control_response to all WebSocket clients so they can update UI
    responseMsg := fmt.Sprintf(`{"type":"control_response","request_id":%q,"behavior":%q}`,
        requestID, behavior)
    s.BroadcastUIMessage([]byte(responseMsg))

    // If "always allow", auto-approve other pending permissions for same tool
    if alwaysAllow && behavior == "allow" && toolName != "" {
        s.autoApprovePendingForTool(toolName, requestID)
    }

    return nil
}
```

### Step 4: Update `autoApprovePendingForTool()`

This now calls `sdkClient.RespondToPermission()` instead of writing to channels. The SDK maintains the pending map, so we need a way to list pending requests by tool name. Two options:

- Option A: SDK exposes `PendingPermissionIDs()` — backend filters by tool name
- Option B: Backend keeps a lightweight `requestID → toolName` map (no channels, just for lookup)

Option B is simpler — add a `pendingToolNames map[string]string` that's populated when the SDK message channel delivers a `control_request`, and cleaned up when `SendControlResponse` is called.

### Step 5: Remove §11.7 dead code

In `LoadRawMessages()` (line 488-495), remove the skip for `control_request`/`control_response`. These messages are not in JSONL in SDK mode, so the skip is a no-op. Removing it prevents confusion.

### Step 6: Verify build

```bash
cd backend && go build ./...
```

### Step 7: Run tests

```bash
cd backend && go test ./claude/... -v -count=1
```

### Step 8: Commit

```bash
git add backend/claude/session.go
git commit -m "feat(session): simplify permission flow — forward original control_request via SDK"
```

---

## Task 3: Frontend — Let control_request/response enter rawMessages, derive via useMemo

**Files:**
- Modify: `frontend/app/components/claude/chat/chat-interface.tsx`
- Modify: `frontend/app/components/claude/chat/hooks/use-permissions.ts`
- Modify: `frontend/app/types/claude.ts`

### Step 1: Remove control_request interception in `handleMessage()`

In `chat-interface.tsx`, find the `case "control_request"` block (lines 332-381). Remove it entirely. `control_request` messages will now fall through to the default path that appends to `rawMessages`.

Similarly remove the `case "control_response"` interception. Let it enter `rawMessages`.

### Step 2: Add `useMemo` derivation for pending permissions and questions

Add after the existing `rateLimitWarning` useMemo:

```typescript
const { pendingPermissions, pendingQuestions } = useMemo(() => {
  const requests = new Map<string, { msg: any; index: number }>()
  const responses = new Set<string>()
  let lastResultIndex = -1

  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i]
    if (msg.type === 'control_request') {
      requests.set(msg.request_id, { msg, index: i })
    }
    if (msg.type === 'control_response') {
      responses.add(msg.request_id)
    }
    if (msg.type === 'result') {
      lastResultIndex = i
    }
  }

  const unresolved = [...requests.entries()]
    .filter(([reqId, { index }]) =>
      !responses.has(reqId) && !(lastResultIndex > index)
    )

  const permissions: ControlRequestMsg[] = []
  const questions: UserQuestion[] = []

  for (const [reqId, { msg }] of unresolved) {
    const toolName = msg.request?.tool_name
    if (toolName === 'AskUserQuestion') {
      questions.push(toUserQuestion(msg))
    } else {
      permissions.push(msg)
    }
  }

  return { pendingPermissions: permissions, pendingQuestions: questions }
}, [rawMessages])
```

### Step 3: Add `toUserQuestion()` helper

```typescript
function toUserQuestion(msg: any): UserQuestion {
  const input = msg.request?.input || {}
  return {
    id: msg.request_id,
    toolCallId: input.tool_call_id || msg.request_id,
    questions: input.questions || [],
  }
}
```

### Step 4: Delete old state and writers

- Delete `pendingQuestions` useState
- Delete the `useEffect` historical scan (lines 639-701) that detected AskUserQuestion in rawMessages
- Delete the two guards added for the double-popup fix (lines 349-357 and 684-691)
- Delete the `control_request` handler's writes to `pendingQuestions`

### Step 5: Update `handleQuestionAnswer()` and `handleQuestionSkip()`

These currently use `pendingQuestion.id` as the `request_id`. After the change, `pendingQuestion.id` IS Claude's original `request_id` (set in `toUserQuestion`), so the response path is correct. Verify the HTTP POST to the backend sends `request_id: question.id`.

### Step 6: Delete or simplify `use-permissions.ts`

The `usePermissions` hook currently maintains its own `controlRequests` Map + `controlResponses` Set. This is now replaced by the `useMemo` derivation. Either:
- Delete the hook entirely if `pendingPermissions` from useMemo provides enough
- Or keep a thin wrapper that consumes from useMemo

### Step 7: Keep render filter in `session-messages.tsx`

`control_request` and `control_response` are in `rawMessages` for derivation but should NOT be rendered as message bubbles. Keep the existing filter at line 516:

```typescript
if (msg.type === 'control_request' || msg.type === 'control_response') return null
```

### Step 8: Verify build

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

### Step 9: Commit

```bash
git add frontend/app/components/claude/chat/chat-interface.tsx \
       frontend/app/components/claude/chat/hooks/use-permissions.ts \
       frontend/app/types/claude.ts
git commit -m "feat(frontend): derive pending permissions/questions from rawMessages via useMemo"
```

---

## Task 4: Integration test — end-to-end permission flow

### Step 1: Manual test — regular tool permission

1. Start a session, trigger a tool that requires permission (e.g., Bash)
2. Verify single permission popup appears
3. Click Allow → tool executes
4. Click "Always allow" → subsequent same-tool requests auto-approved

### Step 2: Manual test — AskUserQuestion

1. Trigger an AskUserQuestion tool_use
2. Verify single question popup appears (not two)
3. Answer the question → verify response reaches Claude
4. Verify no duplicate popups on session resume/reconnect

### Step 3: Manual test — session reconnect

1. While a permission is pending, refresh the page
2. Verify the pending permission re-appears from rawMessages (the useMemo re-derives it)
3. Answer it → verify it works

### Step 4: Run existing SDK tests

```bash
cd backend && go test ./claude/sdk/... -v -count=1
```

### Step 5: Commit any test adjustments

```bash
git add -A && git commit -m "test: update tests for new permission flow"
```

---

## Summary of deletions

| What | Where | Why |
|------|-------|-----|
| `pendingSDKPermissions` map + mutex | session.go | SDK owns pending state now |
| `pendingPermission` / `PermissionResponse` types | session.go | No longer needed |
| `sdk-perm-xxx` ID generation | session.go | Use Claude's original IDs |
| `pendingPermissionCount` tracking | session.go BroadcastUIMessage | Dead bookkeeping |
| §11.7 JSONL skip for control_request/response | session.go LoadRawMessages | Dead code (not in JSONL) |
| `pendingQuestions` useState | chat-interface.tsx | Replaced by useMemo |
| Historical detection useEffect | chat-interface.tsx | Replaced by useMemo |
| Two dedup guards | chat-interface.tsx | Root cause eliminated |
| `control_request` interception in handleMessage | chat-interface.tsx | Messages enter rawMessages now |
| `usePermissions` hook (or most of it) | use-permissions.ts | Replaced by useMemo |
