# Agent Trigger Path Filtering

## Problem

All file-trigger agents fire on every file event of their type. A `file.created` agent meant for `words/` gets a full session for every file created anywhere — explore posts, SVGs, config files. This wastes resources and creates noise.

## Solution

Add a required `path` glob field to file-trigger agent definitions. The runner filters events before spawning sessions.

## Agent Definition

```yaml
---
name: Vocabulary Flashcard
agent: claude_code
trigger: file.created
path: "words/**"          # required for file triggers
enabled: true
---
```

- **Required** for: `file.created`, `file.changed`, `file.moved`, `file.deleted`
- **Ignored/omitted** for: `cron`
- **Glob syntax**: `*` (single segment), `**` (recursive), standard glob rules
- **Matched against**: event payload `path` field (relative, e.g. `words/hello.md`)

## Changes

### Parser (`backend/agentrunner/parser.go`)

- Add `Path string` to `AgentDef` struct via yaml tag `path`
- Validation: file triggers with empty `path` → parse error, skip with log warning
- Cron triggers: `path` is ignored

### Runner (`backend/agentrunner/runner.go`)

- In `executeMatchingAgents()`, after checking trigger type + enabled:
  - `doublestar.Match(def.Path, eventPath)` → skip if no match
- No match = no session spawned

### Dependency

- Add `github.com/bmatcuk/doublestar/v4` for `**` glob support
- Go's `filepath.Match` does not support `**`

### `file.moved` semantics

Match against **destination** path (new location) — "fire when something lands in my folder."

### Existing agent updates

| Agent | Change |
|-------|--------|
| `vocabulary-flashcard.md` | Add `path: "words/**"`, remove self-filtering from prompt |
| `backup-xiaoyuanzhu-apps.md` | No change (cron) |

## What doesn't change

- Hooks system, event emission, cron handling, session creation pipeline
- Trigger context in prompt still includes full path/name/folder for agent use
