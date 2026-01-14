# Claude Code Integration

## Overview

This document describes the integration of Claude Code CLI (shell version) into MyLifeDB's web interface. The integration provides a browser-based terminal experience with multi-session support, persistent authentication, and cross-device access.

## Quick Start

```bash
# Terminal 1: Build frontend
cd frontend && npm run build

# Terminal 2: Run backend
cd backend && go run .

# Open browser
# Navigate to http://localhost:12345/claude
```

## Implementation Summary

### Backend (Go)

**Files:**
- `backend/claude/session.go` - Session data structure
- `backend/claude/manager.go` - Session lifecycle management (in-memory)
- `backend/api/claude.go` - API handlers & WebSocket

**Dependencies:**
- `github.com/creack/pty` - PTY management
- `github.com/coder/websocket` - WebSocket library
- `github.com/google/uuid` - UUID generation

### Frontend (React)

**Files:**
- `frontend/app/routes/claude.tsx` - Main page with session management
- `frontend/app/components/claude/terminal.tsx` - Terminal component
- `frontend/app/components/claude/session-list.tsx` - Session sidebar

**Dependencies:**
- `@xterm/xterm` - Terminal emulator
- `@xterm/addon-fit` - Auto-resize addon
- `@xterm/addon-web-links` - Clickable links addon

### Testing Checklist

- [ ] Open `/claude` page - should load without errors
- [ ] Click "New Session" - should spawn Claude process
- [ ] First session prompts OAuth - complete authentication
- [ ] Type in terminal - should see Claude responses
- [ ] Create second session - should use existing auth (no OAuth prompt)
- [ ] Open multiple tabs - each should show separate sessions
- [ ] Reconnect to session - should see terminal output and backlog
- [ ] Delete session - should kill process and remove from list
- [ ] Rename session - should update title in sidebar
- [ ] Server restart - all sessions should be cleared (expected behavior)

## Architecture

### Design Principles

1. **Minimal Transformation**: Act as a thin bridge between browser and Claude CLI, with no transformation of terminal I/O
2. **Process per Session**: Each session corresponds to exactly one `claude` CLI process
3. **Shared Authentication**: All processes share the user's real `~/.claude` directory for OAuth credentials
4. **Multi-tab Support**: Multiple browser tabs can connect to the same session via broadcast mechanism
5. **Session Persistence**: Keep track of active sessions for cross-device access

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser (Desktop/Mobile)                                        │
│  ┌────────┬────────┬────────┐                                  │
│  │ Tab 1  │ Tab 2  │ Tab 3  │  (xterm.js terminals)            │
│  │Session1│Session1│Session2│  (tabs can share sessions)       │
│  └────┬───┴───┬────┴───┬────┘                                  │
│       │       │        │                                        │
│       │ WebSocket (binary I/O, no transformation)              │
│       │       │        │                                        │
└───────┼───────┼────────┼────────────────────────────────────────┘
        │       │        │
        ▼       ▼        ▼
┌─────────────────────────────────────────────────────────────────┐
│ Go Backend (MyLifeDB)                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ WebSocket Handler (coder/websocket)                       │  │
│  │  - Accept connections                                     │  │
│  │  - Register client with session                           │  │
│  │  - Broadcast PTY output to all clients                    │  │
│  └────────────────┬─────────────────────────────────────────┘  │
│                   │                                             │
│  ┌────────────────▼─────────────────────────────────────────┐  │
│  │ Session Manager                                           │  │
│  │  - Create/list/delete sessions                            │  │
│  │  - Track process lifecycle                                │  │
│  │  - Manage multiple clients per session                    │  │
│  │  - Sessions stored in-memory (ephemeral)                  │  │
│  └────────────────┬─────────────────────────────────────────┘  │
│                   │                                             │
│  ┌────────────────▼─────────────────────────────────────────┐  │
│  │ PTY Manager (creack/pty)                                  │  │
│  │  - Spawn claude CLI processes                             │  │
│  │  - One PTY per session                                    │  │
│  │  - Read PTY once, broadcast to all clients                │  │
│  └────────────────┬─────────────────────────────────────────┘  │
│                   │                                             │
└───────────────────┼─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code CLI Processes                                       │
│  ┌──────────┐  ┌──────────┐                                   │
│  │ claude   │  │ claude   │                                   │
│  │(Session1)│  │(Session2)│                                   │
│  └─────┬────┘  └─────┬────┘                                   │
│        │             │                                         │
│        └─────────────┘                                         │
│                │                                                │
│                ▼                                                │
│        ┌───────────────┐                                       │
│        │  ~/.claude/   │                                       │
│        │  (Shared auth)│                                       │
│        └───────────────┘                                       │
└─────────────────────────────────────────────────────────────────┘
```

## Claude Authentication Directory Setup

### Simplified Approach

All Claude Code processes share the user's real `~/.claude` directory:

**Benefits**:
- Simple - no symlinks or temp directories needed
- All sessions share authentication automatically
- Works identically on OS and in Docker
- Respects user's existing Claude configuration

**How it works**:
1. Backend spawns `claude` process with default HOME environment
2. Claude uses `~/.claude` for credentials and settings
3. First session authenticates via OAuth (if needed)
4. Subsequent sessions use existing credentials ✅

**Data locations**:
```
~/.claude/                                   # Claude's auth directory
├── .credentials.json                        # OAuth tokens (shared by all sessions)
├── settings.local.json                      # User settings
└── projects/                                # Project conversation history

# Sessions are stored in-memory only (ephemeral)
# When the backend restarts, all sessions are lost
```

## Session Management

### Session Lifecycle

1. **Creation**: User creates new session → backend spawns new `claude` process → session record created
2. **Active**: WebSocket(s) connected, terminal I/O streaming, process running
3. **Multi-tab**: Multiple tabs can connect to same session via broadcast mechanism
4. **Disconnected**: Browser closed, WebSocket disconnected, but process keeps running
5. **Reconnection**: User opens browser (same/different device) → list sessions → reconnect to existing process
6. **Cleanup**: User explicitly closes session → backend kills process → session record deleted

### Multi-tab Session Sharing

Multiple browser tabs can connect to the same Claude Code session:

**How it works**:
- Each session maintains a list of connected WebSocket clients
- PTY output is read once and broadcast to all clients via channels
- Any client can send input (keyboard/commands) to the PTY
- All clients see the same terminal state in real-time

**Behavior**:
- Like `screen` or `tmux` session sharing
- Tab 1 types command → all tabs see output
- Tab 2 types command → all tabs see output
- Close Tab 1 → Tab 2 continues working
- Reopen Tab 1 → reconnects to same session, sees current state

### Session Storage

Sessions are stored **in-memory only** (ephemeral). When the backend restarts, all sessions are lost and PTY processes are terminated.

Session structure (in-memory):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "processId": 12345,
  "workingDir": "/Users/user/projects/my-project",
  "createdAt": "2026-01-13T10:30:00Z",
  "lastActivity": "2026-01-13T12:45:00Z",
  "status": "active",
  "title": "Session 1",
  "clients": 2
}
```

**Fields**:
- `id`: UUID for the session
- `processId`: OS process ID of the `claude` CLI process
- `workingDir`: Working directory where Claude is running
- `createdAt`: Session creation timestamp
- `lastActivity`: Last I/O activity timestamp
- `status`: `active` (has clients), `disconnected` (process running, no clients), `dead` (process exited)
- `title`: User-editable session name/title
- `clients`: Number of connected WebSocket clients

### Database Schema (SQLite)

Alternative to JSON files, can use SQLite table:

```sql
CREATE TABLE claude_sessions (
    id TEXT PRIMARY KEY,
    process_id INTEGER NOT NULL,
    working_dir TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_activity TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    output_buffer TEXT -- JSON array of strings
);

CREATE INDEX idx_claude_sessions_status ON claude_sessions(status);
CREATE INDEX idx_claude_sessions_last_activity ON claude_sessions(last_activity);
```

## API Design

### REST Endpoints

#### List Sessions
```
GET /api/claude/sessions

Response:
{
  "sessions": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "title": "Session 1",
      "workingDir": "/path/to/project",
      "status": "active",
      "createdAt": "2026-01-13T10:30:00Z",
      "lastActivity": "2026-01-13T12:45:00Z"
    }
  ]
}
```

#### Create Session
```
POST /api/claude/sessions

Request:
{
  "workingDir": "/path/to/project",  // optional, defaults to MY_DATA_DIR
  "title": "My Session"              // optional
}

Response:
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "My Session",
  "workingDir": "/path/to/project",
  "status": "active",
  "createdAt": "2026-01-13T10:30:00Z"
}
```

#### Get Session Details
```
GET /api/claude/sessions/:id

Response:
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Session 1",
  "workingDir": "/path/to/project",
  "status": "active",
  "createdAt": "2026-01-13T10:30:00Z",
  "lastActivity": "2026-01-13T12:45:00Z",
  "processId": 12345,
  "outputBuffer": ["...", "last", "lines"]
}
```

#### Update Session
```
PATCH /api/claude/sessions/:id

Request:
{
  "title": "New Title"
}

Response:
{
  "success": true
}
```

#### Delete Session
```
DELETE /api/claude/sessions/:id

Response:
{
  "success": true
}

Side effect: Kills the Claude Code process
```

#### Resize Terminal
```
POST /api/claude/sessions/:id/resize

Request:
{
  "cols": 120,
  "rows": 40
}

Response:
{
  "success": true
}
```

### WebSocket Endpoint

```
WS /api/claude/sessions/:id/ws

Protocol:
- Binary frames: terminal input/output (raw bytes, no transformation)
- Text frames: control messages (JSON)

Control messages:
- {"type": "resize", "cols": 120, "rows": 40}
- {"type": "ping"}
- {"type": "pong"}
```

## Frontend Implementation

### Tech Stack

- **xterm.js**: Terminal emulator
- **xterm-addon-fit**: Auto-resize to container
- **xterm-addon-web-links**: Clickable URLs in terminal

### Component Structure

```
frontend/app/
├── routes/
│   └── claude.tsx                   # Main Claude Code page
├── components/
│   ├── claude/
│   │   ├── tab-manager.tsx          # Tab management UI
│   │   ├── terminal.tsx             # Single terminal instance
│   │   ├── session-list.tsx         # Session list sidebar
│   │   └── session-menu.tsx         # Session context menu
│   └── ui/                          # shadcn components
└── hooks/
    └── use-claude-session.ts        # Session WebSocket hook
```

### Tab Manager Component

```tsx
// Manages multiple terminal tabs
<TabManager>
  <TabList>
    <Tab id="session-1">Session 1</Tab>
    <Tab id="session-2">Session 2</Tab>
    <TabNewButton onClick={createSession} />
  </TabList>

  <TabPanel id="session-1">
    <ClaudeTerminal sessionId="session-1" />
  </TabPanel>

  <TabPanel id="session-2">
    <ClaudeTerminal sessionId="session-2" />
  </TabPanel>
</TabManager>
```

### Terminal Component

```tsx
// Single terminal instance
const ClaudeTerminal = ({ sessionId }) => {
  const terminalRef = useRef(null)
  const { socket, status } = useClaudeSession(sessionId)

  useEffect(() => {
    const terminal = new Terminal({
      theme: getTheme(), // Match MyLifeDB theme
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace'
    })

    terminal.loadAddon(new FitAddon())
    terminal.loadAddon(new WebLinksAddon())

    terminal.open(terminalRef.current)

    // Bidirectional I/O (no transformation)
    terminal.onData(data => socket.send(data))
    socket.onmessage = (event) => {
      terminal.write(event.data)
    }

    return () => terminal.dispose()
  }, [sessionId])

  return (
    <div ref={terminalRef} className="h-full w-full" />
  )
}
```

### Session Hook

```tsx
const useClaudeSession = (sessionId: string) => {
  const [socket, setSocket] = useState<WebSocket | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')

  useEffect(() => {
    const ws = new WebSocket(`ws://localhost:12345/api/claude/sessions/${sessionId}/ws`)

    ws.onopen = () => setStatus('connected')
    ws.onclose = () => setStatus('disconnected')
    ws.onerror = () => setStatus('disconnected')

    setSocket(ws)

    return () => ws.close()
  }, [sessionId])

  return { socket, status }
}
```

## Backend Implementation

### Directory Structure

```
backend/
├── claude/
│   ├── session.go          # Session struct and management
│   ├── manager.go          # Session manager (CRUD operations)
│   ├── pty.go              # PTY spawning and I/O
│   └── storage.go          # Session persistence
└── api/
    └── claude.go           # HTTP and WebSocket handlers
```

### Session Manager

```go
package claude

import (
    "os/exec"
    "github.com/creack/pty"
    "github.com/google/uuid"
)

type Client struct {
    Conn *websocket.Conn
    Send chan []byte
}

type Session struct {
    ID           string
    ProcessID    int
    WorkingDir   string
    CreatedAt    time.Time
    LastActivity time.Time
    Status       string
    Title        string
    PTY          *os.File
    Cmd          *exec.Cmd
    Clients      map[*Client]bool
    mu           sync.RWMutex
    broadcast    chan []byte
}

type Manager struct {
    sessions map[string]*Session
    mu       sync.RWMutex
    storage  Storage
}

func (m *Manager) CreateSession(workingDir, title string) (*Session, error) {
    sessionID := uuid.New().String()

    session := &Session{
        ID:         sessionID,
        WorkingDir: workingDir,
        Title:      title,
        CreatedAt:  time.Now(),
        Status:     "active",
        Clients:    make(map[*Client]bool),
        broadcast:  make(chan []byte, 256),
    }

    // Spawn claude process with PTY
    // Uses default HOME so all sessions share the same .claude directory
    cmd := exec.Command("claude")
    cmd.Dir = workingDir

    ptmx, err := pty.Start(cmd)
    if err != nil {
        return nil, err
    }

    session.PTY = ptmx
    session.Cmd = cmd
    session.ProcessID = cmd.Process.Pid

    // Start PTY reader that broadcasts to all clients
    go m.readPTY(session)

    m.mu.Lock()
    m.sessions[session.ID] = session
    m.mu.Unlock()

    // Save to storage
    m.storage.SaveSession(session)

    return session, nil
}

func (m *Manager) readPTY(session *Session) {
    buf := make([]byte, 4096)
    for {
        n, err := session.PTY.Read(buf)
        if err != nil {
            session.Status = "dead"
            return
        }

        // Make a copy and broadcast to all connected clients
        data := make([]byte, n)
        copy(data, buf[:n])
        session.Broadcast(data)
        session.LastActivity = time.Now()
    }
}

func (m *Manager) GetSession(id string) (*Session, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    session, ok := m.sessions[id]
    if !ok {
        return nil, ErrSessionNotFound
    }
    return session, nil
}

func (m *Manager) ListSessions() []*Session {
    m.mu.RLock()
    defer m.mu.RUnlock()

    sessions := make([]*Session, 0, len(m.sessions))
    for _, s := range m.sessions {
        sessions = append(sessions, s)
    }
    return sessions
}

func (m *Manager) DeleteSession(id string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    session, ok := m.sessions[id]
    if !ok {
        return ErrSessionNotFound
    }

    // Kill the process
    if session.Cmd != nil && session.Cmd.Process != nil {
        session.Cmd.Process.Kill()
    }

    // Close PTY
    if session.PTY != nil {
        session.PTY.Close()
    }

    delete(m.sessions, id)

    // Remove from storage
    m.storage.DeleteSession(id)

    return nil
}
```

### WebSocket Handler

```go
package api

import (
    "context"
    "io"
    "net/http"
    "time"

    "github.com/gin-gonic/gin"
    "nhooyr.io/websocket"
)

func ClaudeWebSocket(c *gin.Context) {
    sessionID := c.Param("id")

    session, err := claudeManager.GetSession(sessionID)
    if err != nil {
        c.JSON(404, gin.H{"error": "Session not found"})
        return
    }

    // Get underlying http.ResponseWriter from Gin's wrapper
    var w http.ResponseWriter = c.Writer
    if unwrapper, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
        w = unwrapper.Unwrap()
    }

    // Accept WebSocket connection (coder/websocket)
    conn, err := websocket.Accept(w, c.Request, &websocket.AcceptOptions{
        InsecureSkipVerify: true, // Skip origin check - auth is handled at higher layer
    })
    if err != nil {
        log.Error().Err(err).Msg("WebSocket upgrade failed")
        return
    }
    defer conn.Close(websocket.StatusNormalClosure, "")

    ctx := c.Request.Context()

    // Create a new client and register it with the session
    client := &claude.Client{
        Conn: conn,
        Send: make(chan []byte, 256),
    }
    session.AddClient(client)
    defer session.RemoveClient(client)

    // Goroutine to send data from client.Send channel to WebSocket
    go func() {
        for data := range client.Send {
            if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
                return
            }
        }
    }()

    // WebSocket → PTY (read from browser, send to claude process)
    for {
        msgType, msg, err := conn.Read(ctx)
        if err != nil {
            break
        }

        // Only handle binary messages (terminal I/O)
        if msgType != websocket.MessageBinary {
            continue
        }

        if _, err := session.PTY.Write(msg); err != nil {
            break
        }

        session.LastActivity = time.Now()
    }
}
```

## Authentication Flow

### Initial Authentication

1. User opens first Claude Code tab
2. Backend spawns `claude` process (which checks `~/.claude` for credentials)
3. If not authenticated:
   - Claude CLI displays OAuth URL in terminal
   - User clicks URL, completes OAuth in browser
   - Claude saves credentials to `~/.claude/.credentials.json`
4. If already authenticated:
   - Claude CLI starts immediately with existing credentials

### Subsequent Sessions

1. User opens second/third/nth tab
2. Backend spawns another `claude` process
3. Process reads existing credentials from `~/.claude`
4. No re-authentication needed ✅

### Cross-Device Sessions

1. User opens MyLifeDB on mobile
2. Frontend calls `GET /api/claude/sessions` → sees 4 existing sessions
3. User taps a session → opens terminal, connects WebSocket
4. Backend routes WebSocket to existing process
5. Terminal shows buffered output + new output ✅

## Configuration

### Environment Variables

```bash
# Claude CLI binary path (default: looks in $PATH)
CLAUDE_CLI_PATH=/usr/local/bin/claude

# Maximum concurrent sessions (default: 10)
CLAUDE_MAX_SESSIONS=10

# Session timeout for inactive sessions (default: 24h)
CLAUDE_SESSION_TIMEOUT=24h

# Output buffer size per session (default: 1000 lines)
CLAUDE_OUTPUT_BUFFER_SIZE=1000
```

### Settings in MyLifeDB

Store in `settings` table:

```sql
INSERT INTO settings (key, value) VALUES
  ('claude_enabled', 'true'),
  ('claude_max_sessions', '10'),
  ('claude_session_timeout', '24h'),
  ('claude_default_working_dir', '/path/to/projects');
```

## Security Considerations

### WebSocket Authentication

Use existing MyLifeDB session authentication:

```go
func ClaudeWebSocket(c *gin.Context) {
    // Verify user is authenticated
    sessionCookie, err := c.Cookie("session")
    if err != nil || !auth.ValidateSession(sessionCookie) {
        c.JSON(401, gin.H{"error": "Unauthorized"})
        return
    }

    // ... rest of handler
}
```

### Process Isolation

Each Claude Code process runs with the same user/permissions as the MyLifeDB backend. This means:
- Claude can access any files the backend user can access
- Claude can modify MY_DATA_DIR
- Claude inherits backend's file permissions

**Recommendation**: Run MyLifeDB backend with appropriate user permissions (not root).

### Resource Limits

Prevent resource exhaustion:

```go
// Limit concurrent sessions
const MaxSessions = 10

func (m *Manager) CreateSession(...) error {
    if len(m.sessions) >= MaxSessions {
        return ErrTooManySessions
    }
    // ...
}

// Set CPU/memory limits per process (Linux)
cmd.SysProcAttr = &syscall.SysProcAttr{
    Setpgid: true,
}
// Use cgroups or ulimit for resource limits
```

## Monitoring and Cleanup

### Health Checks

Periodically check if processes are still alive:

```go
func (m *Manager) HealthCheck() {
    m.mu.Lock()
    defer m.mu.Unlock()

    for id, session := range m.sessions {
        if session.Cmd.ProcessState != nil && session.Cmd.ProcessState.Exited() {
            session.Status = "dead"
            m.storage.SaveSession(session)

            // Optionally delete dead sessions
            delete(m.sessions, id)
            m.storage.DeleteSession(id)
        }
    }
}
```

### Inactive Session Cleanup

Delete sessions that haven't been active for 24+ hours:

```go
func (m *Manager) CleanupInactive(timeout time.Duration) {
    m.mu.Lock()
    defer m.mu.Unlock()

    now := time.Now()
    for id, session := range m.sessions {
        if now.Sub(session.LastActivity) > timeout {
            log.Info().Str("sessionId", id).Msg("Cleaning up inactive session")
            session.Cmd.Process.Kill()
            session.PTY.Close()
            delete(m.sessions, id)
            m.storage.DeleteSession(id)
        }
    }
}
```

Run cleanup in background goroutine:

```go
func (m *Manager) StartCleanupWorker() {
    ticker := time.NewTicker(1 * time.Hour)
    go func() {
        for range ticker.C {
            m.HealthCheck()
            m.CleanupInactive(24 * time.Hour)
        }
    }()
}
```

## Troubleshooting

### "claude: command not found"
Install Claude Code CLI: `brew install claude` or download from https://claude.ai/code

### WebSocket connection fails
Check that backend is running and port 12345 is accessible. Check browser console for errors.

### Sessions lost after restart
This is expected behavior. Sessions are stored in-memory only and don't persist across server restarts.

### Authentication doesn't persist
Check that `~/.claude/` directory exists and contains `.credentials.json` after first OAuth.

## Testing Strategy

### Unit Tests

- Session manager CRUD operations
- PTY spawning and cleanup
- Multi-client broadcast mechanism

### Integration Tests

- Spawn real `claude` process
- WebSocket communication
- Multi-session handling
- Reconnection after disconnect

### Manual Testing Checklist

- [ ] Create new session → Claude starts
- [ ] Type in terminal → Claude responds
- [ ] Open 4 tabs → 4 separate sessions
- [ ] Close browser → processes still running
- [ ] Reopen browser → see 4 sessions in list
- [ ] Reconnect to session → see buffered output (backlog)
- [ ] Close session → process killed
- [ ] Test on mobile device → terminal works with touch keyboard
- [ ] First-time OAuth flow in terminal
- [ ] Second session uses existing auth

## Future Enhancements

### Phase 2

- **Session sharing**: Multiple users/devices connect to same session
- **Output recording**: Save full session history for replay
- **AI integration**: Ask MyLifeDB's AI about Claude Code sessions
- **Keyboard shortcuts**: Terminal shortcuts in web UI

### Phase 3

- **Collaborative editing**: Multiple users in same Claude session
- **Session templates**: Pre-configured working directories
- **Resource monitoring**: CPU/memory per session
- **Advanced permissions**: Limit what Claude can access per session

## References

- [Claude Code Documentation](https://code.claude.com/docs)
- [xterm.js Documentation](https://xtermjs.org/)
- [creack/pty - Go PTY library](https://github.com/creack/pty)
- [Gorilla WebSocket](https://github.com/gorilla/websocket)
- [Managing Multiple Claude Code Sessions](https://blog.gitbutler.com/parallel-claude-code)
- [How to run Claude Code in parallel](https://ona.com/stories/parallelize-claude-code)
