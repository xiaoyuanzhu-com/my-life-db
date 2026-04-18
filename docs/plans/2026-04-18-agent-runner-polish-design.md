# Agent Runner Polish — Design

Date: 2026-04-18
Status: Approved

## Goal

Polish two rough edges in the existing Agent Runner:

1. Give each auto-run agent its own folder so it can hold supporting files alongside its definition.
2. Expose session initiator (user vs. agent-runner, and which agent) through the API so the frontend can group and label auto-run sessions distinctly from manual ones.

## Non-goals

- Dynamic/agent-authored session titles. Out of scope for this polish — will be revisited once we add MCP-based session manipulation.
- New MCP session-management tools.
- Any changes to the ACP layer, session lifecycle, or Claude Code / Codex integration beyond what is required to read the new folder layout and return two extra fields in API responses.

## Current state (as of 2026-04-18)

- Agent definitions are flat `.md` files directly under `data/agents/`. Two exist today: `backup-xiaoyuanzhu-apps.md`, `vocabulary-flashcard.md`.
- The parser (`backend/agentrunner/parser.go`) reads YAML frontmatter + markdown body.
- The runner (`backend/agentrunner/runner.go`) loads defs at startup, watches `data/agents/` with `fsnotify`, debounces 500 ms, and re-registers cron/file-event triggers on change.
- `agent_sessions` table already stores `source` (`'user'` or `'auto'`) and `agent_file` — added in migration 020. The runner sets `source: "auto"` and `agent_file: def.File` when it creates an auto-run session.
- The REST endpoints `GET /api/agent/sessions/all` and `GET /api/agent/sessions/:id` do **not** return `source` or `agent_file` today.
- The frontend `Session` TypeScript interface already declares `source?: 'user' | 'auto'` and `agentFile?: string`, and `ThreadList` already renders an "auto" badge when `sessionSources[id] === 'auto'`. The badge never fires today because the API never sends `source`.

## Design

### 1. Folder-per-agent layout

New layout:

    data/agents/
      backup-xiaoyuanzhu-apps/
        backup-xiaoyuanzhu-apps.md        ← the definition
        (any supporting files the agent needs — state, logs, helpers)
      vocabulary-flashcard/
        vocabulary-flashcard.md
        ...

Rules:

- Each agent lives in its own subdirectory under `data/agents/`.
- The definition filename matches the folder name: `<dirname>/<dirname>.md`.
- The folder name is the canonical **agent name**.
- Files directly under `data/agents/` are ignored (skipped with a debug log). No backward compatibility with the flat layout — the two existing agents are moved as part of this change.
- Additional files inside an agent's folder are not parsed by the runner. They are the agent's private workspace.

Parser/runner changes:

- `LoadDefs` walks the top-level entries of `AgentsDir`. For each subdirectory `<name>`, it reads `<name>/<name>.md` and parses it. If that file is missing, the folder is skipped with a warning.
- The watcher is re-scoped to watch `AgentsDir` recursively (add each subdirectory to the `fsnotify.Watcher`, or use a small wrapper). On any `.md` change/create/remove/rename inside a subdirectory, debounce 500 ms and call `reload()`, same as today.
- `ParseAgentDef` gains the folder name as input; `def.Name` is set from the folder, not from the `name:` frontmatter field. If frontmatter `name` conflicts with the folder name, the folder wins (log a warning).

Migration of existing data:

- Move `data/agents/backup-xiaoyuanzhu-apps.md` → `data/agents/backup-xiaoyuanzhu-apps/backup-xiaoyuanzhu-apps.md`.
- Move `data/agents/vocabulary-flashcard.md` → `data/agents/vocabulary-flashcard/vocabulary-flashcard.md`.
- These moves are done manually as part of deploy, not automated in code.

### 2. Session initiator — DB, runner, API, UI

DB migration 021 (`migration_021_agent_session_agent_name.go`):

- Rename column `agent_sessions.agent_file` → `agent_sessions.agent_name`.
- Backfill: for existing rows where `agent_file` is non-empty, strip the trailing `.md` extension so the value becomes the folder name. E.g. `backup-xiaoyuanzhu-apps.md` → `backup-xiaoyuanzhu-apps`.
- `source` column unchanged.

Go model (`backend/db/agent_sessions.go`):

- Rename `AgentSessionRecord.AgentFile` → `AgentSessionRecord.AgentName`, JSON tag `agentName`.
- Update all readers/writers (`ListAgentSessions`, `GetAgentSession`, `CreateAgentSession`, etc.) to use the new column name.

Runner (`backend/agentrunner/runner.go`):

- `execute` passes `AgentName: def.Name` (the folder name) instead of `AgentFile: def.File`.
- `agentrunner.SessionParams` field is renamed accordingly.

Bridge (`main.go`):

- Update the `SetCreateSession` wiring to pass `AgentName` through to `api.SessionParams`.

API (`backend/api/agent_api.go`):

- `GET /api/agent/sessions/all` includes `source` and (when non-empty) `agentName` in each list item.
- `GET /api/agent/sessions/:id` includes `source` and (when non-empty) `agentName` in the single-session payload.
- The `POST /api/agent/sessions` handler keeps hardcoding `Source: "user"` and leaves `AgentName` empty.

Frontend (`frontend/app/routes/agent.tsx` + `thread-list.tsx`):

- `Session` TS type: rename `agentFile?: string` → `agentName?: string`. `source?: 'user' | 'auto'` already exists.
- Sidebar grouping within the current active/archived filter: split `sessions` into two lists — `autoSessions` (source === 'auto') and `manualSessions` (everything else). Render them under two section headers: **Auto** (top) and **Manual** (below). Within each section, sort by recency (same ordering as today).
- Each section header shows a count. Empty sections are hidden.
- For auto sessions, the sidebar row shows the `agentName` as a small secondary label under the title. The existing "auto" badge already implemented in `ThreadList` will now fire because `source` flows through.
- Pagination: keep the single paginated list from the API; grouping is a client-side split of the already-loaded pages. No new endpoints.

### 3. Titles — no change

Auto-run sessions keep the current static title (the agent folder name, set by the runner at session creation). This is a known rough edge; we will revisit once MCP-based session manipulation is added.

## Data flow summary (auto-run session)

    fsnotify / cron tick
        → runner.execute(def)
        → CreateSession(Source: "auto", AgentName: def.Name, Title: def.Name, ...)
        → db.CreateAgentSession(... source="auto", agent_name=def.Name ...)
        → ACP NewSession spawns the Claude Code/Codex agent
        → agent runs to completion, session.Close()

    GET /api/agent/sessions/all
        → ListAgentSessions reads rows
        → response includes {source, agentName} per item
        → frontend splits into Auto/Manual sections, shows auto badge + agentName label

## Testing

- Parser unit test: folder-per-agent loading picks up `<dir>/<dir>.md`, ignores flat files, warns on missing inner `.md`.
- Watcher unit/integration test: adding a new agent folder triggers a reload.
- DB migration test: 021 renames the column and backfills values correctly (`.md` stripped).
- API smoke test: create an auto session via runner, call list endpoint, assert `source: "auto"` and `agentName` in response.
- Frontend: manual QA of Auto/Manual grouping and agent name label.

## Risks and rollback

- Breaking the flat layout is a one-shot migration. Rollback requires moving files back and reverting the parser change. Acceptable risk given only two agents exist.
- DB migration 021 is a rename-with-backfill. SQLite rename-column is supported on recent versions; if schema constraints block it, fall back to create-new-column / copy / drop-old in the same migration.
- Frontend: the `auto` badge starting to appear is a visible change for users of existing sessions (they may have some from past auto-runs that now show the badge). This is desired, not a regression.
