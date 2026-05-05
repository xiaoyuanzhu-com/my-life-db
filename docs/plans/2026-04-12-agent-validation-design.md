# Agent Validation MCP Tool + Standard Cron Fix

**Date:** 2026-04-12
**Status:** Approved

## Problem

The agent runner silently fails when agent definitions have invalid configurations. A backup agent with a standard 5-field cron expression (`"0 3 * * *"`) never fired because the CronHook uses `robfig/cron` with `WithSeconds()`, which requires 6-field expressions. The error was logged but never surfaced to the user or the agent-creating skill.

There is no feedback loop: the create-agent skill writes a file and hopes it works.

## Solution

Three changes:

1. **Fix CronHook to use standard 5-field cron** — drop `WithSeconds()`
2. **Add `validateAgent` MCP tool** — structural validation with clear error messages
3. **Update create-agent skill** — call `validateAgent` before writing the file

## Design

### 1. CronHook: Standard 5-field cron

**File:** `backend/hooks/cron_hook.go`

Change `cron.New(cron.WithSeconds())` to `cron.New()`.

Standard 5-field cron: `minute hour day-of-month month day-of-week`

No backwards compatibility concern — the only existing cron agent uses 5-field and is currently broken.

### 2. `validateAgent` MCP tool

**Location:** Added to the existing `agent-apps` MCP server (`backend/agentapps/mcp.go` + `backend/agentapps/service.go`).

**Tool name:** `validateAgent`

**Input:**
- `content` (string, required) — full markdown content of the agent definition (frontmatter + prompt)

**Validation checks:**
1. Frontmatter delimiters present (opening/closing `---`)
2. Valid YAML in frontmatter
3. Required fields: `name`, `agent`, `trigger`
4. `agent` is one of: `claude_code`, `codex`
5. `trigger` is one of: `file.created`, `file.changed`, `file.moved`, `file.deleted`, `cron`
6. If `trigger` is `cron`, `schedule` is present and parses as valid 5-field cron (using the same `robfig/cron` parser the runner uses)
7. Prompt body is non-empty

**Success response:**
```json
{"valid": true, "parsed": {"name": "Backup xiaoyuanzhu-apps", "agent": "claude_code", "trigger": "cron", "schedule": "0 3 * * *", "enabled": true}}
```

**Error response:**
```json
{"valid": false, "errors": ["trigger is \"cron\" but schedule is missing"]}
```

Errors are specific and actionable so the calling agent can fix issues without human help.

**Implementation:** Reuses `agentrunner.ParseAgentDef` for frontmatter parsing (no duplicated logic). Adds cron parse validation on top using `robfig/cron` parser with default (5-field) options.

### 3. Create-agent skill update

Add a validation step after assembling content, before writing the file:

1. Build full markdown content
2. Call `validateAgent` MCP tool with the content
3. If errors → read error messages, fix content, retry
4. If valid → write file to `agents/`

Documentation-only change to the skill markdown.

## Scope

| Change | Where | Type |
|--------|-------|------|
| Drop `WithSeconds()` | `hooks/cron_hook.go` | 1-line fix |
| Add `validateAgent` tool | `agentapps/mcp.go` + `service.go` | New MCP tool |
| Cron parse validation | `agentapps/service.go` | New function |
| Update create-agent skill | `.claude/skills/create-agent/index.md` | Text update |

## Out of scope

- Web UI for agent status
- Prompt dry-running
- Agent execution monitoring
