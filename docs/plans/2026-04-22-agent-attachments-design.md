# Agent Session Attachments — Design

Let users attach files to prompts in both the new-session composer and the active-session composer. Files are staged to a tmp directory server-side and referenced by absolute path in the prompt via the existing `@<path>` file-tag convention. No persistence, no DB, no new send-payload fields.

## Goals

- Attach any file type (images, PDFs, code, CSVs, logs, binaries), up to 1 GB each, multiple per message.
- Works identically in the new-session empty state and when sending follow-ups in an active session.
- Composer shows a chip per attachment with a remove (X) affordance.
- The agent receives the attachment as an `@<absolute-path>` reference inside the normal prompt string — no special message shape.
- Uploaded files self-expire after 30 days.

## Non-goals

- Not a replacement for the inbox/library upload flow. Attachments are ephemeral "here, look at this" drops — not persisted as user data.
- No inline image rendering as multimodal prompt content. The agent reads the file via its Read tool when it encounters the `@<path>` reference.
- No message-bubble attachment chips. The user bubble shows the prompt text as sent, including the inline `@<path>`.
- No chunked/resumable uploads (the existing TUS endpoint is for library uploads). A single multipart request is fine at 1 GB for a self-hosted personal app on LAN.

## Key decision: `@<absolute-path>` in the prompt text

Reuse the existing `@<path>` convention (`frontend/app/components/agent/file-tag-popover.tsx:230` already inserts `@<relative-path>` into composer text). The attachment chip is purely a composer-side UI affordance; at send time the composer appends ` @<absolutePath>` per attachment to the message text. The prompt that reaches the backend and the agent is a plain string.

Why:
- Zero changes to `POST /api/agent/sessions` payload, WebSocket send-prompt frame, `agentMgr.CreateSession`, or user-message persistence/rendering.
- Claude Code's CLI natively interprets `@<path>` as a file reference. Codex sees the absolute path as text and uses its Read tool.
- The bubble shows text as-sent — the user can see exactly what the agent saw, including the `@<path>` tokens.

## Storage

```
APP_DATA_DIR/tmp/agent-uploads/<uploadID>/<originalFilename>
```

- `uploadID` = server-generated UUID (one dir per upload)
- Original filename preserved (helps the agent understand what it is)
- No SQLite table — the filesystem is the only record
- Readable by the agent subprocess because its default permission mode (`bypassPermissions` for Claude Code, `full-access` for Codex) allows arbitrary absolute paths. Attachments are a bypass-mode-only feature in practice; if a stricter mode is used, the agent's Read tool would refuse paths outside its working dir. Acceptable for v1 on a personal self-hosted app.

## API

### `POST /api/agent/attachments`

Auth: agent group (same as other `/api/agent/*` endpoints).
Content-Type: `multipart/form-data` with field `file`.
Size cap: 1 GB. Return `413` if exceeded.

Response:
```json
{
  "uploadID": "<uuid>",
  "absolutePath": "/abs/path/to/APP_DATA_DIR/tmp/agent-uploads/<uuid>/<filename>",
  "filename": "<original filename>",
  "size": 12345,
  "contentType": "application/pdf"
}
```

### `DELETE /api/agent/attachments/:uploadID`

Auth: agent group.
Removes the `<uploadID>` directory. Idempotent — `204` whether or not it existed. Called by the composer when the user clicks the X on a staged chip before sending.

## Composer UX

Single change applied to the existing `Composer` in `frontend/app/components/assistant-ui/thread.tsx`. Works for both new-session and active-session since both render the same component.

- "+" button added to the composer options row, alongside the existing folder picker / options menu.
- Drag-and-drop target over the composer surface — dropping files starts an upload per file.
- Attachment chip strip above the text input (rendered only when attachments exist). Each chip shows:
  - File icon (or image thumbnail if `contentType` starts with `image/`)
  - Filename (truncated with ellipsis past ~20 chars)
  - Upload progress spinner while in-flight; error state with retry affordance on failure
  - X button → fires `DELETE /api/agent/attachments/:uploadID` + removes chip from local state
- Composer send behavior:
  - If any attachments are staged, append ` @<absolutePath>` to the message text for each, in the order attached
  - Send the normal prompt via the existing path (`createSessionWithMessage` for new-session, runtime/WebSocket for follow-up)
  - Clear the attachment list on successful send (the files remain on disk — cleanup is the janitor's job)
  - On send failure, restore the chips so the user can retry (matches how the composer already restores text via `pendingComposerText`)

State: a new `attachments: Attachment[]` piece of composer state, where `Attachment = {uploadID, filename, absolutePath, size, contentType, status: 'uploading' | 'ready' | 'error'}`. Lives alongside the existing composer text state.

## Backend changes

- New file `backend/api/agent_attachments.go` with the two handlers above.
- Route registration in `backend/api/routes.go` under the `agentRoutes` group (line ~149).
- `APP_DATA_DIR/tmp/agent-uploads/` is created on demand the first time an upload arrives (owned by `Server` only insofar as `APP_DATA_DIR` is known to `Config`).
- No changes to `CreateAgentSession`, `agentMgr.CreateSession`, the WebSocket send-prompt handler, message persistence, or user-message rendering.

## Cleanup janitor

Goroutine owned by `server.Server`, started in `server.New()` alongside other workers. Runs once at startup and then every hour via a `time.Ticker`. On each tick:

- Scan `APP_DATA_DIR/tmp/agent-uploads/` for direct child directories.
- For each, stat the directory's mtime; delete the directory tree if mtime is older than 30 days.
- Listen on `shutdownCtx` to exit cleanly.

Pure filesystem — no DB bookkeeping, no coupling to session lifecycle. Simple enough that a future user manually deleting the folder doesn't break anything.

## Error handling

- Upload: 1 GB cap returned as `413 Payload Too Large`. Invalid multipart as `400`. Disk write failure as `500`. Frontend shows error state on the chip with a retry.
- Delete: always `204` — idempotent.
- Send with partially-uploaded attachments: send button is disabled while any chip is in `uploading` or `error` state.
- Agent-side: if the agent's Read tool fails on the path (file deleted after send, or agent in a stricter permission mode), that's a normal agent error — the user sees it in the conversation. No special handling.

## Permission-mode caveat (documented, not solved)

Attachments rely on the agent being in a permission mode that allows reading absolute paths outside its working directory. The app's defaults are exactly this. If a user explicitly switches a session to Claude Code's `default` mode, attachments sent in that session will fail at Read time. Acceptable for v1; revisit if users actually hit this.

## Testing

- Unit test for upload handler: happy path, 1 GB limit, missing file field.
- Unit test for delete handler: happy, idempotent on missing ID.
- Unit test for janitor sweep: creates fake dirs with old/new mtimes, verifies correct ones are deleted.
- Frontend: manual smoke of chip lifecycle (upload → chip → remove → chip disappears + DELETE called; upload → send → text includes `@<path>`; drag-and-drop → uploads).

## Out of scope / future

- Chunked/resumable uploads — add if 1 GB single-request proves flaky over cellular or the app goes multi-user.
- Multimodal image content blocks — revisit if it turns out the agent's Read-tool round-trip for images meaningfully degrades UX.
- Message-bubble attachment chips — revisit if the inline `@<path>` in bubbles feels too noisy in practice.
- Coupling cleanup to session archive/delete — the age-based sweep is sufficient.
