# Seamless Reconnect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate full message re-renders on WebSocket reconnect by making user message UUIDs stable across server restarts and replacing clear-and-rebuild with merge-by-UUID.

**Architecture:** Fix the root cause (user messages get different UUIDs in synthetic broadcast vs JSONL) by threading a single UUID through the SDK chain to Claude CLI's stdin. Then replace the frontend's clear-on-reconnect with a UUID-based merge that skips existing messages and appends only new ones.

**Tech Stack:** Go backend (session.go, claude.go, SDK client/query), React frontend (chat-interface.tsx), WebSocket protocol

---

### Task 1: Thread UUID through SDK — `query.go`

**Files:**
- Modify: `backend/claude/sdk/query.go:730-752`

**Step 1: Add uuid parameter to SendUserMessage**

Add an optional `uuid` parameter. When provided, include it in the JSON payload sent to Claude CLI's stdin.

```go
// SendUserMessage sends a user message to Claude.
// If uuid is non-empty, it is included in the payload so Claude CLI persists
// the same UUID to JSONL — ensuring deduplication stability across restarts.
func (q *Query) SendUserMessage(content string, sessionID string, uuid string) error {
	if sessionID == "" {
		sessionID = "default"
	}

	message := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": content,
		},
		"parent_tool_use_id": nil,
		"session_id":         sessionID,
	}
	if uuid != "" {
		message["uuid"] = uuid
	}

	msgJSON, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("failed to marshal user message: %w", err)
	}

	return q.transport.Write(string(msgJSON) + "\n")
}
```

**Step 2: Update all callers of SendUserMessage**

Search all usages:

```bash
grep -rn 'SendUserMessage(' backend/claude/sdk/
```

Update each caller to pass `""` as the third arg (preserving existing behavior).

**Step 3: Build**

```bash
cd backend && go build ./...
```

Expected: compiles cleanly.

**Step 4: Commit**

```bash
git add backend/claude/sdk/query.go
git commit -m "feat(sdk): thread UUID through SendUserMessage to Claude CLI stdin

When a UUID is provided, include it in the user message JSON payload
sent to Claude CLI's stdin. Claude CLI will persist this UUID to JSONL,
ensuring UUID stability across server restarts."
```

---

### Task 2: Thread UUID through SDK — `client.go`

**Files:**
- Modify: `backend/claude/sdk/client.go:147-169`

**Step 1: Add SendMessageWithUUID method**

Add a new method that accepts a UUID and threads it through to `SendUserMessage`:

```go
// SendMessageWithUUID sends a user message with a specific UUID.
// The UUID is passed through to Claude CLI's stdin so it persists to JSONL,
// ensuring the synthetic broadcast UUID matches the JSONL UUID.
func (c *ClaudeSDKClient) SendMessageWithUUID(content string, uuid string) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return ErrNotConnected
	}

	return c.query.SendUserMessage(content, "", uuid)
}
```

**Step 2: Update existing SendMessage and SendMessageWithSession to pass empty UUID**

```go
func (c *ClaudeSDKClient) SendMessage(content string) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return ErrNotConnected
	}

	return c.query.SendUserMessage(content, "", "")
}

func (c *ClaudeSDKClient) SendMessageWithSession(content string, sessionID string) error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.query == nil {
		return ErrNotConnected
	}

	return c.query.SendUserMessage(content, sessionID, "")
}
```

**Step 3: Build**

```bash
cd backend && go build ./...
```

Expected: compiles cleanly.

**Step 4: Commit**

```bash
git add backend/claude/sdk/client.go
git commit -m "feat(sdk): add SendMessageWithUUID to ClaudeSDKClient

Allows callers to specify a UUID that gets passed through to Claude CLI's
stdin, ensuring the JSONL UUID matches the broadcast UUID."
```

---

### Task 3: Thread UUID through session layer — `session.go`

**Files:**
- Modify: `backend/claude/session.go:507-521`

**Step 1: Add SendInputUIWithUUID method**

Keep the existing `SendInputUI` for backward compatibility, add the UUID variant:

```go
// SendInputUIWithUUID sends a user message to Claude via the SDK client with a
// specific UUID. The UUID is passed to Claude CLI's stdin so it persists to JSONL
// with the same UUID used in the synthetic broadcast — ensuring dedup stability.
func (s *Session) SendInputUIWithUUID(content string, msgUUID string) error {
	if err := s.EnsureActivated(); err != nil {
		return fmt.Errorf("failed to activate session: %w", err)
	}

	client := s.getSDKClient()
	if client == nil {
		return fmt.Errorf("session not active (no SDK client)")
	}

	return client.SendMessageWithUUID(content, msgUUID)
}
```

**Step 2: Build**

```bash
cd backend && go build ./...
```

**Step 3: Commit**

```bash
git add backend/claude/session.go
git commit -m "feat(session): add SendInputUIWithUUID for stable user message UUIDs"
```

---

### Task 4: Use single UUID in API handler — `claude.go`

**Files:**
- Modify: `backend/api/claude.go:616-648`

**Step 1: Generate UUID once, pass to both SendInputUI and synthetic broadcast**

Replace the current code (lines 616-648):

```go
case "user_message":
	// Generate UUID ONCE — used for both Claude CLI stdin and synthetic broadcast.
	// Claude CLI respects the UUID in stdin JSON and persists it to JSONL,
	// so the synthetic broadcast UUID = JSONL UUID = stable across restarts.
	msgUUID := uuid.New().String()

	// SendInputUIWithUUID passes the UUID to Claude CLI's stdin
	if err := session.SendInputUIWithUUID(inMsg.Content, msgUUID); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to send UI message")
		errMsg := map[string]interface{}{
			"type":  "error",
			"error": "Failed to send message to session",
		}
		if msgBytes, _ := json.Marshal(errMsg); msgBytes != nil {
			conn.Write(ctx, websocket.MessageText, msgBytes)
		}
		break
	}

	// Broadcast synthetic user message with the SAME UUID
	syntheticMsg := map[string]interface{}{
		"type":      "user",
		"uuid":      msgUUID,
		"timestamp": time.Now().UnixMilli(),
		"sessionId": sessionID,
		"message": map[string]interface{}{
			"role": "user",
			"content": []map[string]interface{}{
				{"type": "text", "text": inMsg.Content},
			},
		},
	}
	if msgBytes, err := json.Marshal(syntheticMsg); err == nil {
		session.BroadcastUIMessage(msgBytes)
	}
```

**Step 2: Build**

```bash
cd backend && go build ./...
```

**Step 3: Commit**

```bash
git add backend/api/claude.go
git commit -m "fix(api): use single UUID for synthetic broadcast and Claude CLI stdin

Previously, the synthetic user message used uuid.New() while Claude CLI
generated its own UUID for the same message in JSONL. On server restart,
the client had UUID-A but JSONL loaded UUID-B, causing dedup failure and
duplicate user messages. Now both use the same UUID."
```

---

### Task 5: Frontend — replace clear-on-reconnect with merge-by-UUID

**Files:**
- Modify: `frontend/app/components/claude/chat/chat-interface.tsx`

This is the core frontend change.

**Step 1: Remove pendingReconnectClearRef declaration**

Remove line 154 (the ref declaration) and its comments (lines 150-154):

```typescript
  // DELETE these lines:
  // Deferred reconnect clear: when true, rawMessages will be cleared on the next
  // incoming message (inside handleMessage) rather than immediately in the effect.
  // This avoids a flash of empty content — React 18 batches the clear and the first
  // new message into a single render, so the UI goes straight from old → new.
  const pendingReconnectClearRef = useRef(false)
```

**Step 2: Remove deferred clear in handleMessage**

Remove lines 168-174 in `handleMessage`:

```typescript
  // DELETE these lines:
      if (pendingReconnectClearRef.current) {
        pendingReconnectClearRef.current = false
        setRawMessages([])
      }
```

The existing UUID-based dedup at lines 413-421 already handles merge correctly:

```typescript
      setRawMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.uuid === sessionMsg.uuid)
        if (existingIndex >= 0) {
          const updated = [...prev]
          updated[existingIndex] = sessionMsg
          return updated
        }
        return [...prev, sessionMsg]
      })
```

On reconnect, this naturally:
- Skips messages that already exist (existingIndex >= 0 → updates in place, React sees same data → no re-render)
- Appends truly new messages

**Step 3: Modify reconnect effect — remove the clear flag**

Replace the reconnect effect (lines 739-768). Remove `pendingReconnectClearRef.current = true`, keep all other ephemeral state resets:

```typescript
  useEffect(() => {
    if (ws.connectionStatus === 'connected') {
      if (wasConnectedRef.current) {
        // RECONNECTION: keep rawMessages intact — incoming burst messages
        // will merge by UUID (existing = skip, new = append). No clear needed
        // because user message UUIDs are now stable across server restarts
        // (same UUID passed to both synthetic broadcast and Claude CLI stdin).
        setHasSeenInit(false)
        setOptimisticMessage(null)
        setTurnInProgress(false)
        setActiveTodos([])
        setProgressMessage(null)
        setStreamingText('')
        setStreamingThinking('')
        streamingBufferRef.current = []
        thinkingBufferRef.current = []
        streamingCompleteRef.current = false
        // Reset pagination — session_info will set the correct page
        setLowestLoadedPage(0)
        setIsLoadingHistory(false)
        initialLoadCompleteRef.current = false
        hasRefreshedRef.current = false
        permissionModeSyncedRef.current = false
        if (initialLoadTimerRef.current) {
          clearTimeout(initialLoadTimerRef.current)
          initialLoadTimerRef.current = null
        }
      }
      wasConnectedRef.current = true
    }
  }, [ws.connectionStatus])
```

**Step 4: Remove pendingReconnectClearRef from session change effect**

Remove `pendingReconnectClearRef.current = false` from the session change effect (around line 666).

**Step 5: Build frontend**

```bash
cd frontend && npm run build
```

Expected: compiles cleanly.

**Step 6: Commit**

```bash
git add frontend/app/components/claude/chat/chat-interface.tsx
git commit -m "feat(frontend): replace clear-on-reconnect with merge-by-UUID

On reconnect, keep existing rawMessages and dedup incoming burst by UUID.
Messages that already exist are skipped (no re-render). Only truly new
messages are appended.

This eliminates the visible full re-render on network blips, visibility
changes, and server reconnects. Made possible by the backend fix that
ensures synthetic user message UUIDs match JSONL UUIDs."
```

---

### Task 6: Manual testing

**Step 1: Test network blip (merge mode)**

1. Open a session with messages in the UI
2. Open browser DevTools → Network → find the WebSocket connection
3. Close the WebSocket (right-click → Close)
4. Observe: messages stay in place, no flash, no scroll jump
5. WebSocket reconnects, burst arrives, messages merge silently

**Step 2: Test visibility change**

1. Open a session with messages
2. Switch to another app (or another browser tab)
3. Wait a few seconds
4. Switch back
5. Observe: no flash, no re-render. Messages stay exactly as they were.

**Step 3: Test server restart**

1. Open a session with messages
2. Restart the Go backend server
3. Wait for WebSocket to reconnect
4. Observe: messages merge seamlessly (UUIDs now match across restart)

**Step 4: Test normal operation (no regression)**

1. Open a session
2. Send a message — optimistic message appears, then synthetic confirms
3. Claude responds with streaming
4. Send another message
5. Scroll up to load history
6. Everything works as before

---

### Task 7: Update design doc

**Files:**
- Modify: `docs/plans/2026-02-28-seamless-reconnect-design.md` — mark as implemented

**Step 1: Add "Status: Implemented" to the design doc header**

**Step 2: Commit**

```bash
git add docs/plans/2026-02-28-seamless-reconnect-design.md
git commit -m "docs: mark seamless reconnect design as implemented"
```
