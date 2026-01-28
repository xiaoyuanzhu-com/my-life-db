# Chat Components Refactor Design

Date: 2026-01-28

## Problem

`chat-interface.tsx` (574 lines) and `chat-input.tsx` (562 lines) have grown complex over time, mixing multiple concerns:

- Hard to find specific logic (WebSocket handling, permission UI, etc.)
- Changes to one feature risk breaking others due to intertwined state
- Long-term maintainability concerns

## Approach

**Hybrid refactoring**: Custom hooks for stateful logic, components for UI pieces.

**Constraint**: No changes to frontend-backend protocol (WebSocket messages, API contracts).

## Custom Hooks

### `use-session-websocket.ts`
Owns WebSocket lifecycle:
- Connection/reconnection with exponential backoff
- `connectionStatus` state (`connected` | `connecting` | `disconnected`)
- `sendMessage(payload)` function
- Exposes `onMessage` callback for parent to handle routing
- Cleanup on sessionId change

### `use-permissions.ts`
Owns permission request/response tracking:
- `controlRequests: Map<string, PermissionRequest>`
- `controlResponses: Set<string>`
- `pendingPermissions` (derived)
- `handleControlRequest(data)` — adds to map
- `handleControlResponse(data)` — adds to set
- `buildPermissionResponse(requestId, decision, request)` — returns payload for WebSocket

### `use-draft-persistence.ts`
Owns localStorage draft logic:
- `content`, `setContent`
- Auto-save on change
- `clearDraft()`, `restoreDraft()`, `getDraft()`
- Handles `pendingSend` flag for optimistic UI

### `use-reconnection-feedback.ts`
Handles "Connected." success toast timing:
- `showReconnected`, `isDismissing`
- 1.5s delay → dismiss animation

## Components

### `connection-status-banner.tsx`
Props: `status`, `isReconnected`, `isDismissing`, `onDismissed`

Pure presentational, shows reconnecting/disconnected/connected states.

### `permission-card.tsx`
Props: `request`, `onDecision`, `isFirst`, `isDismissing`

Single permission approval UI with:
- Animation state
- Keyboard shortcuts (only when `isFirst`)
- Action verb/preview text logic

### `chat-input-field.tsx`
Props: `content`, `onChange`, `onSend`, `onInterrupt`, `isWorking`, `disabled`, `placeholder`

Textarea + send/stop button + attach button. No business logic.

### `chat-input.tsx` (refactored)
Composition layer (~100-150 lines):
- Uses `useDraftPersistence` hook
- Uses `useReconnectionFeedback` hook
- Renders: `ConnectionStatusBanner` → `PermissionCard`(s) → `ChatInputField`

### `chat-interface.tsx` (refactored)
Orchestrator (~200-250 lines):
- Uses `useSessionWebSocket` hook
- Uses `usePermissions` hook
- Routes WebSocket messages to appropriate handlers
- Renders: `MessageList`, `ChatInput`, `TodoPanel`

## File Structure

```
components/claude/chat/
├── chat-interface.tsx
├── chat-input.tsx
├── chat-input-field.tsx
├── connection-status-banner.tsx
├── permission-card.tsx
├── hooks/
│   ├── use-session-websocket.ts
│   ├── use-permissions.ts
│   ├── use-draft-persistence.ts
│   └── use-reconnection-feedback.ts
```

## Data Flow

```
ChatInterface
  │
  ├── useSessionWebSocket(sessionId)
  │     → connectionStatus, sendMessage, onMessage callback
  │
  ├── usePermissions()
  │     → pendingPermissions, handleControlRequest, handleControlResponse
  │
  ├── Message routing (in onMessage):
  │     - 'control_request'  → permissions.handleControlRequest
  │     - 'control_response' → permissions.handleControlResponse
  │     - 'todo_update'      → setActiveTodos
  │     - 'progress'         → setProgressMessage
  │     - session messages   → setRawMessages
  │
  └── Renders:
        <MessageList />
        <ChatInput
          connectionStatus
          pendingPermissions
          onPermissionDecision  // uses sendMessage
          onSend                // uses sendMessage
        />
        <TodoPanel />


ChatInput
  │
  ├── useDraftPersistence(sessionId)
  │     → content, setContent, clearDraft, restoreDraft
  │
  ├── useReconnectionFeedback(connectionStatus)
  │     → showReconnected, isDismissing
  │
  └── Renders:
        <ConnectionStatusBanner />
        {pendingPermissions.map → <PermissionCard />}
        <ChatInputField />
```

## Implementation Order

1. **Extract hooks first** (no UI changes)
   - `use-reconnection-feedback.ts` — smallest
   - `use-draft-persistence.ts` — self-contained
   - `use-permissions.ts` — state tracking only
   - `use-session-websocket.ts` — largest, last

2. **Extract UI components**
   - `connection-status-banner.tsx`
   - `permission-card.tsx`
   - `chat-input-field.tsx`

3. **Refactor parent components**
   - `chat-input.tsx`
   - `chat-interface.tsx`

## Edge Cases to Preserve

| Behavior | Current Location | Keep In |
|----------|------------------|---------|
| Optimistic message clear on confirmed send | chat-interface.tsx L270-279 | ChatInterface |
| Draft restore on send failure | chat-input.tsx L139-148 | useDraftPersistence |
| Esc interrupt only when working + no permission | chat-input.tsx L162-174 | ChatInputField or parent |
| Permission keyboard shortcuts only for isFirst | chat-input.tsx L418-438 | PermissionCard |
| Session refresh on inactive + new message | chat-interface.tsx L285-288 | ChatInterface |

## What Stays in ChatInterface

- `rawMessages`, `renderableMessages`, `toolResultMap` — tightly coupled
- `activeTodos`, `progressMessage` — simple state, not worth extracting
- `optimisticMessage` — needs message comparison logic
