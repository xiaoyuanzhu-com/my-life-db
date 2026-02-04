# Migration Plan: Unify AskUserQuestion with control_request/control_response

## Problem Statement

Currently, `AskUserQuestion` uses custom message types (`question_request`/`question_response`) that we invented, while all other tools use the standard `control_request`/`control_response` protocol from Claude CLI.

**Current (Inconsistent):**
| Tool Type | Request Message | Response Message |
|-----------|-----------------|------------------|
| Regular (Bash, Write, etc.) | `control_request` | `control_response` |
| AskUserQuestion | `question_request` (custom) | `question_response` (custom) |

**Target (Unified):**
| Tool Type | Request Message | Response Message |
|-----------|-----------------|------------------|
| All tools including AskUserQuestion | `control_request` | `control_response` |

## Design Principle

**We should NOT invent new message types.** We should rely on Claude CLI's native protocol as much as possible. The `control_request`/`control_response` protocol already supports everything we need:

- `control_request` has `tool_name` and `input` fields
- `control_response` can include `updatedInput` for modified tool parameters

## Current Flow (To Be Removed)

```
Claude → tool_use (AskUserQuestion)
    ↓
SDK CanUseTool callback
    ↓
handleAskUserQuestion() creates question_request (CUSTOM)
    ↓
Frontend receives question_request, shows UI
    ↓
Frontend sends question_response (CUSTOM)
    ↓
Backend receives, unblocks callback with answers
```

## Target Flow (Unified)

```
Claude → tool_use (AskUserQuestion)
    ↓
SDK CanUseTool callback
    ↓
Standard permission flow creates control_request with tool_name="AskUserQuestion"
    ↓
Frontend detects tool_name="AskUserQuestion", shows question UI (not permission UI)
    ↓
Frontend sends control_response with updatedInput containing answers
    ↓
Backend receives, returns PermissionResultAllow with UpdatedInput
```

## Changes Required

### 1. Backend: session.go

**Remove:**
- `handleAskUserQuestion()` function (lines ~813-909)
- `SendQuestionResponse()` function (lines ~911-933)
- `pendingQuestions` map and mutex
- `QuestionResponse` struct

**Modify `CreatePermissionCallback()`:**
- Remove special case for `AskUserQuestion` at line ~686-694
- Let it fall through to the standard permission flow

**Modify `PermissionResponse` struct:**
- Add `UpdatedInput map[string]any` field

**Modify `SendControlResponse()`:**
- Add `updatedInput map[string]any` parameter
- Pass it through the channel

**Modify permission callback return:**
- Use `resp.UpdatedInput` when returning `PermissionResultAllow`

### 2. Backend: api/claude.go

**Remove:**
- `case "question_response":` handler (lines ~1122-1157)

**Modify `case "control_response":`:**
- Parse `updated_input` field from the response
- Pass it to `SendControlResponse()`

### 3. Frontend: chat-interface.tsx

**Remove:**
- `if (msg.type === 'question_request')` handler (lines ~253-278)
- Comments referencing `question_request`

**Modify `if (msg.type === 'control_request')` handler:**
- After calling `permissions.handleControlRequest()`, check if `tool_name === 'AskUserQuestion'`
- If so, extract questions from `input.questions` and add to `pendingQuestions`

**Modify `handleQuestionAnswer()`:**
- Instead of sending `question_response`, send `control_response` with `updatedInput`
- Use `permissions.buildPermissionResponse()` as base, add `updatedInput`

**Modify `handleQuestionSkip()`:**
- Send `control_response` with `behavior: "deny"` and `message: "User skipped"`

### 4. Frontend: use-permissions.ts

**Modify `buildPermissionResponse()`:**
- Add optional `updatedInput` parameter
- Include it in the response when provided

### 5. Frontend: types/claude.ts (if exists)

- Update `ControlResponse` type to include optional `updated_input` field

### 6. Documentation Updates

**docs/claude-code/data-models.md:**
- Remove `question_request` and `question_response` sections
- Update AskUserQuestion flow diagram to show `control_request`/`control_response`
- Document `updated_input` field in `control_response`

**docs/claude-code/ui.md:**
- Update rendering logic for AskUserQuestion
- Document that frontend detects `tool_name === "AskUserQuestion"` in `control_request`

**docs/claude-code/how-it-works.md:**
- Update flow descriptions

## Message Format Changes

### control_request for AskUserQuestion (Already Exists - Just Use It)

```json
{
  "type": "control_request",
  "request_id": "sdk-perm-1738668123456789",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "AskUserQuestion",
    "input": {
      "questions": [
        {
          "question": "Which database should we use?",
          "header": "Database",
          "options": [
            {"label": "PostgreSQL", "description": "..."},
            {"label": "SQLite", "description": "..."}
          ],
          "multiSelect": false
        }
      ]
    }
  }
}
```

### control_response with updatedInput (New Field)

```json
{
  "type": "control_response",
  "request_id": "sdk-perm-1738668123456789",
  "response": {
    "subtype": "success",
    "response": {
      "behavior": "allow",
      "updated_input": {
        "questions": [...],
        "answers": {
          "Which database should we use?": "PostgreSQL"
        }
      }
    }
  }
}
```

### control_response for Skip (deny)

```json
{
  "type": "control_response",
  "request_id": "sdk-perm-1738668123456789",
  "response": {
    "subtype": "success",
    "response": {
      "behavior": "deny",
      "message": "User skipped this question"
    }
  }
}
```

## Frontend Detection Logic

```typescript
// In handleMessage when receiving control_request
if (msg.type === 'control_request') {
  const request = msg.request as { subtype?: string; tool_name?: string; input?: Record<string, unknown> }

  if (request?.subtype === 'can_use_tool') {
    // Always track in permissions for UI state
    permissions.handleControlRequest({...})

    // Special handling for AskUserQuestion - show question UI instead of permission UI
    if (request.tool_name === 'AskUserQuestion') {
      const questions = request.input?.questions as QuestionData[]
      if (questions) {
        setPendingQuestions(prev => [...prev, {
          id: msg.request_id,
          questions: questions
        }])
      }
    }
  }
}
```

## Backward Compatibility

This is a **breaking change** for any external code relying on `question_request`/`question_response`. However:

1. These were internal protocol messages, not part of Claude CLI's public API
2. No external consumers should depend on them
3. The migration is all internal to our codebase

## Testing Plan

1. **Unit tests:** Update/remove tests for `handleAskUserQuestion` and `SendQuestionResponse`
2. **Integration test:** Verify AskUserQuestion flow works end-to-end
3. **Manual test:**
   - Trigger AskUserQuestion in a live session
   - Answer questions, verify Claude receives answers
   - Skip questions, verify Claude receives denial
   - Test with multiple questions
   - Test multiSelect questions

## Files to Modify

| File | Action |
|------|--------|
| `backend/claude/session.go` | Remove question handlers, add updatedInput support |
| `backend/api/claude.go` | Remove question_response case, add updatedInput parsing |
| `frontend/app/components/claude/chat/chat-interface.tsx` | Unify question handling with control_request |
| `frontend/app/components/claude/chat/hooks/use-permissions.ts` | Add updatedInput to buildPermissionResponse |
| `docs/claude-code/data-models.md` | Update AskUserQuestion section |
| `docs/claude-code/ui.md` | Update rendering docs |
| `docs/claude-code/how-it-works.md` | Update flow descriptions |
