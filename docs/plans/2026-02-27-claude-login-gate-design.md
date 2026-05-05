# Claude Code Login Gate

Gate the new-session page behind Claude Code authentication. If the server detects Claude CLI is not logged in at startup, show a scoped login terminal instead of the normal session UI.

## Backend

### Startup Auth Check

In `server.New()`, after component initialization, run `claude auth status` (exit 0 = logged in, 1 = not). Store as `claudeLoggedIn bool` on `Server`. Checked once at startup, cached for the server lifetime.

New public endpoint (no auth middleware):

```
GET /api/claude/auth-status → { "loggedIn": true/false }
```

### Login WebSocket

New endpoint:

```
WS /api/claude-login/ws
```

On connect:
1. Spawn `claude auth login` in a PTY (`os/exec` + `github.com/creack/pty`)
2. Pipe PTY stdout → WebSocket, WebSocket → PTY stdin
3. On process exit, send final status message, close WebSocket
4. On WebSocket close, kill PTY

**Security:** Only spawns `claude auth login` — not a shell. Process exit = connection end. No lingering access.

### Updating Cached Status

On successful login (process exits 0), update the cached `claudeLoggedIn` to `true` so subsequent calls to `/api/claude/auth-status` reflect the new state without restart.

## Frontend

### Conditional Rendering (New Session Page)

On mount, call `GET /api/claude/auth-status`.

- **Logged in** → render normal new-session UI. xterm.js not loaded.
- **Not logged in** → render login card with embedded terminal.

### Login Card UI

```
┌─────────────────────────────────────────────┐
│  Claude Code Login                          │
│  Claude Code is not authenticated.          │
│  Complete the login below to continue.      │
│  ┌───────────────────────────────────────┐  │
│  │  (xterm.js terminal, ~80x10)         │  │
│  │  claude auth login output here       │  │
│  └───────────────────────────────────────┘  │
│  [ Continue ] ← appears after CLI exits     │
└─────────────────────────────────────────────┘
```

### Lazy Loading

xterm.js loaded via `React.lazy()` + `Suspense`. Only fetched when the login card renders. Already-logged-in users never download it.

### Post-Login Flow

After CLI process exits successfully, show "Continue" button. Clicking it re-fetches `/api/claude/auth-status` (now returns `true`) and the normal session UI renders.

## Files Changed

**Backend:**
- `backend/server/server.go` — add `claudeLoggedIn` field, startup check
- `backend/api/routes.go` — register new endpoints
- New file: `backend/api/claude_login.go` — auth-status handler + login WebSocket handler

**Frontend:**
- New file: `frontend/app/components/claude-login-terminal.tsx` — lazy-loaded xterm.js terminal
- Modified: new-session page component — conditional render based on auth status

**Dependencies:**
- `github.com/creack/pty` (Go, for PTY spawning) — check if already present
