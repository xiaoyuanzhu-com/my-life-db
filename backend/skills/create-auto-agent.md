---
name: create-auto-agent
description: Create or edit an auto-run agent definition for MyLifeDB. Use when the user wants to automate a task — organizing files, running backups, scheduled reports, processing new uploads, or any recurring workflow. Trigger on phrases like "create an agent", "automate this", "run this automatically", "set up a task", "I want this to happen whenever", "do this every day", "when a new file arrives", or when the user describes any workflow they want to happen without manual intervention. Also trigger when the user asks to edit, update, or modify an existing agent definition. If the user invokes the skill with no specific task in mind ("make me an agent", "I don't know, inspire me", or just opening the skill), run the cold-start inspire flow.
---

# Create Agent

Help the user create an auto-run agent definition — a markdown file that tells MyLifeDB when and how to run an AI agent automatically. When MyLifeDB detects the trigger event, it spawns an ACP agent session, injects the trigger context (what file appeared, what cron fired), and sends the prompt. The agent decides whether and how to act.

## File layout (IMPORTANT — don't get this wrong)

Each agent lives in its **own subfolder** under `<USER_DATA_DIR>/agents/`:

```
<USER_DATA_DIR>/agents/
├── organize-inbox/
│   └── organize-inbox.md
├── weekly-review/
│   └── weekly-review.md
└── flash-cards-from-words/
    └── flash-cards-from-words.md
```

Flat files like `agents/organize-inbox.md` are **ignored** by the runner. Always create the subfolder. The folder name and the `.md` filename stem must match and be kebab-case.

## The format

```markdown
---
name: <display name>
trigger: <event type>
path: "<glob>"          # required for file.* triggers
schedule: "<cron>"      # required for cron trigger
enabled: true
---

<natural language prompt — all action logic lives here>
```

### Frontmatter fields

| Field | Required when | Values | Notes |
|-------|---------------|--------|-------|
| `name` | always | any string | Display name shown in the agent list. Note: the folder name always wins over this field for the internal ID — keep them in sync for sanity. |
| `agent` | optional | `claude_code`, `codex`, `qwen`, `gemini`, `opencode` | Which ACP agent to spawn. **Defaults to `claude_code`.** Omit unless the task specifically needs a different agent — the global default may change as the app evolves, and omitting keeps the def portable. |
| `model` | optional | gateway model ID (e.g. `claude-opus-4-7`) | Which model to use. **Defaults to the first AGENT_MODELS entry compatible with the chosen agent.** Only set this when the task genuinely needs a specific model (cost/capability tradeoff). Omitting keeps the def portable as available models evolve. |
| `trigger` | always | `file.created`, `file.changed`, `file.moved`, `file.deleted`, `cron` | Event that starts the agent. |
| `path` | file.* triggers | doublestar glob | Path pattern matched against the event path. **Required for every file trigger.** See "Path globs" below. |
| `schedule` | cron trigger | cron expression | Standard 5-field cron (minute hour day-of-month month day-of-week). |
| `enabled` | optional | `true` / `false` | Default `true`. Set `false` to pause without deleting the file. |

### Trigger types

**File events** (`file.created`, `file.changed`, `file.moved`, `file.deleted`) — the agent runs whenever the event fires on a path matching the `path` glob. The prompt receives a trigger context block with the full event payload (path, name, folder).

**Cron** — the agent runs on a schedule. Examples:
- `"0 8 * * *"` — daily at 8am
- `"0 */6 * * *"` — every 6 hours
- `"0 9 * * 1"` — every Monday at 9am
- `"0 0 1 * *"` — first of every month at midnight

### Path globs

The `path` field uses [doublestar](https://github.com/bmatcuk/doublestar) glob syntax (like gitignore, with `**` for recursive). Common patterns:

| Pattern | Matches |
|---------|---------|
| `inbox/**` | anything inside `inbox/`, recursively |
| `words/*.png` | PNG files directly under `words/` (not subfolders) |
| `**/*.pdf` | any PDF anywhere in the data dir |
| `journal/2026/**` | anything under `journal/2026/` recursively |
| `photos/**/*.{jpg,png,heic}` | image extensions under `photos/` at any depth |

**Trial an unfamiliar glob:** write a test path through `doublestar.Match(pattern, path)` mentally or ask the user to confirm which real files should match.

### Trigger context injection

When the agent runs, the runner prepends this block to the prompt:

```
[Trigger Context]
Event: file.created
Time: 2026-04-10T14:30:00Z
Path: inbox/receipt-2026-04-10.pdf
Name: receipt-2026-04-10.pdf
Folder: inbox

---

<your prompt follows here>
```

For `cron` triggers, the Path/Name/Folder lines are absent and a `Schedule:` line is included instead. The prompt can read these values to decide what to do.

## Available MCP tools

This skill can call MCP tools provided by MyLifeDB. **Before you reference any tool in an agent's prompt, confirm it's actually connected in the current session** (tool names appear prefixed with `mcp__<server>__<tool>` in your tool list). All MyLifeDB tools live on a single server:

- **`mylifedb-builtin`**
  - `mcp__mylifedb-builtin__validateAgent({ name, markdown })` → `{ valid, error?, parsed? }`. Parses the frontmatter without writing to disk. **Always call this before `Write`** so the user doesn't land a broken file that the runner silently ignores.
  - `mcp__mylifedb-builtin__createPost({ author, title, content, media, tags })` — publishes a post to the explore feed.
  - `mcp__mylifedb-builtin__listPosts`, `addComment`, `addTags`, `deletePost` — other feed operations.

Other MCP tools may be connected (e.g. `chrome-devtools` for rendering). Only hint a tool in an agent's prompt if you can see it in your current session — a prompt that references a missing tool will fail at runtime.

## Workflow

### Phase 1 — Inspire (cold start only)

Use this when the user opens the skill without a specific task ("make me an agent", "inspire me", or any phrasing where they clearly want suggestions rather than help with a task they've already formed).

1. Scan the user's data dir to ground the proposals:
   - `Glob` `<USER_DATA_DIR>/*` for top-level folders (signals: domains — `inbox/`, `words/`, `photos/`, `journal/`, …).
   - `Glob` `<USER_DATA_DIR>/agents/*/` for existing agents (signals: what's already automated — don't duplicate).
   - `Glob` the 20 most-recently-modified files under `<USER_DATA_DIR>/` (excluding `agents/`, `.*`, `sessions/`) for an activity signal — where is the user actually working today?
2. Propose exactly **3 examples** designed to span trigger diversity:
   - one `cron` agent (scheduled report / digest / cleanup),
   - one `file.*` agent that uses an MCP tool (e.g. `publish-post`) on interesting content,
   - one `file.*` agent that's a pure side-effect (move, rename, backup, generate derivative).
   Bias the choice toward folders that actually exist and have recent activity. Never propose an agent whose `trigger + path` overlaps an existing agent.
3. Each proposal is a one-line pitch ("What about a weekly review that runs Sunday 9am and posts a summary to the explore feed?"). Let the user pick one or redirect, then continue into Phase 2.

### Phase 2 — Understand & iterate on a real example

The goal is to write the prompt from **experience**, not imagination. Walk through the task on a real file or a real run; the corrections the user makes as you go become the prompt.

1. Ask one question at a time to pin down:
   - What triggers it? (New file? Schedule? File change?)
   - If file: which paths count? — propose 2–3 candidate globs and have the user pick (e.g. `inbox/**`, `inbox/*.pdf`, `**/receipt-*`).
   - If cron: which schedule? — translate the user's natural phrasing ("every weekday morning" → `0 8 * * 1-5`) and read it back in words.
   - What should the agent do when fired?
   - Any conditions where it should skip and do nothing?
2. **Collision check.** `Glob` `<USER_DATA_DIR>/agents/*/*.md` and scan their frontmatter for the same trigger + overlapping path. If there's overlap, tell the user and ask whether this is the extension of an existing agent or genuinely new.
3. Pick a real example and walk through it *with* the user — read the file, analyze, propose the action, execute it. Let them correct you. After corrections, try another example. 2–3 iterations is usually enough; stop when you get through a new example with no corrections.

### Phase 3 — Save, validate, and trial-run

1. Assemble the frontmatter + prompt. Include the correctness basics you learned in Phase 2; state skip cases explicitly (*"If the file is NOT in inbox/, respond 'Skipping' and do nothing."*).
2. **Validate with the MCP tool before writing.** Call `mcp__mylifedb-builtin__validateAgent` with the name and markdown. If `valid: false`, fix the error and re-validate. Do **not** call `Write` until validation passes.
3. Write the file with `Write` to `<USER_DATA_DIR>/agents/<kebab-name>/<kebab-name>.md`. The fs watcher picks it up within ~500ms; no restart needed.
4. Trial run:
   - **File-triggered agent with non-destructive action**: drop a real test file into the trigger path. The runner fires the agent; watch the session page for output.
   - **File-triggered agent with destructive action** (move/delete/overwrite): set `enabled: false` in the frontmatter first, then trigger manually via `POST /api/agent/defs/<name>/run` (e.g. `curl -X POST http://localhost:12345/api/agent/defs/<name>/run`). Review what it would have done. Flip to `enabled: true` only after the user confirms.
   - **Cron agent**: trigger manually via the same `POST /api/agent/defs/<name>/run` endpoint — don't make the user wait for the next scheduled fire.
5. If the trial reveals a flaw, go back to Phase 2 on that specific edge case, revise the prompt, re-validate, re-save.

### Phase 4 — Summarize

Once the agent is working, give the user a ≤5-line report:

- **Name and path** — `organize-inbox` at `data/agents/organize-inbox/organize-inbox.md`
- **Fires on** — `file.created` matching `inbox/**` / or / `cron 0 8 * * *` (daily 8am)
- **What it does** — one sentence
- **Pause it** — set `enabled: false` in the frontmatter
- **Re-run manually** — `curl -X POST http://localhost:12345/api/agent/defs/<name>/run`

Then stop. Don't over-explain.

## Writing good prompts

Prompts carry all the intelligence — there are no config-based filters. A good prompt:

- **Opens with the role**, one sentence: *"You are an inbox organizer for a personal life database."*
- **States the skip case first**, explicitly: *"If the file is not in `inbox/`, respond 'Skipping' and do nothing."* Every file-trigger agent sees every matching event; missing the skip case makes the agent chatty and expensive.
- **Lists rules learned from the walkthrough**, preferring distilled rules over raw examples, but includes concrete examples where a rule needs a hook (*"Receipts and invoices → `finance/receipts/YYYY/`"*).
- **Says how to report** — a short summary message so the session page is useful.
- **Names real MCP tools** (not ones you hope exist). If you used `publish-post` in the walkthrough and it's actually connected, hint it in the prompt. If it isn't, don't pretend it is.

### Destructive actions — extra care

For agents that move, delete, or overwrite files (backups, cleanup, auto-organize), bake in a guard:

> *"Before moving or deleting anything, log the full source → destination path and the reason. On your first 3 runs, log the intended action and skip actually executing it — print 'DRY RUN' so I can review the log. After I flip you to live mode, proceed."*

Combine with the `enabled: false` → trial → `enabled: true` rollout in Phase 3.

## Examples

### File-triggered agent with collision-aware glob

```markdown
---
name: Organize Inbox
trigger: file.created
path: "inbox/**"
enabled: true
---

You are an inbox organizer for a personal life database.

If the trigger context shows the file is NOT in the inbox/ folder, respond "Skipping, not an inbox file." and do nothing.

Otherwise, analyze the file and move it to the right home:

1. Read the file to understand what it is.
2. Check the existing folder structure (use the Read and Glob tools) to find the best destination.
3. Move the file (Bash `mv`) to the appropriate folder.

Rules learned from experience:
- Receipts and invoices → finance/receipts/YYYY/
- Work documents → work/
- Photos → photos/YYYY/MM/
- Personal documents → documents/
- If unsure, leave the file in inbox/ and explain why in your summary.

If the file is something genuinely interesting or noteworthy, use the `createPost` tool from the `explore` MCP server to share a brief note on the explore feed.

Summarize what you did in a short message.
```

### Cron-triggered agent with publish-post

```markdown
---
name: Weekly Review
trigger: cron
schedule: "0 9 * * 0"
enabled: true
---

Generate a weekly review of activity in this life database.

1. Check what files were added or changed in the past 7 days (use Bash `find <dir> -mtime -7`).
2. Summarize activity by category (documents, photos, notes, etc.).
3. Note anything that might need attention (large files in inbox, orphaned items, gaps where the user normally writes).

Use the `createPost` tool from the `explore` MCP server to share the weekly summary on the feed. Title it with the date range.
```

## Common pitfalls

- **Forgetting the subfolder** — `agents/foo.md` is ignored. It must be `agents/foo/foo.md`.
- **Missing `path` on file triggers** — the runner rejects the def. Use `path: "**"` only if you genuinely want every file event.
- **Over-broad globs** — `path: "**"` fires on every digest output, thumbnail, `sessions/` write, and more. Scope tighter unless you want that.
- **Missing `schedule` on cron** — also rejected by the runner.
- **No skip case in the prompt** — every matching event fires the agent. Without a skip branch, the agent acts on things it shouldn't.
- **Inventing MCP tool names** — only reference tools that are actually connected in the current session.
- **Destructive agent without dry-run** — if the walkthrough revealed moves/deletes, include the DRY RUN guard above.
