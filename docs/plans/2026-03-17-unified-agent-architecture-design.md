# MyLifeDB Agent Architecture Design

Date: 2026-03-17
Related: [agent-interface-design.md](2026-03-17-agent-interface-design.md) — Unified Agent SDK interface

## Problem

MyLifeDB's current AI integration is fragmented:

- **Claude Code** is deeply embedded as a special citizen with its own WebSocket protocol, session management, and dedicated UI page.
- **Inbox Agent** uses OpenAI directly with its own agentic loop, tool definitions, and conversation handling.
- **AI Summarize** calls OpenAI through yet another path.
- Every integration requires the user to configure API keys and external services manually.

No shared abstraction. Adding a new agent or switching providers means building from scratch. Cloud users face unnecessary setup friction. Credentials are scattered across environment variables and config files — visible to agents that can run arbitrary code.

## Goals

1. **Zero-setup for cloud users** — agent capabilities work out of the box. No login, no API keys, no configuration.
2. **Flexible for self-hosted users** — bring your own LLM provider or let agents authenticate directly.
3. **Credential security** — real API keys never leak to the container where agents run arbitrary code.
4. **Provider independence** — swap LiteLLM for OpenRouter or direct API calls without changing feature code.
5. **One npm install to add a new agent** — via ACP, not a custom adapter from scratch.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Features / Business Logic                              │
│  (Inbox, Chat, Summarize, etc.)                         │
│  ↕ uses                                                 │
├─────────────────────────────────────────────────────────┤
│  agent.Client (thin Go wrapper)                         │
│  - Lifecycle, session limits, env merging               │
│  ↕ uses                                                 │
│  ACP (Agent Client Protocol) via coder/acp-go-sdk      │
│  - JSON-RPC over stdio to agent binaries                │
│  ↕ spawns                                               │
│  ACP Agent Binaries (claude-agent-acp, codex, etc.)     │
│  ↕ LLM calls routed through ↓                           │
├─────────────────────────────────────────────────────────┤
│  LLM Layer (local proxy on same Gin server)             │
│  ↕ injects credentials, forwards to ↓                   │
├─────────────────────────────────────────────────────────┤
│  LiteLLM / OpenRouter / Direct API                      │
│  ↕                                                      │
│  Anthropic / OpenAI / etc.                              │
└─────────────────────────────────────────────────────────┘
```

### ACP (Agent Client Protocol)

The agent layer is built on [ACP](https://agentclientprotocol.com) — an open standard (analogous to LSP for AI agents) that standardizes communication between clients and coding agents. This eliminates custom per-agent adapters and output parsers.

- **Protocol:** JSON-RPC over stdio (local agents)
- **Go SDK:** [coder/acp-go-sdk](https://github.com/coder/acp-go-sdk) — we implement the `Client` interface
- **Compatible agents:** Claude Code (via [claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)), Codex, Gemini CLI, Goose, Cline, and many more
- **Adding a new agent:** Install its ACP binary via npm + register config. No Go adapter code.

See [agent-interface-design.md](2026-03-17-agent-interface-design.md) for the full SDK interface.

## LLM Layer

A set of reverse-proxy routes on the existing Gin server. No separate process or port — the proxy lives inside the MyLifeDB HTTP server, behind internal-only routes.

### Multi-Protocol Support

Different agents use different LLM protocols. The proxy supports both natively — **no hidden format translation**:

```
POST /api/anthropic/v1/messages         — Anthropic Messages API (for Claude Code)
POST /api/openai/v1/chat/completions    — OpenAI Chat Completions API (for Codex)
GET  /api/llm/v1/models                 — List available models (unified)
```

Each route:
1. Receives the request from the agent in the agent's native format
2. Injects the real API key (from secure storage) into the upstream request headers
3. Forwards to the correct upstream provider as-is — no format transformation
4. Streams the response back to the agent untouched

```
claude-agent-acp                         codex --acp
  │ (spawned by agent.Client via ACP)      │
  │                                        │
  │ ANTHROPIC_BASE_URL=                    │ OPENAI_BASE_URL=
  │   http://localhost:8080/api/anthropic  │   http://localhost:8080/api/openai
  │ ANTHROPIC_API_KEY=dummy                │ OPENAI_API_KEY=dummy
  │ MLD_PROXY_TOKEN=<ephemeral>            │ MLD_PROXY_TOKEN=<ephemeral>
  ▼                                        ▼
┌──────────────────────────────────────────────────────┐
│  MyLifeDB LLM Layer (Gin routes)                     │
│  Validates MLD_PROXY_TOKEN on every request           │
│                                                      │
│  /api/anthropic/* → injects Anthropic key → forward  │
│  /api/openai/*   → injects OpenAI key    → forward   │
│                                                      │
│  Handles 429/quota errors → structured error back    │
└──────────────────────────────────────────────────────┘
  │                                        │
  ▼                                        ▼
Anthropic API                          OpenAI API
(via LiteLLM or direct)               (via LiteLLM or direct)
```

### Security Model

Agents can run arbitrary code in the container — they could `echo $ANTHROPIC_API_KEY` or read any config file. The proxy eliminates this risk:

- Agents only see `http://localhost:{PORT}/api/anthropic` with `API_KEY=dummy`
- Real credentials stay in MyLifeDB's process memory
- Proxy routes are bound to the same server — no extra port to expose

**Proxy authentication:** The server binds to `0.0.0.0` by default, so proxy routes are network-reachable. To prevent unauthorized use:

- On startup, the server generates a random bearer token (in-memory, never written to disk)
- The token is passed to agent CLIs via env var (`MLD_PROXY_TOKEN`) when spawning them
- Every proxy request must include `Authorization: Bearer <token>` — the proxy validates before forwarding
- The token is ephemeral (regenerated on every restart) and scoped to the process tree

This means even if someone discovers the proxy routes, they can't use them without the token. And since the token is an env var on the agent process (which runs user code anyway), there's no additional exposure — the user could already see any env var the agent has.

### Quota Handling

Quota management is handled by the upstream provider (LiteLLM). MyLifeDB only needs to handle responses:

- **Normal response** → stream back to agent untouched
- **429 quota exceeded** → the SDK wraps this as `ErrQuotaExceeded`, features surface it to the user (e.g., banner: "Usage limit reached")

### Deployment Modes

| Mode | Behavior |
|------|----------|
| **Cloud** | MyLifeDB manages provider keys in its config. LiteLLM manages quotas. Pre-configured. Zero user setup. |
| **Self-hosted (proxy mode)** | Users configure their own provider keys in settings UI. Agents route through the proxy. |
| **Self-hosted (direct mode)** | Users bypass the proxy entirely. Agents use their own auth (e.g., `claude login`). SDK does not set `BASE_URL` env vars. |

### Credential Priority

When spawning an agent, the SDK applies env vars in this order:

```
1. Per-call SessionConfig.Env (highest priority — overrides everything)
2. Client defaults.Env (set at startup from LLM layer config)
3. System environment (lowest — agent's own auth, e.g., claude login)
```

Cloud mode: defaults.Env points at the local proxy. Agents always go through it.
Self-hosted direct mode: defaults.Env is empty. Agents fall through to their own auth.

### Direct LLM Access for Features

Simple features (e.g., Summarize) that don't need a full agent can call the LLM layer directly — it's just an HTTP endpoint on the same server. The SDK provides a convenience method:

```go
// Complete sends a simple prompt to the LLM proxy directly (no agent CLI).
// Provider selects which proxy route to use: "anthropic" → /api/anthropic/*,
// "openai" → /api/openai/*. No model-name inference — caller specifies explicitly.
func (c *Client) Complete(ctx context.Context, provider string, prompt string, model string) (string, Usage, error)
```

This avoids spawning a CLI process for tasks that don't need tool use or agentic reasoning.

## Server Integration

The SDK replaces two existing server components:

```go
// server/server.go
type Server struct {
    cfg *Config

    // Components (owned by server)
    database     *db.DB
    fsService    *fs.Service
    digestWorker *digest.Worker
    notifService *notifications.Service
    agentClient  *agent.Client  // replaces claudeManager + agent

    // ...
}
```

**Initialization order** (inside `server.New()`):
1. Database, notifications, FS service, digest worker (unchanged)
2. Register LLM proxy routes on Gin router
3. Register agent configs (binary paths for claude-agent-acp, codex, etc.)
4. Create `agent.Client` with agent configs and default env (LLM proxy URL, proxy token)
5. Wire API handlers

**Graceful shutdown:** On server shutdown (`shutdownCtx` cancelled), call `agentClient.Shutdown(ctx)`:
- Sends `Close()` (SIGTERM) to all active processes
- Waits up to ctx deadline for graceful exit
- SIGKILL any remaining processes after deadline

**Resource limits:** The agent client enforces a maximum number of concurrent agent processes (configurable, default 5). Exceeding the limit returns a clear error ("too many active sessions").

## Features

Features define WHAT to do. The agent handles HOW.

### Chat Page (replaces Claude Code page)

The existing Claude Code page becomes an agent-agnostic **Chat page**:

- User selects which agent to use (Claude Code, Codex) via a dropdown — defaults to Claude Code.
- Session management, message rendering stay the same.
- Backend switches from the bespoke Claude Code WebSocket integration to the Unified Agent SDK.

**Data flow (cloud, interactive session):**
```
1. User opens Chat, selects "Claude Code", types a message
2. Frontend → WebSocket → Go backend
3. Backend calls agentClient.CreateSession(config)
   → spawns claude-agent-acp binary with env vars (ANTHROPIC_BASE_URL, MLD_PROXY_TOKEN)
   → establishes ACP connection (JSON-RPC over stdio)
   → ACP Initialize handshake + NewSession
4. Backend calls session.Send(prompt)
   → ACP Prompt call → agent processes → ACP callbacks stream back:
   - SessionUpdate → EventDelta/EventMessage → WebSocket → frontend
   - RequestPermission → EventPermissionRequest → permission modal
   - ReadTextFile/WriteTextFile → handled transparently by wrapper
   - EventComplete → turn finished, usage stats
   - EventError (ErrQuotaExceeded) → "Usage limit reached" banner
5. User sends follow-up → repeat from step 4
6. User closes page → session.Close() kills agent process
```

**Permission flow:** When the agent needs tool approval (`PermissionAsk` mode):
1. Agent calls ACP `RequestPermission` callback
2. Wrapper translates to `EventPermissionRequest` → WebSocket → frontend
3. Frontend renders the existing permission modal
4. User approves/denies → frontend sends `permission_response` via WebSocket → backend calls `session.RespondToPermission(requestID, allowed)` → wrapper returns ACP response
5. Agent proceeds or skips the tool call

### Inbox

Inbox processing uses `RunTask` — a one-off, background agent task:

```
1. New file appears in inbox
2. Inbox feature calls agentClient.RunTask(config) with:
   - Prompt: "Analyze this file, determine its type and destination..."
   - SystemPrompt: guidelines, folder structure rules
   - Tools: get_file, read_guideline, save_intention
   - Permissions: PermissionAuto (no user interaction)
3. Agent analyzes file, calls tools
4. Returns TaskResult with messages and usage stats
5. Inbox feature extracts intention from messages, saves to database
6. Token usage logged for the user
```

### Summarize

Simple summarization bypasses the agent layer entirely:

```
1. Feature calls agentClient.Complete(ctx, "openai", prompt, "gpt-4o-mini")
2. SDK makes a direct HTTP call to /api/openai/v1/chat/completions on the LLM proxy
3. Returns the text response and usage stats
```

No CLI process spawned. Fast and lightweight.

## API Routes

### New Routes

```
POST   /api/agent/sessions              — Create session
GET    /api/agent/sessions              — List sessions (with agent_type filter)
GET    /api/agent/sessions/:id          — Get session
DELETE /api/agent/sessions/:id          — Delete session
WS     /api/agent/sessions/:id/ws       — Bidirectional WebSocket (send/receive)
GET    /api/agent/sessions/:id/subscribe — Read-only SSE stream
GET    /api/agent/info                  — Available agents
```

### Deprecated Routes (removed after migration)

```
/api/claude/sessions/*  → replaced by /api/agent/sessions/*
```

Frontend migration is atomic — one release switches all API calls and drops old routes. Both route sets MUST NOT coexist in production, because they share the same `agent_sessions` table and the same `SessionManager` instance.

### WebSocket Protocol Migration

The new WebSocket message format uses `event.type` instead of the current Claude Code-specific format. Mapping:

| Current (client → server) | New |
|---------------------------|-----|
| `{type: "user_message", content}` | `{type: "user_message", content}` (unchanged) |
| `{type: "control_response", request_id, response, always_allow}` | `{type: "permission_response", request_id, allowed, always_allow}` |
| `{type: "control_request", request: {subtype: "interrupt"}}` | `{type: "stop"}` |
| `{type: "control_request", request: {subtype: "set_permission_mode"}}` | `{type: "set_permission_mode", mode}` |

| Current (server → client) | New |
|---------------------------|-----|
| `{type: "assistant", message}` with stream_events | `{type: "delta", delta}` (partial tokens) |
| `{type: "assistant", message}` complete | `{type: "message", message}` |
| `{type: "result", result}` | `{type: "complete", usage}` |
| `{type: "control_request", request: {subtype: "ask_user_question"}}` | `{type: "permission_request", request}` |
| `{type: "session_info", totalPages}` | `{type: "session_info", totalPages}` (unchanged) |

### Existing SessionManager — Migration Strategy

The current `claude/session_manager.go` (1600+ lines) and `claude/session.go` (1300+ lines) contain substantial complexity:

- **Page model** (bounded pages, seal thresholds, deduplication)
- **Multi-client fan-out** (multiple WebSocket connections to same session)
- **JSONL transcript watching** (historical session loading)
- **Burst page delivery on reconnect**

**Migration approach:** The new ACP-based `agent.Client` replaces the `SessionManager` for all new sessions. The `SessionManager` machinery is retired — ACP handles the agent communication protocol, and the WebSocket handler manages client fan-out and message buffering directly.

Existing historical sessions (JSONL files) are migrated to `agent_sessions` with their data in the `raw` column, accessible read-only.

This is a clean replacement, not an incremental wrap — the ACP protocol handles what `SessionManager` did for agent communication, and the remaining concerns (client fan-out, reconnect) are simpler to reimplement in the new WebSocket handler than to wrap the old code.

## Session Storage

**Decision:** Replace `claude_sessions` with a new `agent_sessions` table.

```sql
CREATE TABLE agent_sessions (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL DEFAULT '',     -- empty string when auth=none
    agent_type           TEXT NOT NULL,                -- 'claude_code', 'codex', etc.
    model                TEXT,
    title                TEXT,
    status               TEXT NOT NULL DEFAULT 'active',  -- active, completed, error
    archived_at          INTEGER,                      -- null = not archived, timestamp = archived
    permission_mode      TEXT,                         -- 'auto', 'ask', 'deny'
    always_allowed_tools TEXT,                         -- JSON array of tool names
    last_read_count      INTEGER NOT NULL DEFAULT 0,   -- for unread detection
    message_count        INTEGER NOT NULL DEFAULT 0,
    token_usage          INTEGER NOT NULL DEFAULT 0,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw                  TEXT                          -- JSON: agent-specific data (archival)
);

CREATE INDEX idx_agent_sessions_user ON agent_sessions(user_id);
CREATE INDEX idx_agent_sessions_type ON agent_sessions(agent_type);
CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);
CREATE INDEX idx_agent_sessions_archived ON agent_sessions(archived_at);
```

- **Unified columns** for features to query (title, status, agent_type, etc.)
- **Active columns preserved** — `archived_at`, `permission_mode`, `always_allowed_tools`, `last_read_count` are first-class columns because they drive active features (archive/unarchive, permission persistence, unread indicators)
- **`raw` column** preserves agent-specific data during migration and for debugging. Not queried by features in normal operation.
- **`user_id`** defaults to empty string when `MLD_AUTH_MODE=none`

### Migration Strategy

A new migration entry in `db/migrations.go`:

1. Create `agent_sessions` table
2. Copy all rows from `claude_sessions` with `agent_type = 'claude_code'`
3. Dump each original row as JSON into `raw`
4. Drop `claude_sessions`

**Rollback:** If migration fails, `claude_sessions` still exists (drop happens last). To manually rollback: recreate `claude_sessions` from `agent_sessions.raw` data.

**In-flight sessions:** The migration runs on server startup. Active WebSocket sessions will disconnect on restart — this is expected behavior (same as today when the server restarts).

## Logging & Observability

**LLM proxy logging** (Info level — always visible):
- Every proxied request: model, upstream provider, response status, latency, token count
- Quota exceeded events: user, model, upstream error details
- Proxy errors: connection failures, timeouts

**Agent lifecycle logging** (Info level):
- Session created: agent type, model, session ID
- Process spawned: PID, agent type, working directory
- Process exited: PID, exit code, duration
- Process crashed: PID, agent type, error details

**Debug level** (opt-in):
- Raw CLI stdin/stdout (for debugging adapter parsing)
- Full proxy request/response headers

## Environment Variables

### New

| Variable | Default | Description |
|----------|---------|-------------|
| MLD_LLM_ANTHROPIC_KEY | | Anthropic API key (for LLM proxy) |
| MLD_LLM_ANTHROPIC_URL | https://api.anthropic.com | Anthropic upstream URL |
| MLD_LLM_OPENAI_KEY | | OpenAI API key (for LLM proxy) |
| MLD_LLM_OPENAI_URL | https://api.openai.com | OpenAI upstream URL |
| MLD_AGENT_MAX_SESSIONS | 5 | Max concurrent agent processes |
| MLD_AGENT_DEFAULT | claude_code | Default agent type |

### Renamed

| Old | New | Notes |
|-----|-----|-------|
| MLD_INBOX_AGENT | MLD_INBOX_AI | Feature flag for inbox AI processing (costs tokens). Agents are always available — this controls whether inbox uses them. |

### Deprecated (removed after migration)

| Variable | Replaced By |
|----------|-------------|
| OPENAI_API_KEY | MLD_LLM_OPENAI_KEY |
| OPENAI_BASE_URL | MLD_LLM_OPENAI_URL |
| OPENAI_MODEL | Model selection in agent config |

## Agent Availability

### Runtime Dependencies

**Node.js** is a required dependency. Most agent ACP binaries are distributed via npm — it's the lingua franca of the agent ecosystem.

```dockerfile
# Node.js runtime
RUN apt-get install -y nodejs npm

# ACP agent binaries (bundled in Docker image)
RUN npm install -g @zed-industries/claude-agent-acp
# Future: npm install -g @openai/codex, etc.
```

Agent binaries and `claude` CLI are bundled in the Docker image. Always available — no detection logic needed.

## What Changes vs. Today

| Component | Today | After |
|-----------|-------|-------|
| Claude Code integration | Bespoke WebSocket wrapper in `backend/claude/` | ACP via `claude-agent-acp` npm binary |
| Inbox Agent | Custom agentic loop in `backend/agent/` with direct OpenAI calls | Feature calling `agentClient.RunTask()` |
| AI Summarize | Direct OpenAI API call in `backend/api/ai.go` | `agentClient.Complete()` via LLM proxy |
| Claude page UI | Hardcoded to Claude Code | Agent-agnostic with agent selector |
| API keys | Env vars / DB settings, visible in container | Secure storage in LLM Layer, never exposed |
| Adding a new agent | Build everything from scratch | `npm install -g` + register config |
| Session storage | `claude_sessions` table | `agent_sessions` table with `raw` column |
| API routes | `/api/claude/sessions/*` | `/api/agent/sessions/*` |
| OpenAI vendor client | `backend/vendors/openai.go` | Replaced by LLM proxy for all LLM calls |

## Non-Goals (for now)

- **Custom agent runtime** — We don't rebuild agentic loops. Agent CLIs + ACP are the runtime.
- **Custom per-agent adapters** — ACP standardizes the protocol. No Go adapter code per agent.
- **Multi-agent orchestration** — No chaining agents together. One agent per task/session.
- **ACP protocol extensions** — We use standard ACP. No custom JSON-RPC methods.
- **Format translation** — The LLM proxy forwards requests as-is. No Anthropic↔OpenAI format conversion.

## Decisions Log

| Question | Decision |
|----------|----------|
| Agent protocol | ACP (Agent Client Protocol) via `coder/acp-go-sdk`. No custom per-agent adapters. |
| Agent distribution | npm packages. Node.js is a required dependency. |
| Claude Code ACP | `@zed-industries/claude-agent-acp` (uses Claude Agent SDK → `claude` CLI under the hood) |
| LLM proxy binding | Same Gin server, per-protocol routes (`/api/anthropic/*`, `/api/openai/*`) |
| Proxy auth | Ephemeral bearer token generated at startup, passed to agents via env, validated per request |
| Protocol support | Both Anthropic and OpenAI formats natively — no hidden translation |
| Session storage | New `agent_sessions` table with active columns preserved + `raw` JSON column, replace old table |
| Quota model | Managed by LiteLLM; MyLifeDB handles normal + 429 responses |
| Agent availability | Agent binaries + Node.js bundled in Docker image, always available |
| Inbox AI feature | Separate feature flag (`MLD_INBOX_AI`), not tied to agent availability |
| Session migration | One-time migration, original data dumped into `raw` column. Atomic with frontend. |
| Proxy hosting | Routes on existing Gin server, no separate port or process |
| Resource limits | Max concurrent agent processes (default 5), `ErrTooManySessions` on limit |
| SDK config model | Client holds defaults (proxy URL); per-call config overrides; system env is fallback |
| `Complete()` routing | Caller specifies provider explicitly ("anthropic" or "openai"), no inference |
| SessionManager migration | Clean replacement. ACP handles agent comms; WebSocket handler reimplements client fan-out. |
