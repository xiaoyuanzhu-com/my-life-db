# Claude Code Integration - Implementation Summary

## ✅ Status: Ready to Test

All backend and frontend code has been implemented and builds successfully.

## Quick Start

```bash
# Terminal 1: Build frontend
cd frontend && npm run build

# Terminal 2: Run backend
cd backend && go run .

# Open browser
# Navigate to http://localhost:12345/claude
```

## What Was Built

### Backend (Go)

**New Files:**
- `backend/claude/session.go` - Session data structure
- `backend/claude/manager.go` - Session lifecycle management (184 lines)
- `backend/claude/storage.go` - Session persistence (74 lines)
- `backend/api/claude.go` - API handlers & WebSocket (207 lines)

**Modified Files:**
- `backend/api/routes.go` - Added 7 new API routes
- `backend/main.go` - Initialize Claude manager on startup

**Dependencies Added:**
- `github.com/creack/pty` - PTY management
- `nhooyr.io/websocket` - WebSocket (coder/websocket)
- `github.com/google/uuid` - UUID generation

### Frontend (React)

**New Files:**
- `frontend/app/routes/claude.tsx` - Main page (145 lines)
- `frontend/app/components/claude/terminal.tsx` - Terminal component (132 lines)
- `frontend/app/components/claude/session-list.tsx` - Session sidebar (132 lines)

**Dependencies Added:**
- `@xterm/xterm` - Terminal emulator
- `@xterm/addon-fit` - Auto-resize addon
- `@xterm/addon-web-links` - Clickable links addon

## Architecture Highlights

### 1. Symlink Approach for Shared Auth

Each session gets a temporary HOME directory with `.claude` symlinked to the shared location:

```
/tmp/mylifedb-claude/{session-id}/
└── .claude -> MY_DATA_DIR/app/my-life-db/.claude/
```

This allows all sessions to share OAuth credentials while keeping Claude's data isolated.

### 2. Minimal Transformation

- Backend is a thin PTY bridge - no transformation of terminal I/O
- WebSocket streams raw binary data between browser and Claude process
- xterm.js provides full terminal emulation in the browser

### 3. Cross-Device Session Persistence

- Sessions tracked in `MY_DATA_DIR/app/my-life-db/claude-sessions/`
- Close browser on desktop → sessions stay alive
- Open on mobile → see all sessions, reconnect to any

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/claude/sessions` | List all sessions |
| POST | `/api/claude/sessions` | Create new session |
| GET | `/api/claude/sessions/:id` | Get session details |
| PATCH | `/api/claude/sessions/:id` | Update session title |
| DELETE | `/api/claude/sessions/:id` | Delete session |
| WS | `/api/claude/sessions/:id/ws` | WebSocket terminal I/O |
| POST | `/api/claude/sessions/:id/resize` | Resize terminal |

## Testing Checklist

- [ ] Open `/claude` page - should load without errors
- [ ] Click "New Session" - should spawn Claude process
- [ ] First session prompts OAuth - complete authentication
- [ ] Type in terminal - should see Claude responses
- [ ] Create second session - should use existing auth (no OAuth prompt)
- [ ] Open multiple tabs - each should show separate sessions
- [ ] Close browser, reopen - should see all sessions in list
- [ ] Reconnect to session - should see terminal output
- [ ] Delete session - should kill process and remove from list
- [ ] Rename session - should update title in sidebar
- [ ] Resize window - terminal should auto-resize

## Directory Structure

```
MY_DATA_DIR/
├── app/
│   └── my-life-db/
│       ├── .claude/                    # Shared Claude auth (symlinked)
│       │   ├── .credentials.json
│       │   └── settings.local.json
│       ├── claude-sessions/            # Session tracking
│       │   ├── {uuid-1}.json
│       │   └── {uuid-2}.json
│       └── database.sqlite

/tmp/mylifedb-claude/
├── {session-1-uuid}/                   # Temp HOME
│   └── .claude -> MY_DATA_DIR/...      # Symlink
└── {session-2-uuid}/                   # Temp HOME
    └── .claude -> MY_DATA_DIR/...      # Symlink
```

## Known Limitations

1. **Session restoration**: Currently, when the backend restarts, all PTY connections are lost. Sessions in the list become stale. Future: Implement session cleanup on startup.

2. **Terminal resize**: The resize endpoint is a placeholder. Need to implement actual PTY resize using `github.com/creack/pty.Setsize()`.

3. **Output buffering**: Currently no buffering of terminal output for reconnection. When you reconnect, you start from the current state.

4. **Max sessions**: Hardcoded limit of 10 sessions. Can be made configurable.

## Future Enhancements

- [ ] Session restoration on backend restart
- [ ] Output buffering for reconnection history
- [ ] Terminal themes (match MyLifeDB dark/light mode)
- [ ] Keyboard shortcuts in UI
- [ ] Session sharing (multiple users in same session)
- [ ] Terminal recording/replay
- [ ] Resource monitoring per session

## Troubleshooting

### "claude: command not found"
Install Claude Code CLI: `brew install claude` or download from https://claude.ai/code

### WebSocket connection fails
Check that backend is running and port 12345 is accessible. Check browser console for errors.

### Sessions don't persist
Check that `MY_DATA_DIR/app/my-life-db/claude-sessions/` directory exists and is writable.

### Authentication doesn't persist
Check that `MY_DATA_DIR/app/my-life-db/.claude/` directory exists and contains `.credentials.json` after first OAuth.

## Documentation

See [docs/claude-code.md](./claude-code.md) for complete technical documentation including:
- Detailed architecture diagrams
- Full code examples
- Security considerations
- Monitoring and cleanup strategies
