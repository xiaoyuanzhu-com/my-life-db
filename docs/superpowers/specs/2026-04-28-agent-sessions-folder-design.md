# Agent Sessions Folder — Design Spec

## Summary

Replace today's two ad-hoc storage areas for agent-related transient files (`AppDataDir/<uploadID>/` for user attachments and `USER_DATA_DIR/generated/<date>/` + `USER_DATA_DIR/.generated/` for agent/MCP outputs) with a single per-session layout under `USER_DATA_DIR/sessions/`.

This covers files where the user has no explicit destination — uploads handed to the agent, images/HTML the agent generates, MCP tool outputs. It does **not** cover agent edits to user-specified paths; those continue to write directly to the user's chosen location.

## Layout

```
USER_DATA_DIR/
  sessions/
    <session-id>/
      uploads/      # user-uploaded attachments
      generated/    # agent + MCP outputs (flat, no date subdir)
```

- `<session-id>` is the existing agent session id (see [api/agent_session.go](../../../backend/api/agent_session.go)).
- Both subfolders are flat. Filename collisions inside `generated/` get a numeric suffix (e.g. `report.html`, `report-1.html`).
- Files are visible to the user, indexed by the FS service, and searchable like any other folder under `USER_DATA_DIR`.
- No automatic cleanup. Sessions and their files persist until the user removes them.

## Behavior

### Uploads

- The attachments handler ([api/agent_attachments.go](../../../backend/api/agent_attachments.go)) writes to `USER_DATA_DIR/sessions/<id>/uploads/<filename>` instead of `AppDataDir/<uploadID>/`.
- Filename collisions get a numeric suffix.
- The session id is required at upload time; the upload endpoint must accept it as a parameter.

### Generated artifacts

The session's `generated/` directory is the default destination for any agent or MCP tool that produces a file with no user-specified path. Two existing producers move here:

1. **Image generation MCP tool** ([agentrunner/image.go](../../../backend/agentrunner/image.go), [agentrunner/mcp.go](../../../backend/agentrunner/mcp.go)) — currently writes to `USER_DATA_DIR/generated/<date>/<slug>-<hash>.png`. Moves to `USER_DATA_DIR/sessions/<id>/generated/<slug>-<hash>.png`. The date subdirectory goes away (the session id already provides scoping).
2. **HTML render via system prompt** ([server/server.go:794-817](../../../backend/server/server.go#L794-L817)) — currently instructs Claude to write to `<dataDir>/.generated/<name>.html` and renders via `<iframe src="/raw/.generated/<name>.html">`. The system prompt is updated to write to `<dataDir>/sessions/<id>/generated/<name>.html` and reference `/raw/sessions/<id>/generated/<name>.html` in the iframe.

For both cases, the runtime (not the LLM) is responsible for resolving `<id>` — the session id is plumbed through the agent runner's config (e.g. `ImageGenConfig` gains a session-aware path resolver) and templated into the system prompt at session start.

### MCP tool descriptions

LLM-facing strings in [agentrunner/mcp.go:30](../../../backend/agentrunner/mcp.go#L30), [agentrunner/mcp.go:349](../../../backend/agentrunner/mcp.go#L349), and [agentrunner/mcp.go:391](../../../backend/agentrunner/mcp.go#L391) currently document the old `USER_DATA_DIR/generated/<date>/` path. These are updated to describe the new per-session path so the model's mental model matches reality.

### FS indexing

The `sessions/` folder is indexed normally by the FS watcher and digest worker — same as any other top-level folder under `USER_DATA_DIR`. No special path-filter rules. The user can search, browse, and pin files inside session folders just like elsewhere.

The previously-special `.generated` dot-folder loses its special status:
- [fs/pathfilter.go:57](../../../backend/fs/pathfilter.go#L57) — comment about `.generated` removed
- [fs/pathfilter_test.go:179-180](../../../backend/fs/pathfilter_test.go#L179-L180) — test removed
- [fs/validation_test.go:68](../../../backend/fs/validation_test.go#L68) — test case removed
- [skills/create-auto-agent.md:116](../../../backend/skills/create-auto-agent.md#L116), [skills/create-auto-agent.md:235](../../../backend/skills/create-auto-agent.md#L235) — references removed/updated

## Migration

- Old uploads in `AppDataDir/<uploadID>/`: not tied to any session, so nothing meaningful to migrate. Old code path is deleted; stale files in `AppDataDir` can be left to rot or wiped on first boot of the new code.
- Old `USER_DATA_DIR/generated/<date>/` and `USER_DATA_DIR/.generated/` directories: left in place. They remain user-visible filesystem entries and the user can move or delete them manually. New writes go to the session layout; no automatic relocation of existing files.

## Out of Scope

- Agent edits to user-specified paths (Write/Edit tool targets) — continue to use the path the user/agent chose; no change.
- Per-session TTL / automatic cleanup — left for a future iteration if storage growth becomes a problem.
- A "save to library" action that promotes a generated file out of `sessions/` into a curated user folder — useful, but separate work.
- Frontend changes to the session list UI to surface attached/generated files — separate work.

## Open Questions

None at design time. Implementation-level questions (exact API parameter shape, how session id flows through `ImageGenConfig`, how the system-prompt template gets the session id) are resolved during the implementation plan.
