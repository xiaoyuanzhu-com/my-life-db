# Auto-Run Agents Design

## Overview

Two independent systems that together enable user-defined agents that run automatically in response to events:

1. **Hooks Module** — a first-class MyLifeDB event system
2. **Agent Runner** — consumes hooks to trigger ACP agent sessions

Plus a **creator skill** that teaches the agent interactively and distills the result into a reusable definition.

---

## System 1: Hooks Module

**Package**: `backend/hooks/`

A standalone MyLifeDB subsystem. Any feature can subscribe — agent runner is just one consumer.

### Core Types

```go
package hooks

type EventType string

const (
    // Time-based
    EventCronTick EventType = "cron.tick"

    // File system
    EventFileCreated EventType = "file.created"
    EventFileMoved   EventType = "file.moved"
    EventFileDeleted EventType = "file.deleted"
    EventFileChanged EventType = "file.changed"

    // Lifecycle
    EventAppStarted  EventType = "app.started"
    EventAppStopping EventType = "app.stopping"
)

type Payload struct {
    EventType EventType      `json:"event_type"`
    Timestamp time.Time      `json:"timestamp"`
    Data      map[string]any `json:"data"`
}

type Subscriber func(ctx context.Context, payload Payload)
```

### Hook Interface

```go
type Hook interface {
    Type() EventType
    Start(ctx context.Context) error
    Stop() error
}
```

Hooks are pure event emitters. They detect events and call `registry.Emit()`. No business logic.

### Registry

```go
type Registry struct { ... }

func (r *Registry) Register(hook Hook) error
func (r *Registry) Subscribe(eventType EventType, sub Subscriber)
func (r *Registry) Emit(payload Payload)
func (r *Registry) Start(ctx context.Context) error
func (r *Registry) Stop() error
```

The registry manages hook lifecycle and fans out payloads to all matching subscribers.

### CronHook

A general-purpose cron scheduler. Consumers register named schedules dynamically.

```go
type CronHook struct {
    registry *Registry
    cron     *cron.Cron
}

func (h *CronHook) AddSchedule(name string, expr string) error
func (h *CronHook) RemoveSchedule(name string) error
```

The CronHook doesn't know about agents. It manages schedules and emits `cron.tick` events. The agent runner registers schedules based on agent definitions; other consumers could register their own.

### FSHook

Watches configured directories using fsnotify.

```go
type FSHook struct {
    registry *Registry
}

func (h *FSHook) AddWatch(path string) error
func (h *FSHook) RemoveWatch(path string) error
```

### LifecycleHook

Called directly by the server startup/shutdown code. Not a watcher — just a named emitter.

### Payload Schemas

**`cron.tick`**

| Field | Type | Description |
|-------|------|-------------|
| `schedule` | `string` | The cron expression that fired |
| `name` | `string` | User-defined name for the schedule |

**`file.created`**

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Full path relative to data root |
| `name` | `string` | File name |
| `folder` | `string` | Parent folder relative to data root |
| `size` | `int64` | File size in bytes |
| `mime_type` | `string` | Detected MIME type |

**`file.moved`**

| Field | Type | Description |
|-------|------|-------------|
| `from_path` | `string` | Original path |
| `to_path` | `string` | New path |
| `name` | `string` | File name |

**`file.deleted`**

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Path that was deleted |
| `name` | `string` | File name |
| `was_dir` | `bool` | Whether it was a directory |

**`file.changed`**

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Path to changed file |
| `name` | `string` | File name |
| `size` | `int64` | New file size |

**`app.started`**

| Field | Type | Description |
|-------|------|-------------|
| `version` | `string` | App version |
| `data_dir` | `string` | Data directory path |

**`app.stopping`**

| Field | Type | Description |
|-------|------|-------------|
| `reason` | `string` | `shutdown`, `restart`, or `error` |

### V1 Scope

Ship `CronHook` and `FSHook` only. `LifecycleHook` is trivial to add later. The hook interface makes adding new types a single-file change.

---

## System 2: Agent Runner

**Package**: `backend/agentrunner/`

Depends on `hooks` and `agentsdk`. Independent of the API layer.

### Responsibilities

1. **Load** — scan `data/agents/*.md`, parse frontmatter + body
2. **Register** — subscribe to hooks, register cron schedules
3. **Hot reload** — watch agents folder, add/remove/update registrations live
4. **Execute** — on trigger, spawn ACP session with prompt + payload context
5. **Lifecycle** — track running sessions, graceful shutdown

### Agent Markdown Format

```markdown
---
name: Organize Inbox
agent: claude_code
trigger: file.created
enabled: true
---

<natural language prompt>
```

#### Frontmatter Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | yes | — | Display name, shown on agent page |
| `agent` | `string` | yes | — | ACP agent type (`claude_code`, `codex`, etc.) |
| `trigger` | `string` | yes | — | Hook event type (`file.created`, `cron`, etc.) |
| `schedule` | `string` | if cron | — | Cron expression (e.g., `0 2 * * *`) |
| `enabled` | `bool` | no | `true` | Set `false` to disable without deleting |

No path filters, no MCP config. All filtering and behavioral logic lives in the natural language prompt. The agent receives the full payload and decides whether to act.

### Execution Flow

```
Hook fires → Registry fans out → Agent runner receives payload
  → Match payload.EventType to agent definitions
  → For each matched agent:
      1. Build prompt = markdown body + serialized payload context
      2. CreateSession(agentType, prompt, permissionMode: "auto")
      3. Tag session: source="auto", agent_file="<filename>.md"
      4. Session appears on agent page with "auto" badge
      5. On completion: status → "completed" or "error"
```

### Payload Injection

The hook payload is prepended to the prompt as context:

```
[Trigger Context]
Event: file.created
Time: 2026-04-10T14:30:00Z
File: inbox/receipt-2026-04-10.pdf
Size: 245KB
MIME: application/pdf
```

### Multiple Agents, Same Trigger

Multiple agent files can subscribe to the same event type. All matching agents run independently as separate sessions.

### Permission Mode

Always `auto`. Auto-run agents are trusted by definition. Failures surface as error sessions on the agent page.

### Cron Registration Flow

```
Agent runner starts
  → Scans agents/*.md
  → For agents with trigger: cron
      → Calls cronHook.AddSchedule(agentName, schedule)
  → CronHook fires at scheduled time
      → Emits cron.tick with {name, schedule}
  → Agent runner matches tick.name to agent definition
      → Spawns ACP session
```

---

## Agent Creator Skill

A Claude Code skill shipped with MyLifeDB that helps users create agent definitions through an interactive walkthrough.

### Flow

1. User says "I want to automate X"
2. Skill asks: "Let's do it together first" — invites user to set up a real scenario
3. Skill walks through the task step by step, user observes and corrects
4. Repeat with variations if needed — user tunes the approach
5. Skill distills the learned approach into a clear prompt
6. User reviews and adjusts the prompt
7. Skill generates the frontmatter (trigger type, schedule, name)
8. Saves to `data/agents/<name>.md`

### Guidance the skill provides

- Choosing the right trigger type
- Translating natural language schedules to cron expressions
- Hinting about publish-post MCP for sharing results to the explore page
- When to skip vs act (since there are no filters — the prompt handles this)

### Output

A complete agent markdown file with battle-tested prompt, not abstract instructions.

---

## Legacy Inbox Agent

The existing `backend/agent/` package (direct LLM calls, hardcoded tools) is fully replaced by this system. Remove it once auto-run agents are operational.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│                   MyLifeDB                       │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │           Hooks Module                    │    │
│  │                                           │    │
│  │  Registry                                 │    │
│  │    ├── CronHook    → cron.tick            │    │
│  │    ├── FSHook      → file.created/moved/  │    │
│  │    │                 deleted/changed       │    │
│  │    └── (future hooks)                     │    │
│  │                                           │    │
│  │  Subscribe(eventType, callback)           │    │
│  └──────────────┬───────────────────────────┘    │
│                 │ fan-out                         │
│       ┌─────────┼──────────┐                     │
│       ▼         ▼          ▼                     │
│  Agent Runner  (future)  (future)                │
│       │                                          │
│       ▼                                          │
│  ┌──────────┐    ┌───────────────────┐           │
│  │ agents/  │    │    ACP (agentsdk) │           │
│  │ *.md     │───▶│  Spawn session    │           │
│  │          │    │  Auto permission   │           │
│  └──────────┘    │  Visible on page   │           │
│                  └───────────────────┘           │
└─────────────────────────────────────────────────┘
```
