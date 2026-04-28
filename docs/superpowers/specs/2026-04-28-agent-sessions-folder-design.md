# Agent Sessions Folder — Design Spec

## Summary

Replace today's two ad-hoc storage areas for agent-related transient files (`AppDataDir/<uploadID>/` for user attachments and `USER_DATA_DIR/generated/<date>/` + `USER_DATA_DIR/.generated/` for agent/MCP outputs) with a single per-session layout under `USER_DATA_DIR/sessions/`.

This covers files where the user has no explicit destination — uploads handed to the agent, images/HTML the agent generates, MCP tool outputs. It does **not** cover agent edits to user-specified paths; those continue to write directly to the user's chosen location.

## Layout

```
USER_DATA_DIR/
  sessions/
    <storage-id>/
      uploads/      # user-uploaded attachments
      generated/    # agent + MCP outputs (flat, no date subdir)
```

- `<storage-id>` is a UUID generated server-side, separate from the ACP session id (the ACP id stays as the `agent_sessions` primary key — no rename, no frontend churn).
- Both subfolders are flat. Filename collisions get a numeric suffix (e.g. `report.html`, `report-1.html`).
- Files are visible to the user, indexed by the FS service, and searchable like any other folder under `USER_DATA_DIR`.
- No automatic cleanup. Sessions and their files persist until the user removes them.

## Storage ID Lifecycle

The storage id is allocated lazily — at the first action that produces a file, whichever comes first:

1. **First upload (before session exists)**: client posts to `/api/agent/attachments` with no `storageId`. Backend mints one, returns it, and caches it client-side. Subsequent uploads in the same conversation pass the known `storageId`.
2. **Session create with no prior upload**: `POST /api/agent/sessions` request body accepts an optional `storageId`. If absent, backend mints one. Either way it's persisted to the new `agent_sessions.storage_id` column.

Once allocated, the storage id is fixed for the life of the session — never reused, never changed.

## Wiring

The storage id reaches the agent (for HTML render path) and the MCP handler (for image gen + future artifact tools) via two channels:

### Per-session MCP server config (custom header)

`agent_manager.go:CreateSession` builds `acp.McpServer.Headers` per session, adding `X-MLD-Session-Id: <storage_id>` alongside the existing `Authorization` header. This config is passed via `agentsdk.SessionConfig.McpServers` (currently relies on the global default in `agentsdk.NewClient`; that fallback path stays for non-mylifedb callers but the manager always provides explicit per-session servers).

The MCP handler ([agentrunner/mcp.go](../../../backend/agentrunner/mcp.go)) reads the header on each request via `c.GetHeader("X-MLD-Session-Id")` and uses it to compute the destination directory. The header passes through cleanly because ACP's `McpServerHttpInline.Headers` is general — the agent CLI just attaches whatever it was given. (Same mechanism the existing `Authorization` header already relies on.)

### Per-session system prompt

`agent_manager.go:CreateSession` builds the system prompt per session, interpolating `<storage_id>` into the HTML-render instruction path. The prompt is passed via `agentsdk.SessionConfig.SystemPrompt`. The current `buildAgentSystemPrompt(userDataDir)` becomes `buildAgentSystemPrompt(userDataDir, storageID)`.

## Behavior

### Uploads

- The attachments handler ([api/agent_attachments.go](../../../backend/api/agent_attachments.go)) writes to `USER_DATA_DIR/sessions/<storage_id>/uploads/<filename>` instead of `AppDataDir/tmp/agent-uploads/<uploadID>/`.
- The `POST /api/agent/attachments` endpoint accepts an optional `storageId` form field. When absent, the handler mints a new id and returns it in the response (alongside the existing `uploadID`, `absolutePath`, etc.). When present, the handler writes under the supplied id.
- Filename collisions get a numeric suffix (`<stem>-1.<ext>`, `<stem>-2.<ext>`, …).
- The `DELETE /api/agent/attachments/:uploadID` endpoint becomes obsolete in its current form (it removed an `AppDataDir` staging dir keyed by uploadID). Replaced by `DELETE /api/agent/attachments/:storageId/:filename` so the client can remove a specific staged file. Existing callers that delete by uploadID need to be updated.

### Generated artifacts

The session's `generated/` directory is the default destination for any agent or MCP tool that produces a file with no user-specified path. Two existing producers move here:

1. **Image generation MCP tool** ([agentrunner/image.go](../../../backend/agentrunner/image.go), [agentrunner/mcp.go](../../../backend/agentrunner/mcp.go)) — currently writes to `USER_DATA_DIR/generated/<date>/<slug>-<hash>.png`. Moves to `USER_DATA_DIR/sessions/<storage_id>/generated/<slug>-<hash>.png`. The date subdirectory goes away (the storage id already provides scoping). The MCP handler reads `X-MLD-Session-Id` from the request header and passes it down into `ImageGenConfig` so the writer can resolve the destination.
2. **HTML render via system prompt** ([server/server.go:794-817](../../../backend/server/server.go#L794-L817)) — currently instructs Claude to write to `<dataDir>/.generated/<name>.html` and renders via `<iframe src="/raw/.generated/<name>.html">`. The per-session system prompt now points at `<dataDir>/sessions/<storage_id>/generated/<name>.html` and `<iframe src="/raw/sessions/<storage_id>/generated/<name>.html">`. Claude continues to use the `Write` tool — no new MCP tool is added for HTML.

### MCP request without a session id

If `X-MLD-Session-Id` is missing or empty (e.g., during local dev or a misconfigured caller), tool calls that need a destination dir fail with a clear error message rather than silently writing to a fallback location. This surfaces wiring bugs early.

### MCP tool descriptions

LLM-facing strings in [agentrunner/mcp.go:30](../../../backend/agentrunner/mcp.go#L30), [agentrunner/mcp.go:349](../../../backend/agentrunner/mcp.go#L349), and [agentrunner/mcp.go:391](../../../backend/agentrunner/mcp.go#L391) currently document the old `USER_DATA_DIR/generated/<date>/` path. These are updated to describe the new per-session path so the model's mental model matches reality. The model never needs to *pass* the path — the MCP server resolves it from the session header.

### FS indexing

The `sessions/` folder is indexed normally by the FS watcher and digest worker — same as any other top-level folder under `USER_DATA_DIR`. No special path-filter rules. The user can search, browse, and pin files inside session folders just like elsewhere.

The previously-special `.generated` dot-folder loses its special status:
- [fs/pathfilter.go:57](../../../backend/fs/pathfilter.go#L57) — comment about `.generated` removed
- [fs/pathfilter_test.go:179-180](../../../backend/fs/pathfilter_test.go#L179-L180) — test removed
- [fs/validation_test.go:68](../../../backend/fs/validation_test.go#L68) — test case removed
- [skills/create-auto-agent.md:116](../../../backend/skills/create-auto-agent.md#L116), [skills/create-auto-agent.md:235](../../../backend/skills/create-auto-agent.md#L235) — references removed/updated

## Database

A new column on the `agent_sessions` table:

```
storage_id TEXT NOT NULL DEFAULT ''
```

Stored at session create. Read alongside the session row whenever a handler needs to resolve a file path. Default empty string for backfill compatibility — existing rows have no storage id and won't get one (their files were already in the old AppDataDir / `generated/<date>/` locations).

## Migration

- Old uploads in `AppDataDir/tmp/agent-uploads/<uploadID>/`: not tied to any session, so nothing meaningful to migrate. Old code path is deleted; stale files in `AppDataDir` can be left to rot or wiped on first boot.
- Old `USER_DATA_DIR/generated/<date>/` and `USER_DATA_DIR/.generated/` directories: left in place. They remain user-visible filesystem entries; user can move or delete them manually. New writes go to the per-session layout.

## Out of Scope

- Agent edits to user-specified paths (Write/Edit tool targets to user-curated folders) — continue to use the path the user/agent chose; no change.
- Per-session TTL / automatic cleanup — left for a future iteration if storage growth becomes a problem.
- A "save to library" action that promotes a generated file out of `sessions/` into a curated user folder — useful, but separate work.
- Frontend changes to the session list UI to surface attached/generated files — separate work.
- A new `saveArtifact` MCP tool — considered but not needed; HTML render keeps using `Write`, image gen keeps its existing tool surface. Can be added later if other artifact types appear.

## Open Questions

None at design time. Implementation-level questions are resolved in the implementation plan.
