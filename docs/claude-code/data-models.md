# Claude Code Data Directory (~/.claude)

## Overview

Claude Code stores all session data, configuration, and cache files in `~/.claude/`. This document comprehensively describes every directory and file, with special focus on what's relevant for building a web UI.

**Related Documentation**:
- [websocket-protocol.md](./websocket-protocol.md) - Real-time WebSocket protocol for session updates

---

## Directory Structure

```
~/.claude/
├── cache/                    # Application cache
├── debug/                    # Debug logs per session
├── file-history/             # File version history per session
├── history.jsonl             # Global command history
├── ide/                      # IDE integration lock files
├── paste-cache/              # Cached pasted content
├── plans/                    # Agent execution plans
├── plugins/                  # Plugin system (marketplace + installed)
├── projects/                 # Per-project session storage ⭐ KEY
├── session-env/              # Per-session environment variables
├── settings.json             # User settings
├── settings.local.json       # Local permission overrides
├── shell-snapshots/          # Shell environment snapshots
├── stats-cache.json          # Usage statistics cache
├── statsig/                  # Feature flag & analytics cache
├── telemetry/                # Telemetry event queue
└── todos/                    # Per-session todo lists
```

---

## Detailed Documentation

### 1. projects/ ⭐⭐⭐ CRITICAL FOR WEB UI

**Purpose**: Primary storage for all conversation sessions, organized by project path.

**Structure**:
```
projects/
├── -Users-iloahz-projects-my-life-db/    # Project directory
│   ├── sessions-index.json               # Session metadata index
│   ├── {sessionId}.jsonl                 # Session conversation log
│   └── {sessionId}/                      # Optional subdirectory
│       └── subagents/
│           └── agent-{id}.jsonl          # Subagent logs
└── -Users-iloahz-Desktop-sharable/       # Another project
```

**Directory naming**: Project paths with slashes replaced by hyphens (`/Users/foo/bar` → `-Users-foo-bar`)

#### sessions-index.json

**Format**: JSON

**Content**:
```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
      "fullPath": "/Users/iloahz/.claude/projects/-Users-iloahz-projects-my-life-db/04361723-fde4-4be9-8e44-e2b0f9b524c4.jsonl",
      "fileMtime": 1768991158926,
      "firstPrompt": "<ide_opened_file>The user opened the file /Users/iloahz/projects/my-life-db/.env in the IDE...</ide_opened_file>",
      "summary": "Disable Semantic Search Frontend Temporarily",
      "customTitle": "My Custom Session Name",
      "tag": "feature",
      "agentName": "explore-agent",
      "agentColor": "#4CAF50",
      "messageCount": 11,
      "created": "2026-01-19T04:45:15.012Z",
      "modified": "2026-01-19T04:46:54.480Z",
      "gitBranch": "main",
      "projectPath": "/Users/iloahz/projects/my-life-db",
      "isSidechain": false
    }
  ]
}
```

**Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Unique UUID for session |
| `fullPath` | string | Absolute path to session JSONL file |
| `fileMtime` | number | Last modification time (Unix ms) |
| `firstPrompt` | string | First user message (may include IDE context tags) |
| `summary` | string? | **Claude-generated 5-10 word title** (auto-generated on session index rebuild) |
| `customTitle` | string? | User-set custom title (via `/title` command) |
| `tag` | string? | User-assigned session tag (via `/tag` command) |
| `agentName` | string? | Name for subagent sessions |
| `agentColor` | string? | Color hex code for subagent sessions |
| `messageCount` | number | Total messages in conversation |
| `created` | string | Session start timestamp (ISO 8601) |
| `modified` | string | Last activity timestamp (ISO 8601) |
| `gitBranch` | string | Git branch when session started |
| `projectPath` | string | Working directory for session |
| `isSidechain` | bool | Whether session is a branch/fork |

**Title Resolution Priority** (for display):
1. `agentName` - If set (for subagent sessions)
2. `customTitle` - If user set a custom title
3. `summary` - Claude-generated title (most common)
4. `firstPrompt` - Fallback to first message
5. `"Autonomous session"` - For sidechain sessions with no other title

**Summary Generation**:
- Claude CLI auto-generates summaries when rebuilding the session index
- Uses a prompt: "Summarize this coding conversation in under 50 characters. Capture the main task, key files, problems addressed, and current status."
- Stored in JSONL as `{"type":"summary","summary":"...","leafUuid":"..."}`

**Web UI Usage**:
- **List all sessions** for a project
- **Sort by recent activity** (`modified` field)
- **Display session title** (prefer `summary` over `firstPrompt`)
- **Filter by branch** (`gitBranch`)
- **Filter by tag** (`tag` field)
- **Show subagent sessions** with color indicator

#### {sessionId}.jsonl

**Format**: JSONL (JSON Lines - one JSON object per line, append-only)

**Content**: Complete conversation history with all messages, tool calls, and results.

**Message Types** (`type` field):

| Type | Description |
|------|-------------|
| `user` | User input or tool results |
| `assistant` | Claude's responses (text and/or tool calls) |
| `system` | System messages (e.g., conversation compacted) |
| `progress` | Progress updates (e.g., hook execution) |
| `summary` | Auto-generated session summary |
| `custom-title` | User-set custom title |
| `tag` | User-assigned session tag |
| `agent-name` | Subagent name assignment |
| `queue-operation` | Internal queue management |
| `file-history-snapshot` | File version tracking |

**Common Message Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | string | Unique message identifier |
| `parentUuid` | string? | Parent message UUID (for threading) |
| `timestamp` | string | ISO 8601 timestamp |
| `type` | string | Message type (see table above) |
| `sessionId` | string | Session UUID |
| `cwd` | string | Working directory |
| `version` | string | Claude Code version (e.g., "2.1.11") |
| `gitBranch` | string | Current git branch |
| `isSidechain` | bool | Whether in a branch/fork |
| `userType` | string | User type ("external") |
| `agentId` | string? | Subagent ID (e.g., "a081313") |
| `slug` | string? | Human-readable session slug |

---

#### Message Type Details

**1. User Messages**
```json
{
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "cwd": "/Users/iloahz/projects/my-life-db",
  "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
  "version": "2.1.11",
  "gitBranch": "main",
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "temp disable semantic for now, disable from frontend"
      }
    ]
  },
  "uuid": "c0a21d6f-3652-4f86-a36b-b98d75a15298",
  "timestamp": "2026-01-19T04:45:15.012Z"
}
```

**2. Assistant Messages (Text)**
```json
{
  "parentUuid": "c0a21d6f-3652-4f86-a36b-b98d75a15298",
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-5-20250929",
    "id": "msg_011ZDfTwZ6PbL4YwkoxGTyTE",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "I'll help you temporarily disable semantic search from the frontend..."
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 3,
      "output_tokens": 1,
      "cache_creation_input_tokens": 7513,
      "cache_read_input_tokens": 17070,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 7513,
        "ephemeral_1h_input_tokens": 0
      },
      "service_tier": "standard"
    }
  },
  "requestId": "req_011CXG8NGkcHf7UFyKrGqvEg",
  "uuid": "a953b709-f2f8-46e3-8c99-4f9b01f8e6d5",
  "timestamp": "2026-01-19T04:45:17.971Z"
}
```

**Assistant Message Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `message.model` | string | Model used (e.g., "claude-opus-4-5-20251101") |
| `message.id` | string | Claude API message ID |
| `message.role` | string | Always "assistant" |
| `message.content` | array | Content blocks (text, tool_use, thinking) |
| `message.stop_reason` | string? | Why generation stopped |
| `message.usage` | object | Token usage statistics |
| `requestId` | string | API request ID |

**Usage Object Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `input_tokens` | number | Input tokens used |
| `output_tokens` | number | Output tokens generated |
| `cache_creation_input_tokens` | number | Tokens used to create cache |
| `cache_read_input_tokens` | number | Tokens read from cache |
| `cache_creation.ephemeral_5m_input_tokens` | number | 5-minute cache tokens |
| `cache_creation.ephemeral_1h_input_tokens` | number | 1-hour cache tokens |
| `service_tier` | string | Service tier ("standard") |

**3. Assistant Messages (Tool Use)**
```json
{
  "parentUuid": "a953b709-f2f8-46e3-8c99-4f9b01f8e6d5",
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_014EkHUXLk8xUUUqjocQNd8g",
        "name": "Read",
        "input": {
          "file_path": "/Users/iloahz/projects/my-life-db/frontend/app/routes/home.tsx"
        }
      }
    ]
  },
  "uuid": "75819da3-58d5-4d30-a167-a1449fd87738",
  "timestamp": "2026-01-19T04:45:18.615Z"
}
```

**Content Block Types**:

| Type | Description | Fields |
|------|-------------|--------|
| `text` | Text response | `text` |
| `tool_use` | Tool invocation | `id`, `name`, `input` |
| `thinking` | Extended thinking (Opus 4.5+) | `thinking`, `signature` |
| `tool_result` | Tool execution result | `tool_use_id`, `content`, `is_error` |

**4. Tool Results**
```json
{
  "type": "user",
  "parentUuid": "75819da3-58d5-4d30-a167-a1449fd87738",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_014EkHUXLk8xUUUqjocQNd8g",
        "type": "tool_result",
        "content": "import { useState } from 'react'\n..."
      }
    ]
  },
  "toolUseResult": {
    "toolUseId": "toolu_014EkHUXLk8xUUUqjocQNd8g",
    "isError": false
  },
  "sourceToolAssistantUUID": "75819da3-58d5-4d30-a167-a1449fd87738",
  "uuid": "8f3c5d2a-...",
  "timestamp": "2026-01-19T04:45:19.123Z"
}
```

**5. System Messages**
```json
{
  "parentUuid": null,
  "logicalParentUuid": "ad679bef-2e91-4ed9-a209-180f922e66bf",
  "type": "system",
  "subtype": "compact_boundary",
  "content": "Conversation compacted",
  "isMeta": false,
  "level": "info",
  "compactMetadata": {
    "trigger": "auto",
    "preTokens": 158933
  },
  "timestamp": "2026-01-12T08:57:09.474Z",
  "uuid": "4a85087f-5458-426b-8fce-84a4c4d3c46c"
}
```

**6. Progress Messages**
```json
{
  "type": "progress",
  "data": {
    "type": "hook_progress",
    "hookEvent": "SessionStart",
    "hookName": "SessionStart:startup",
    "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start.sh"
  },
  "parentToolUseID": "33ffc13a-212e-4bdd-ba49-6580bac743e8",
  "toolUseID": "33ffc13a-212e-4bdd-ba49-6580bac743e8",
  "timestamp": "2026-01-20T07:56:11.367Z",
  "uuid": "d4298bf0-3c9f-4430-ac8e-416986f0858f"
}
```

**7. Summary (Auto-generated title)**
```json
{
  "type": "summary",
  "summary": "Disable Semantic Search Frontend Temporarily",
  "leafUuid": "4d3be2fe-ce98-404b-ad87-6d18b18f0c82"
}
```

**8. Custom Title (User-set)**
```json
{
  "type": "custom-title",
  "customTitle": "My Feature Branch Work",
  "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4"
}
```

**9. Tag (User-assigned)**
```json
{
  "type": "tag",
  "tag": "feature",
  "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4"
}
```

**10. Internal Events**
```json
{"type":"queue-operation","operation":"dequeue","timestamp":"2026-01-19T04:45:15.003Z","sessionId":"..."}
{"type":"file-history-snapshot","messageId":"...","snapshot":{"trackedFileBackups":{},"timestamp":"..."},"isSnapshotUpdate":false}
```

**Threading**: Messages form a tree structure using `uuid` and `parentUuid`:
```
User Message (uuid: A, parentUuid: null)
  ├─ Assistant Response (uuid: B, parentUuid: A)
  │   ├─ Tool Call (uuid: C, parentUuid: B)
  │   └─ Tool Result (uuid: D, parentUuid: C)
  └─ Assistant Final (uuid: E, parentUuid: D)
```

**Lifecycle**:
- Created when session starts
- Appended to after every message exchange
- Never deleted (permanent history)
- Can grow to several MB for long sessions

**Web UI Usage**:
- **Parse JSONL line-by-line** to build conversation thread
- **Build message tree** using `uuid`/`parentUuid` relationships
- **Display tool calls inline** with results
- **Show token usage** from `usage` field
- **Tail file for live updates** (watch for new lines)

---

### 2. todos/ ⭐⭐⭐ IMPORTANT FOR WEB UI

**Purpose**: Per-session todo lists for tracking multi-step task progress.

**Format**: JSON files named `{sessionId}-agent-{agentId}.json`

**Content**:
```json
[
  {
    "content": "Run tests",
    "status": "completed",
    "activeForm": "Running tests"
  },
  {
    "content": "Fix bug in auth",
    "status": "in_progress",
    "activeForm": "Fixing bug in auth"
  },
  {
    "content": "Update docs",
    "status": "pending",
    "activeForm": "Updating docs"
  }
]
```

**Fields**:
- `content` - Task description (imperative: "Run tests")
- `status` - `"pending"` | `"in_progress"` | `"completed"`
- `activeForm` - Present continuous (gerund: "Running tests")

**Lifecycle**:
- Created when Claude starts multi-step work
- Updated in real-time as tasks complete
- Persists after session ends

**Web UI Usage**:
- **Display progress indicator** showing N/M tasks completed
- **Show current task** in active form
- **Real-time updates** via file watching or polling
- **Task checklist UI** with completed items checked off

---

### 3. file-history/ ⭐⭐⭐ IMPORTANT FOR WEB UI

**Purpose**: Version history of files edited during sessions (for diff viewing and undo).

**Structure**:
```
file-history/
└── {sessionId}/
    └── {fileHash}@v{version}
```

**Example**:
- `file-history/04361723-fde4-4be9-8e44-e2b0f9b524c4/a3876286b49eefd6@v1`
- Contains full file contents at that version

**Lifecycle**:
- Created when Edit/Write tool modifies files
- New version saved for each edit
- Never cleaned up automatically

**Web UI Usage**:
- **Show diffs** between versions
- **"View changes" button** for each Edit tool use
- **Undo/redo functionality**
- **Track which files modified** in a session

---

### 4. history.jsonl ⭐⭐ IMPORTANT FOR WEB UI

**Purpose**: Global command history across all sessions and projects.

**Format**: JSONL (one JSON per line)

**Content**:
```json
{"display":"init","pastedContents":{},"timestamp":1760427512208,"project":"/Users/iloahz/projects/my-life-db"}
{"display":"commit it","pastedContents":{},"timestamp":1760427598099,"project":"/Users/iloahz/projects/my-life-db"}
{"display":"temp disable semantic","timestamp":1764303341137,"project":"/Users/iloahz/projects/my-life-db","sessionId":"61c1252c-8dea-46aa-ac30-1fecdaf76c4d"}
```

**Fields**:
- `display` - Command text as typed by user
- `pastedContents` - Map of pasted content IDs
- `timestamp` - Unix timestamp (milliseconds)
- `project` - Working directory
- `sessionId` - Session UUID (if in session)

**Lifecycle**:
- Appended every time user submits input
- Never cleared automatically
- Used for command autocomplete

**Web UI Usage**:
- **Global activity timeline** across projects
- **Command history search**
- **"Recent commands" widget**

---

### 5. stats-cache.json ⭐⭐⭐ IMPORTANT FOR WEB UI

**Purpose**: Pre-computed usage statistics for dashboards.

**Format**: JSON

**Content**:
```json
{
  "version": 1,
  "lastComputedDate": "2026-01-18",
  "dailyActivity": [
    {
      "date": "2025-11-14",
      "messageCount": 665,
      "sessionCount": 6,
      "toolCallCount": 237
    }
  ],
  "modelUsage": {
    "claude-opus-4-5-20251101": {
      "inputTokens": 669395,
      "outputTokens": 2487416,
      "cacheReadInputTokens": 861541932,
      "cacheCreationInputTokens": 68518882
    }
  },
  "totalSessions": 487,
  "totalMessages": 52034,
  "longestSession": {
    "sessionId": "...",
    "messageCount": 234,
    "created": "..."
  },
  "firstSessionDate": "2025-11-14T07:42:10.871Z",
  "hourCounts": {
    "0": 123,
    "1": 45,
    "9": 2341,
    "14": 1893
  }
}
```

**Lifecycle**:
- Updated daily or on-demand (`/stats` command)
- Aggregates data from all session JSONL files

**Web UI Usage**: ⭐⭐⭐ CRITICAL
- **Usage dashboard** with charts
- **Token consumption by model**
- **Activity heatmap** by hour
- **Session statistics**
- **Cost tracking** (multiply tokens by model rates)

---

### 6. paste-cache/ ⭐⭐ MODERATE FOR WEB UI

**Purpose**: Deduplicate large pasted content to save space in session logs.

**Format**: Text files named by content hash (e.g., `3d4b07345212e93b.txt`)

**Content**: Full pasted text
```
ROLE
You are a "Social Knowledge Design Agent"...
```

**Lifecycle**:
- Created when user pastes large content
- Referenced by hash in session JSONL
- Shared across sessions (same content = same file)

**Web UI Usage**:
- **Resolve paste references** when displaying messages
- **"View pasted content" expandable section**
- Message shows: `[Pasted text #1 +92 lines]` → click to expand

---

### 7. plans/ ⭐⭐ MODERATE FOR WEB UI

**Purpose**: Agent execution plans (when using plan mode or planning agents).

**Format**: Markdown files with generated names (e.g., `spicy-stargazing-sundae.md`)

**Content**: Structured plan documents
```markdown
# Plan: Add Structured Session History API for Web UI

## Problem
The web UI currently receives **raw terminal output**...

## Solution Overview
Add a new **structured history API**...

## Implementation Plan
### Phase 1: Backend - Session File Reader
...
```

**Lifecycle**:
- Created when agent enters plan mode
- Updated as plan evolves
- Persists after completion

**Web UI Usage**:
- **"View Plan" button** for sessions with plans
- **Plan progress indicator** alongside chat
- **Plan diff** showing what changed

---

### 8. settings.json ⭐⭐ MODERATE FOR WEB UI

**Purpose**: Global user settings for Claude Code.

**Format**: JSON

**Content**:
```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "model": "opus",
  "feedbackSurveyState": {
    "lastShownTime": 1754037545093
  }
}
```

**Fields**:
- `model` - Default model (`"opus"`, `"sonnet"`, `"haiku"`)
- Other user preferences

**Web UI Usage**:
- **Display current model** selection
- **Model switcher** dropdown
- **Settings panel**

---

### 9. debug/ ⭐ LOW (for troubleshooting only)

**Purpose**: Debug logs for each session (verbose logging).

**Format**: Text files named `{sessionId}.txt`

**Content**: Timestamped debug logs
```
2026-01-14T09:22:56.605Z [DEBUG] Watching for changes in setting files...
2026-01-14T09:22:56.612Z [DEBUG] [LSP MANAGER] initializeLspServerManager() called
```

**Web UI Usage**:
- **"View Debug Logs" button** for troubleshooting
- Hidden by default

---

### 10. shell-snapshots/ ⭐ NONE (internal)

**Purpose**: Capture shell environment for reproducible Bash command execution.

**Format**: Shell script files

**Lifecycle**: Created at session start, reused for Bash tool

**Web UI Relevance**: Internal infrastructure, not displayed

---

### 11. session-env/ ⭐ NONE (internal)

**Purpose**: Per-session environment variable overrides.

**Web UI Relevance**: Internal, mostly empty directories

---

### 12. settings.local.json ⭐ LOW

**Purpose**: Local permission overrides (not synced).

**Content**:
```json
{
  "permissions": {
    "allow": ["WebFetch(domain:github.com)"],
    "deny": []
  }
}
```

**Web UI Usage**: Could display granted permissions (security/privacy)

---

### 13. cache/, ide/, plugins/, statsig/, telemetry/ ⭐ NONE

**Purpose**: Internal application cache and infrastructure

**Web UI Relevance**: Not relevant for UI display

---

## Summary: Web UI Priority

### Critical (⭐⭐⭐):
1. **projects/{project}/{sessionId}.jsonl** - Conversation history
2. **projects/{project}/sessions-index.json** - Session list
3. **todos/** - Task progress tracking
4. **file-history/** - File edit diffs
5. **stats-cache.json** - Usage analytics

### Important (⭐⭐):
6. **history.jsonl** - Global command history
7. **settings.json** - User preferences
8. **paste-cache/** - Pasted content resolution
9. **plans/** - Execution plans

### Optional (⭐):
10. **debug/** - Troubleshooting logs

---

## Key Insights for Web UI Development

### 1. Session JSONL Files
- **Append-only** - Tail them for real-time updates
- **Thread structure** - Use `uuid`/`parentUuid` to build conversation trees
- **Multiple message types** - Handle `user`, `assistant`, `tool_use`, `tool_result`
- **Rich content** - Parse nested `content` arrays

### 2. File Watching Strategy
For real-time updates, watch these files:
```
projects/{project}/{sessionId}.jsonl   → New messages
todos/{sessionId}-agent-*.json         → Task progress
file-history/{sessionId}/*             → File edits
```

### 3. Message Threading Algorithm
```typescript
function buildMessageTree(jsonlLines: string[]) {
  const messages = jsonlLines.map(line => JSON.parse(line))
  const byUuid = new Map()
  const roots = []

  for (const msg of messages) {
    byUuid.set(msg.uuid, msg)
    if (!msg.parentUuid) {
      roots.push(msg)
    }
  }

  for (const msg of messages) {
    if (msg.parentUuid) {
      const parent = byUuid.get(msg.parentUuid)
      if (parent) {
        parent.children = parent.children || []
        parent.children.push(msg)
      }
    }
  }

  return roots
}
```

### 4. Todo Progress Calculation
```typescript
function calculateProgress(todos: Todo[]) {
  const completed = todos.filter(t => t.status === 'completed').length
  const inProgress = todos.filter(t => t.status === 'in_progress').length
  const total = todos.length

  return {
    completed,
    inProgress,
    total,
    percentage: (completed / total) * 100
  }
}
```

### 5. Session List Query
```typescript
// Read sessions-index.json for project
const index = JSON.parse(fs.readFileSync('~/.claude/projects/-{project}/sessions-index.json'))

// Sort by most recent
const sessions = index.entries.sort((a, b) =>
  new Date(b.modified).getTime() - new Date(a.modified).getTime()
)

// Get display title (priority: agentName > customTitle > summary > firstPrompt)
function getSessionTitle(entry: SessionIndexEntry): string {
  return entry.agentName
    || entry.customTitle
    || entry.summary
    || entry.firstPrompt
    || (entry.isSidechain ? 'Autonomous session' : 'Untitled')
}

// Display: title, messageCount, modified, gitBranch
```

### 6. Real-time Updates

**Recommended: WebSocket Protocol** (production-ready)

See [websocket-protocol.md](./websocket-protocol.md) for complete documentation.

```typescript
// Connect to session WebSocket
const ws = new WebSocket(`ws://localhost:12345/api/claude/sessions/${sessionId}/subscribe`)

ws.onmessage = (event) => {
  const sessionMsg: SessionMessage = JSON.parse(event.data)
  appendMessage(sessionMsg)
}

// Send user message
ws.send(JSON.stringify({
  type: 'user_message',
  content: 'What files are here?'
}))
```

**Alternative: File Polling** (simpler, higher latency)
```typescript
setInterval(() => {
  const newLines = readNewLines(sessionFilePath, lastPosition)
  lastPosition += newLines.length
  appendMessages(newLines)
}, 1000)
```

**Alternative: File Watching** (efficient, requires filesystem access)
```typescript
fs.watch(sessionFilePath, () => {
  const newLines = readNewLines(sessionFilePath, lastPosition)
  lastPosition += newLines.length
  appendMessages(newLines)
})
```

### 7. Cost Calculation
```typescript
const RATES = {
  'claude-opus-4-5': { input: 15, output: 75 },      // per 1M tokens
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4': { input: 0.25, output: 1.25 }
}

function calculateCost(usage: TokenUsage, model: string) {
  const rate = RATES[model]
  const inputCost = (usage.input_tokens / 1000000) * rate.input
  const outputCost = (usage.output_tokens / 1000000) * rate.output
  const cacheRead = (usage.cache_read_input_tokens / 1000000) * (rate.input * 0.1)
  return inputCost + outputCost + cacheRead
}
```

---

## Example: Building a Session Viewer

```typescript
// 1. List sessions for project
const projectDir = '~/.claude/projects/-Users-iloahz-projects-my-life-db'
const index = JSON.parse(fs.readFileSync(`${projectDir}/sessions-index.json`))

// 2. Get display title for session
function getSessionTitle(entry: SessionIndexEntry): string {
  return entry.agentName
    || entry.customTitle
    || entry.summary
    || entry.firstPrompt?.slice(0, 50)
    || (entry.isSidechain ? 'Autonomous session' : 'Untitled')
}

// 3. Load session conversation
const sessionFile = `${projectDir}/${sessionId}.jsonl`
const lines = fs.readFileSync(sessionFile, 'utf-8').split('\n').filter(Boolean)
const messages = lines.map(line => JSON.parse(line))

// 4. Load todos for session
const todoFile = `~/.claude/todos/${sessionId}-agent-main.json`
const todos = fs.existsSync(todoFile) ? JSON.parse(fs.readFileSync(todoFile)) : []

// 5. Build UI
<SessionView>
  <SessionHeader
    session={index.entries.find(e => e.sessionId === sessionId)}
    title={getSessionTitle(session)}
  />
  <MessageList messages={messages} />
  <TodoPanel todos={todos} />
</SessionView>
```
