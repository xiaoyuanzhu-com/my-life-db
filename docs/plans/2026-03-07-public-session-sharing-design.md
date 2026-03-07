# Public Session Sharing Design

**Date:** 2026-03-07

Share Claude Code sessions publicly via a link. Viewers see the same live chat UI (messages only, no sidebar) without authentication. Works for both self-hosted and cloud-hosted deployments.

## Data Model

Extend `claude_sessions` with two nullable columns:

```sql
ALTER TABLE claude_sessions ADD COLUMN share_token TEXT;
ALTER TABLE claude_sessions ADD COLUMN shared_at INTEGER;
CREATE UNIQUE INDEX idx_claude_sessions_share_token ON claude_sessions(share_token);
```

- `share_token` — UUIDv4. Non-null means shared.
- `shared_at` — epoch ms when shared.
- Unsharing sets both to `NULL`.

## URL

```
/share/<uuid>
```

Same path for self-hosted and cloud. No username in the URL.

UUID collision is not a concern — UUIDv4 has 122 random bits. Even with 1M shared sessions the collision probability is ~1 in 10^31.

## API

### Authenticated (existing auth middleware)

| Method | Path | Action |
|--------|------|--------|
| `POST` | `/api/claude/sessions/:id/share` | Generate share_token, return `{ shareToken, shareUrl }` |
| `DELETE` | `/api/claude/sessions/:id/share` | Null out share_token + shared_at, return 204 |

### Public (no auth)

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/api/share/:token` | Session metadata (title, project, timestamps) |
| `GET` | `/api/share/:token/messages` | Session messages (same format as `/api/claude/sessions/:id/messages`) |
| `GET` | `/api/share/:token/subscribe` | WebSocket — read-only live updates |

Public endpoints validate the share token against the DB. Invalid or revoked tokens return 404.

## Backend

### Share flow

1. `POST /api/claude/sessions/:id/share`
2. Generate UUIDv4
3. Upsert into `claude_sessions`: set `share_token` + `shared_at`
4. If `MLD_SHARE_GATEWAY_URL` is set (cloud mode), register token with gateway: `POST <gateway>/api/shares { token, username }`
5. Return `{ shareToken: "abc-123", shareUrl: "/share/abc-123" }`

### Unshare flow

1. `DELETE /api/claude/sessions/:id/share`
2. Set `share_token = NULL, shared_at = NULL`
3. If `MLD_SHARE_GATEWAY_URL` is set, deregister: `DELETE <gateway>/api/shares/:token`
4. Return 204

### Public access flow

1. Request hits `/api/share/:token`
2. Query `claude_sessions WHERE share_token = ?` to get `session_id`
3. If not found, return 404
4. Use existing `ReadSessionWithSubagents(sessionId, projectPath)` to serve messages
5. WebSocket subscribe reuses existing `SessionManager` event system, filtered to the resolved session

### DB functions (in `db/claude_sessions.go`)

```go
func ShareClaudeSession(sessionID, shareToken string) error
func UnshareClaudeSession(sessionID string) error
func GetClaudeSessionByShareToken(shareToken string) (*ClaudeSession, error)
func GetShareToken(sessionID string) (string, error)  // returns "" if not shared
```

## Frontend

### Share page: `/share/:token`

New route: `frontend/app/routes/share.tsx`

- Renders only the message/chat area — no session list sidebar, no input box, no permission modal, no todo panel.
- Reuses existing message rendering components.
- Connects to `/api/share/:token/subscribe` WebSocket for live updates.
- Shows session title at the top.
- Read-only presentation.

### Share controls in session UI

Add share action to the session header/menu (alongside archive/delete):

- **Not shared:** "Share" button → calls `POST /api/claude/sessions/:id/share` → shows URL with copy button.
- **Already shared:** Shows link with copy button + "Unshare" button → calls `DELETE`, removes link.

The share status should be included in the session metadata response (`GET /api/claude/sessions/:id`) so the UI knows whether a session is currently shared.

## Routing

### Self-hosted

- `/share/:token` is a public Gin route (no auth middleware).
- SPA catch-all serves `index.html` for `/share/*`; React Router handles client-side routing.
- The instance resolves the share token from its own SQLite DB.

### Cloud-hosted

The gateway at `my.xiaoyuanzhu.com` needs to route `/share/:token` requests to the correct user's instance without authentication.

**Gateway requirements:**

- Small lookup store: `share_token → username`
- Registration endpoint: `POST /api/shares { token, username }` (called by instances on share)
- Deregistration endpoint: `DELETE /api/shares/:token` (called by instances on unshare)
- Routing: `/share/:token` → look up username → proxy to internal instance URL

**Instance integration:**

- Controlled by `MLD_SHARE_GATEWAY_URL` env var.
- When set, the instance calls the gateway on share/unshare.
- When unset (self-hosted), no gateway calls — everything is local.

## Security

- **Read-only:** Share endpoints expose only session messages. No write operations, no session mutation.
- **Separate token:** Share token is decoupled from session ID. Leaking the share URL does not expose internal identifiers or authenticated API paths.
- **Raw files excluded:** `/raw/*` remains behind auth. Shared sessions display message text but embedded file references (images, generated HTML) won't load. This is an intentional v1 limitation — scoped raw file access can be added later.
- **WebSocket is read-only:** Shared subscribe connections receive events but cannot send commands.
- **Revocable:** Unsharing immediately invalidates the token. Subsequent requests return 404.

## Migration

New migration file: `migration_013_share_sessions.go` (or next available number).

Adds `share_token` and `shared_at` columns with a unique index. No data migration needed — all existing sessions start as unshared (NULL values).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MLD_SHARE_GATEWAY_URL` | _(empty)_ | Gateway URL for cloud share registration. Unset for self-hosted. |
