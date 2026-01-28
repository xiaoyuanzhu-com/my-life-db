# Claude Chat Interface Robustness Plan

This document tracks all identified issues in the Claude chat interface and provides detailed implementation plans for each fix.

**Created**: 2026-01-28
**Status**: Planning

---

## Issue Tracking

| ID | Severity | Status | Title |
|----|----------|--------|-------|
| C1 | Critical | TODO | AskUserQuestion never populated |
| C2 | Critical | TODO | Permission animation blocks response |
| C3 | Critical | TODO | Memory leak in permission tracking |
| C4 | Critical | TODO | Session switch during pending permission |
| H1 | High | TODO | No WebSocket heartbeat/ping-pong |
| H2 | High | TODO | No visibility change handling |
| H3 | High | TODO | Infinite retry without user control |
| H4 | High | TODO | Mobile swipe direction inverted |
| H5 | High | TODO | No error boundary |
| H6 | High | TODO | Initial connection failure hidden |
| M1 | Medium | TODO | No draft debouncing |
| M2 | Medium | TODO | URL replace breaks browser history |
| M3 | Medium | TODO | Keyboard shortcuts capture all input |
| M4 | Medium | TODO | No message length validation |
| M5 | Medium | TODO | No session deletion confirmation |
| M6 | Medium | TODO | Error banners auto-dismiss too fast |
| M7 | Medium | TODO | Initial load detection timing too short |
| L1 | Low | TODO | No rate limiting on message send |
| L2 | Low | TODO | No virtualization for large history |
| L3 | Low | TODO | Generic tool preview fallback |
| L4 | Low | TODO | Optimistic message lost on fast switch |
| L5 | Low | TODO | State updates during render (antipattern) |

---

## Critical Issues

### C1: AskUserQuestion Never Populated

**File**: `frontend/app/components/claude/chat/chat-interface.tsx`
**Lines**: 55-56, 87-254, 373-377, 454-460

**Problem**:
The `pendingQuestion` state is defined but never set from incoming WebSocket messages. The message handler processes many message types but doesn't handle `ask_user_question` messages from Claude.

```tsx
// State exists
const [pendingQuestion, setPendingQuestion] = useState<UserQuestion | null>(null)

// Handler exists
const handleQuestionAnswer = useCallback((answers: Record<string, string | string[]>) => {
  console.log('Question answers:', answers)
  setPendingQuestion(null)
}, [])

// Component renders when pendingQuestion is set
{pendingQuestion && (
  <AskUserQuestion ... />
)}

// BUT: Nothing in handleMessage() ever calls setPendingQuestion()
```

**Impact**: When Claude uses AskUserQuestion tool, the question is silently ignored. Users never see the question and Claude never gets an answer.

**Solution**:
Add handling for `ask_user_question` message type in `handleMessage`:

```tsx
// In handleMessage, add:
if (msg.type === 'ask_user_question' || msg.type === 'control_request') {
  const request = msg.request as { subtype?: string } | undefined
  if (request?.subtype === 'ask_user_question') {
    const questionData = msg.data as UserQuestion | undefined
    if (questionData) {
      setPendingQuestion(questionData)
    }
    return
  }
  // ... existing permission handling
}
```

**Also needed**:
1. Send answer back via WebSocket when user responds
2. Update `handleQuestionAnswer` to build and send response payload
3. Check backend message format for `ask_user_question` to ensure correct parsing

**Files to modify**:
- `frontend/app/components/claude/chat/chat-interface.tsx`
- Possibly `frontend/app/types/claude.ts` if message type needs updating

---

### C2: Permission Animation Blocks Response

**File**: `frontend/app/components/claude/chat/permission-card.tsx`
**Lines**: 59-74

**Problem**:
The permission decision is only sent when `onAnimationEnd` fires. This is fragile:

```tsx
const handleDecision = useCallback((decision: PermissionDecision) => {
  if (isDismissing) return
  setIsDismissing(true)
  setPendingDecision(decision)  // Store decision, don't send yet
}, [isDismissing])

const handleAnimationEnd = () => {
  if (isDismissing && pendingDecision) {
    onDecision(pendingDecision)  // Only sent here!
  }
}
```

**Failure scenarios**:
1. CSS animations disabled (accessibility setting `prefers-reduced-motion`)
2. Animation interrupted (rapid user interaction)
3. CSS not loaded / hydration issues
4. Browser doesn't fire animationend for some reason

**Impact**: Permission request hangs forever. Claude is blocked waiting for response.

**Solution**:
Send decision immediately, use animation only for visual feedback:

```tsx
const handleDecision = useCallback((decision: PermissionDecision) => {
  if (isDismissing) return
  setIsDismissing(true)

  // Send immediately
  onDecision(decision)
}, [isDismissing, onDecision])

const handleAnimationEnd = () => {
  // Animation is purely cosmetic now
  // Parent will have already processed the decision
}
```

**Alternative**: Add timeout fallback:

```tsx
useEffect(() => {
  if (isDismissing && pendingDecision) {
    // Fallback: send after 300ms if animationend doesn't fire
    const timeout = setTimeout(() => {
      onDecision(pendingDecision)
    }, 300)
    return () => clearTimeout(timeout)
  }
}, [isDismissing, pendingDecision, onDecision])
```

**Recommendation**: Use the first approach (immediate send). Animation is nice-to-have, not a gate.

**Files to modify**:
- `frontend/app/components/claude/chat/permission-card.tsx`

---

### C3: Memory Leak in Permission Tracking

**File**: `frontend/app/components/claude/chat/hooks/use-permissions.ts`
**Lines**: 34-36

**Problem**:
The `controlRequests` and `controlResponses` collections grow unbounded:

```tsx
const [controlRequests, setControlRequests] = useState<Map<string, PermissionRequest>>(new Map())
const [controlResponses, setControlResponses] = useState<Set<string>>(new Set())
```

Only `reset()` clears them, which is called on session switch. Within a session:
- Every permission request adds to the Map
- Every response adds to the Set
- Entries are never removed

**Impact**: Long sessions with many permissions (e.g., allowing hundreds of file reads) could accumulate thousands of entries.

**Solution**:
Clean up responded requests periodically or immediately:

```tsx
const handleControlResponse = useCallback((data: { request_id: string }) => {
  console.log('[usePermissions] Received control_response:', data.request_id)

  // Add to responses
  setControlResponses((prev) => {
    const next = new Set(prev)
    next.add(data.request_id)
    return next
  })

  // Clean up the request since it's been responded to
  setControlRequests((prev) => {
    const next = new Map(prev)
    next.delete(data.request_id)
    return next
  })
}, [])
```

**Also update pendingPermissions logic** since we're now removing responded requests:

```tsx
// Simpler: pending = all remaining requests (since responded ones are deleted)
const pendingPermissions = useMemo(() => {
  return Array.from(controlRequests.values())
}, [controlRequests])
```

**Files to modify**:
- `frontend/app/components/claude/chat/hooks/use-permissions.ts`

---

### C4: Session Switch During Pending Permission

**File**: `frontend/app/components/claude/chat/chat-interface.tsx`
**Lines**: 302-316

**Problem**:
When user switches sessions while permission is pending:

```tsx
// Reset state when sessionId changes
useEffect(() => {
  setRawMessages([])
  setOptimisticMessage(null)
  setActiveTodos([])
  setError(null)
  setProgressMessage(null)
  permissions.reset()  // Clears permission state
  // ...
}, [sessionId])
```

This clears the permission UI, but:
1. The old WebSocket may still be open briefly
2. Backend is waiting for a response that will never come
3. Claude session could be blocked indefinitely

**Solution**:
Send a "deny" response for all pending permissions before switching:

```tsx
useEffect(() => {
  // Cleanup function runs before new session effect
  return () => {
    // Deny all pending permissions before switching
    for (const request of permissions.pendingPermissions) {
      const response = permissions.buildPermissionResponse(request.requestId, 'deny')
      if (response) {
        // Best effort - WebSocket might already be closing
        ws.sendMessage(response).catch(() => {
          console.log('[ChatInterface] Could not send deny for pending permission on session switch')
        })
      }
    }
  }
}, [sessionId])

// Then in the next effect, reset as before
useEffect(() => {
  permissions.reset()
  // ... other resets
}, [sessionId])
```

**Alternative**: Have backend timeout pending permissions after N seconds.

**Files to modify**:
- `frontend/app/components/claude/chat/chat-interface.tsx`
- Consider backend changes for timeout fallback

---

## High Priority Issues

### H1: No WebSocket Heartbeat/Ping-Pong

**File**: `frontend/app/components/claude/chat/hooks/use-session-websocket.ts`

**Problem**:
No keepalive mechanism. Many environments kill idle WebSocket connections:
- AWS ALB: 60s idle timeout by default
- Nginx: 60s proxy_read_timeout
- Cloudflare: 100s
- Corporate proxies: often 30s

Without heartbeat, connection dies silently. Only detected when next message fails.

**Solution**:
Add ping/pong mechanism:

```tsx
// In ensureConnected, after ws.onopen:
let pingInterval: ReturnType<typeof setInterval> | null = null

ws.onopen = () => {
  // ... existing code ...

  // Start heartbeat
  pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }))
    }
  }, 30000) // Every 30 seconds
}

ws.onclose = () => {
  if (pingInterval) {
    clearInterval(pingInterval)
    pingInterval = null
  }
  // ... existing code ...
}
```

**Backend requirement**: Backend must respond to `ping` with `pong` (or just ignore it - the send itself keeps connection alive for most proxies).

**Files to modify**:
- `frontend/app/components/claude/chat/hooks/use-session-websocket.ts`
- `backend/claude/websocket.go` (if pong response needed)

---

### H2: No Visibility Change Handling

**File**: `frontend/app/components/claude/chat/hooks/use-session-websocket.ts`

**Problem**:
When tab is backgrounded:
- Browser may throttle or close WebSocket
- Chrome deprioritizes background tabs
- Mobile browsers aggressively kill background connections

The terminal component handles this (`terminal.tsx:380-395`), but the chat WebSocket doesn't.

**Solution**:
Add visibility change listener:

```tsx
useEffect(() => {
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      // Tab became visible - check connection
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        console.log('[useSessionWebSocket] Tab visible, reconnecting...')
        ensureConnected()
      }
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange)
  return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
}, [ensureConnected])
```

**Files to modify**:
- `frontend/app/components/claude/chat/hooks/use-session-websocket.ts`

---

### H3: Infinite Retry Without User Control

**File**: `frontend/app/components/claude/chat/hooks/use-session-websocket.ts`
**Lines**: 82-84

**Problem**:
```tsx
const baseDelay = 1000
const maxDelay = 60000 // 1 minute max
// Retries forever with exponential backoff
```

If server is down or unreachable, users are stuck in "connecting" state forever with no escape.

**Solution**:
Add manual retry capability and max attempt limit:

```tsx
export interface UseSessionWebSocketResult {
  connectionStatus: ConnectionStatus
  hasConnected: boolean
  sendMessage: (payload: unknown) => Promise<void>
  sendRaw: (json: string) => Promise<void>
  retryConnection: () => void  // New: manual retry
  giveUp: () => void           // New: stop trying
}

// Add state
const [hasGivenUp, setHasGivenUp] = useState(false)

// In tryConnect:
if (hasGivenUp) {
  setConnectionStatus('disconnected')
  return
}

// After N attempts, ask user:
if (attempts >= 5 && !wasConnected) {
  setConnectionStatus('disconnected')
  // UI can show "Connection failed. Retry?" with button
  return
}
```

**UI update needed**: Show "Retry" button when status is 'disconnected'.

**Files to modify**:
- `frontend/app/components/claude/chat/hooks/use-session-websocket.ts`
- `frontend/app/components/claude/chat/connection-status-banner.tsx`

---

### H4: Mobile Swipe Direction Inverted

**File**: `frontend/app/routes/claude.tsx`
**Lines**: 67-98

**Problem**:
```tsx
const handleTouchStart = (e: TouchEvent) => {
  // Only track if touch starts from left edge (within 50px)
  if (e.touches[0].clientX < 50) {
    touchStartX.current = e.touches[0].clientX
  }
}

const handleTouchEnd = () => {
  // Swipe was leftward (start X > end X)
  if (touchStartX.current > 0 && touchStartX.current - touchEndX.current > 100) {
    navigate(-1)
  }
}
```

This triggers "go back" on a LEFTWARD swipe from the left edge. But:
- iOS convention: swipe RIGHT from left edge = go back
- A leftward swipe from the left edge means swiping off-screen (impossible)

**Solution**:
Fix the direction check:

```tsx
const handleTouchEnd = () => {
  // Swipe was rightward (end X > start X) - iOS back gesture
  if (touchStartX.current > 0 && touchEndX.current - touchStartX.current > 100) {
    navigate(-1)
  }
}
```

**Files to modify**:
- `frontend/app/routes/claude.tsx`

---

### H5: No Error Boundary

**File**: `frontend/app/components/claude/chat/chat-interface.tsx`

**Problem**:
No error boundary wrapping message rendering. A malformed message (unexpected structure, null where object expected, etc.) causes React to crash the entire component tree.

**Solution**:
Add error boundary component:

```tsx
// New file: frontend/app/components/claude/chat/message-error-boundary.tsx
import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class MessageErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[MessageErrorBoundary] Render error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-4 text-destructive text-sm">
          Failed to render message.
          <button onClick={() => this.setState({ hasError: false })}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
```

Wrap in `MessageList` or individual `MessageBlock`:

```tsx
<MessageErrorBoundary>
  <MessageBlock message={msg} ... />
</MessageErrorBoundary>
```

**Files to modify**:
- Create `frontend/app/components/claude/chat/message-error-boundary.tsx`
- `frontend/app/components/claude/chat/message-list.tsx` or `session-messages.tsx`

---

### H6: Initial Connection Failure Hidden

**File**: `frontend/app/components/claude/chat/chat-interface.tsx`
**Lines**: 289-290

**Problem**:
```tsx
const effectiveConnectionStatus: ConnectionStatus =
  ws.hasConnected && ws.connectionStatus !== 'connected' ? ws.connectionStatus : 'connected'
```

This only shows the connection banner after first successful connection. If initial connection fails, user sees nothing while retries happen.

**Solution**:
Show "connecting" status on initial load:

```tsx
// Show banner during initial connection attempt OR after reconnection loss
const effectiveConnectionStatus: ConnectionStatus =
  ws.connectionStatus !== 'connected' ? ws.connectionStatus : 'connected'

// Optionally, differentiate "initial connecting" from "reconnecting":
const isInitialConnection = !ws.hasConnected && ws.connectionStatus === 'connecting'
```

Update `ConnectionStatusBanner` to handle initial connection state differently if desired.

**Files to modify**:
- `frontend/app/components/claude/chat/chat-interface.tsx`
- Optionally `frontend/app/components/claude/chat/connection-status-banner.tsx`

---

## Medium Priority Issues

### M1: No Draft Debouncing

**File**: `frontend/app/components/claude/chat/hooks/use-draft-persistence.ts`
**Lines**: 56-77

**Problem**:
```tsx
useEffect(() => {
  // Runs on EVERY content change
  localStorage.setItem(key, content)
}, [content, sessionId])
```

Fast typing = many localStorage writes = potential jank on slow devices.

**Solution**:
Debounce the write:

```tsx
useEffect(() => {
  const timer = setTimeout(() => {
    try {
      const key = getStorageKey(sessionId)
      if (content) {
        localStorage.setItem(key, content)
      } else {
        localStorage.removeItem(key)
      }
    } catch (error) {
      console.error('[useDraftPersistence] Failed to save draft:', error)
    }
  }, 300) // 300ms debounce

  return () => clearTimeout(timer)
}, [content, sessionId])
```

**Files to modify**:
- `frontend/app/components/claude/chat/hooks/use-draft-persistence.ts`

---

### M2: URL Replace Breaks Browser History

**File**: `frontend/app/routes/claude.tsx`
**Line**: 51

**Problem**:
```tsx
navigate(`/claude/${activeSessionId}`, { replace: true })
```

Using `replace: true` means each session change replaces history instead of pushing. Users can't use back/forward to navigate between previously viewed sessions.

**Solution**:
Use push navigation (remove `replace: true`), but be careful about infinite loops:

```tsx
useEffect(() => {
  if (activeSessionId && activeSessionId !== urlSessionId) {
    navigate(`/claude/${activeSessionId}`)  // No replace
  } else if (!activeSessionId && urlSessionId) {
    navigate('/claude', { replace: true })  // Keep replace for clearing
  }
}, [activeSessionId, urlSessionId, navigate])
```

**Files to modify**:
- `frontend/app/routes/claude.tsx`

---

### M3: Keyboard Shortcuts Capture All Input

**File**: `frontend/app/components/claude/chat/permission-card.tsx`
**Lines**: 77-97

**Problem**:
```tsx
useEffect(() => {
  const handleKeyDown = (e: globalThis.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleDecision('deny')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      handleDecision('allow')
    }
  }
  window.addEventListener('keydown', handleKeyDown)
  // ...
}, [isFirst, isDismissing, handleDecision])
```

No check for focus. If user is typing in textarea and hits Enter, it triggers permission allow instead of newline.

**Solution**:
Check if focus is on an input element:

```tsx
const handleKeyDown = (e: globalThis.KeyboardEvent) => {
  // Don't capture if focus is in an input
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
    return
  }

  if (isDismissing) return
  // ... rest of handler
}
```

**Files to modify**:
- `frontend/app/components/claude/chat/permission-card.tsx`

---

### M4: No Message Length Validation

**File**: `frontend/app/components/claude/chat/chat-input.tsx`

**Problem**:
No max length on user input. Users could paste megabytes of text causing:
- UI performance issues
- Backend rejection
- Memory problems

**Solution**:
Add max length constant and validation:

```tsx
const MAX_MESSAGE_LENGTH = 100000 // 100KB reasonable limit

const handleSend = useCallback(() => {
  const trimmed = draft.content.trim()
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    setError(`Message too long (${trimmed.length} chars, max ${MAX_MESSAGE_LENGTH})`)
    return
  }
  if (trimmed && !disabled && !hasPermission) {
    // ... send
  }
}, [draft, disabled, hasPermission, onSend])
```

Also show character count near limit:

```tsx
{draft.content.length > MAX_MESSAGE_LENGTH * 0.8 && (
  <span className={cn(
    "text-xs",
    draft.content.length > MAX_MESSAGE_LENGTH ? "text-destructive" : "text-muted-foreground"
  )}>
    {draft.content.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}
  </span>
)}
```

**Files to modify**:
- `frontend/app/components/claude/chat/chat-input.tsx`
- `frontend/app/components/claude/chat/chat-input-field.tsx`

---

### M5: No Session Deletion Confirmation

**File**: `frontend/app/routes/claude.tsx`
**Lines**: 166-182

**Problem**:
```tsx
const deleteSession = async (sessionId: string) => {
  const response = await api.delete(`/api/claude/sessions/${sessionId}`)
  // Immediately deletes, no confirmation
}
```

**Solution**:
Add confirmation dialog:

```tsx
const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

const requestDeleteSession = (sessionId: string) => {
  setDeleteConfirm(sessionId)
}

const confirmDeleteSession = async () => {
  if (!deleteConfirm) return
  await deleteSession(deleteConfirm)
  setDeleteConfirm(null)
}

// In render:
<AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete session?</AlertDialogTitle>
      <AlertDialogDescription>
        This will permanently delete the session and all its messages.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={confirmDeleteSession}>Delete</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**Files to modify**:
- `frontend/app/routes/claude.tsx`
- May need to add shadcn AlertDialog component

---

### M6: Error Banners Auto-Dismiss Too Fast

**File**: `frontend/app/components/claude/chat/chat-interface.tsx`
**Lines**: 106-108, 344-347

**Problem**:
```tsx
setError((msg.error as string) || 'An error occurred')
setTimeout(() => setError(null), 5000)  // 5 seconds
// Other places use 3000 (3 seconds)
```

Important errors may not be read in time.

**Solution**:
- Increase timeout to 8-10 seconds
- Add dismiss button for manual clearing
- Consider not auto-dismissing critical errors

```tsx
// Keep error until manually dismissed for critical errors
if (isCriticalError(msg.error)) {
  setError({ message: msg.error, dismissable: true })
} else {
  setError({ message: msg.error, dismissable: false })
  setTimeout(() => setError(null), 8000)
}
```

**Files to modify**:
- `frontend/app/components/claude/chat/chat-interface.tsx`

---

### M7: Initial Load Detection Timing Too Short

**File**: `frontend/app/components/claude/chat/chat-interface.tsx`
**Lines**: 97-100

**Problem**:
```tsx
initialLoadTimerRef.current = setTimeout(() => {
  initialLoadCompleteRef.current = true
}, 500)  // 500ms
```

On slow connections, messages arriving every 400ms would continuously reset the timer, never completing initial load detection.

**Solution**:
Use message count or explicit "history complete" message:

```tsx
// Option 1: Count-based heuristic
const messageCountRef = useRef(0)

// In handleMessage:
messageCountRef.current++
if (messageCountRef.current > 10) {
  // Likely past initial burst, increase timeout
  if (initialLoadTimerRef.current) clearTimeout(initialLoadTimerRef.current)
  initialLoadTimerRef.current = setTimeout(() => {
    initialLoadCompleteRef.current = true
  }, 1000)
}

// Option 2: Backend sends explicit "history_complete" message
if (msg.type === 'history_complete') {
  initialLoadCompleteRef.current = true
}
```

**Files to modify**:
- `frontend/app/components/claude/chat/chat-interface.tsx`
- Optionally backend WebSocket handler

---

## Low Priority Issues

### L1: No Rate Limiting on Message Send

**File**: `frontend/app/components/claude/chat/chat-input.tsx`

**Problem**: Users could spam Enter rapidly.

**Solution**:
```tsx
const lastSendRef = useRef<number>(0)
const MIN_SEND_INTERVAL = 500 // 500ms between sends

const handleSend = useCallback(() => {
  const now = Date.now()
  if (now - lastSendRef.current < MIN_SEND_INTERVAL) {
    return // Too fast, ignore
  }
  lastSendRef.current = now
  // ... rest of send logic
}, [])
```

---

### L2: No Virtualization for Large History

**File**: `frontend/app/components/claude/chat/message-list.tsx`

**Problem**: All messages rendered at once.

**Solution**: Use `react-window` or `@tanstack/react-virtual`:

```tsx
import { useVirtualizer } from '@tanstack/react-virtual'

const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 100, // Estimate row height
})
```

This is a larger refactor - may want to track as separate task.

---

### L3: Generic Tool Preview Fallback

**File**: `frontend/app/components/claude/chat/permission-card.tsx`

**Problem**: Unknown tools show raw JSON dump.

**Solution**: Truncate and format better:

```tsx
default: {
  const str = JSON.stringify(input, null, 2)
  if (str.length > 500) {
    return str.slice(0, 500) + '\n... (truncated)'
  }
  return str
}
```

---

### L4: Optimistic Message Lost on Fast Switch

**File**: `frontend/app/components/claude/chat/chat-interface.tsx`

**Problem**: Message sent, session switched immediately, optimistic message disappears.

**Solution**: Show toast notification that message was sent:

```tsx
const sendMessage = useCallback(async (content: string) => {
  setOptimisticMessage(content)
  try {
    await ws.sendMessage({ type: 'user_message', content })
    toast.success('Message sent')  // Persist even if session switches
  } catch {
    // ... error handling
  }
}, [ws])
```

---

### L5: State Updates During Render (Antipattern)

**File**: `frontend/app/components/claude/chat/hooks/use-reconnection-feedback.ts`
**Lines**: 30-36, 50-53, 56-61

**Problem**:
```tsx
// This is during render, not in an effect
if (sessionChanged) {
  if (showReconnected || isDismissing) {
    setShowReconnected(false)  // State update during render!
    setIsDismissing(false)
  }
}
```

While this works in React 18, it's an antipattern that could cause issues.

**Solution**: Move to useEffect:

```tsx
useEffect(() => {
  if (prevSessionIdRef.current !== sessionId) {
    setShowReconnected(false)
    setIsDismissing(false)
  }
  prevSessionIdRef.current = sessionId
}, [sessionId])
```

---

## Implementation Order Recommendation

### Phase 1: Critical Fixes (Do First)
1. **C2**: Permission animation blocks response (quick fix, high impact)
2. **C1**: AskUserQuestion integration (enables key feature)
3. **C3**: Memory leak in permissions (simple fix)
4. **C4**: Session switch permission cleanup

### Phase 2: Connection Reliability
5. **H1**: WebSocket heartbeat
6. **H2**: Visibility change handling
7. **H6**: Initial connection failure feedback
8. **H3**: Manual retry option

### Phase 3: UX Polish
9. **H5**: Error boundary
10. **H4**: Mobile swipe direction
11. **M3**: Keyboard shortcut focus check
12. **M5**: Delete confirmation

### Phase 4: Performance & Edge Cases
13. **M1**: Draft debouncing
14. **M4**: Message length validation
15. **M6**: Error banner timing
16. **M2**: Browser history
17. **M7**: Initial load detection

### Phase 5: Nice to Have
18. **L1-L5**: Low priority improvements

---

## Testing Checklist

For each fix, verify:

- [ ] Happy path works
- [ ] Edge cases handled
- [ ] No regressions in related features
- [ ] Works on mobile
- [ ] Works with slow network (use Chrome DevTools throttling)
- [ ] Works when rapidly switching sessions
- [ ] Memory usage stable over time
- [ ] No console errors/warnings
