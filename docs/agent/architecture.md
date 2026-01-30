# Architecture Overview

This document is the entry point for agents working on the MyLifeDB codebase. It describes the overall system design and points to component-specific documentation.

## System Overview

MyLifeDB is a filesystem-based personal knowledge management system:
- **Backend**: Go HTTP server (Gin) with SQLite
- **Frontend**: React SPA (React Router 7 + Vite)

The backend is the system's core - it provides APIs, runs background workers, manages real-time notifications, and serves the frontend.

## Server-Centric Architecture

All stateful components are owned by a single `Server` struct (`backend/server/server.go`). This is the foundational pattern of the codebase.

```
Server
├── database (*db.DB)           # SQLite database
├── notifService                # SSE event broadcasting
├── fsService                   # Filesystem watching/scanning
├── digestWorker                # Background file processing
├── router (*gin.Engine)        # HTTP routes
└── shutdownCtx                 # Graceful shutdown signaling
```

### Why This Matters

- **No global singletons** (except logging) - all state lives in Server
- **Explicit dependencies** - components receive deps via constructors
- **Clear lifecycle** - Server controls init order and shutdown
- **Safe to modify** - you know where all state lives

### Initialization Order

Components must be initialized in this order (dependencies flow downward):

1. **Database** - foundation, no dependencies
2. **Notifications Service** - pub/sub, depends on nothing
3. **FS Service** - depends on database (via DBAdapter)
4. **Digest Worker** - depends on database + notifications
5. **Event Handler Wiring** - connect components via callbacks
6. **HTTP Router** - setup routes (deferred to avoid import cycles)

### Component Access Pattern

API handlers access components through the server reference:

```go
// backend/api/handlers.go
type Handlers struct {
    server *server.Server
}

func (h *Handlers) SomeHandler(c *gin.Context) {
    db := h.server.DB()      // Get database
    fs := h.server.FS()      // Get filesystem service
    // ... use components
}
```

**DO**: Access components via `h.server.ComponentName()`
**DON'T**: Store component references in package-level variables

## Component Index

When working on a specific area, read the corresponding component doc:

| Area | Document | When to Read |
|------|----------|--------------|
| Claude Code integration | [components/claude-code.md](components/claude-code.md) | WebSocket, sessions, message handling, permissions |
| File processing | [components/digest-system.md](components/digest-system.md) | Digesters, file metadata extraction |
| Filesystem watching | [components/fs-service.md](components/fs-service.md) | File watcher, scanner, change events |
| Real-time updates | [components/notifications.md](components/notifications.md) | SSE, event broadcasting |
| Authentication | [components/auth.md](components/auth.md) | OAuth, password auth, sessions |

## Event Flow Between Components

Components communicate via callbacks and channels, not direct method calls:

```
File created/modified
    ↓
FS Service detects change
    ↓
Calls fileChangeHandler callback
    ↓
├── Digest Worker queues file for processing
└── Notifications Service broadcasts to UI
    ↓
Digest Worker processes file
    ↓
Notifications Service broadcasts completion
    ↓
Frontend updates UI
```

### Wiring Pattern

Event handlers are wired during server initialization:

```go
// backend/server/server.go
s.fsService.SetFileChangeHandler(func(event fs.FileChangeEvent) {
    s.digestWorker.OnFileChange(event.Path, event.Type)
    s.notifService.NotifyInboxChanged()
})
```

**DO**: Wire handlers in server initialization
**DON'T**: Directly access internal channels or queues of other components

## Shutdown Coordination

Long-running handlers (WebSocket, SSE) must respect shutdown:

```go
select {
case <-h.server.ShutdownContext().Done():
    // Server is shutting down, exit gracefully
    return
case <-clientGone:
    // Client disconnected
    return
case msg := <-messages:
    // Handle message
}
```

Shutdown order is reverse of initialization - HTTP server stops first, then workers, then database.

## Adding New API Endpoints

1. Add handler method to `backend/api/handlers.go` or a new file
2. Register route in `backend/api/routes.go`
3. Access components via `h.server.ComponentName()`

```go
// handlers.go
func (h *Handlers) MyNewHandler(c *gin.Context) {
    db := h.server.DB()
    // ... implementation
}

// routes.go
api.GET("/my-endpoint", h.MyNewHandler)
```

## Adding New Background Workers

1. Create worker struct in `backend/workers/yourworker/`
2. Add field to Server struct
3. Initialize in `server.New()` after its dependencies
4. Wire event handlers if needed
5. Stop in `server.Shutdown()` in reverse order

## Frontend Architecture

The frontend is a React SPA that calls backend APIs:

- **No SSR** - all rendering in browser
- **File-based routing** - routes in `frontend/app/routes/`
- **TanStack Query** - for data fetching and caching
- **WebSocket** - for real-time features (Claude chat, notifications)

Key patterns:
- Hooks for data fetching (`useQuery`, custom hooks)
- Context for global state (auth, theme)
- Components in `frontend/app/components/`

## Cross-Cutting Concerns

### Logging

Use zerolog (`backend/log/`):
- `log.Info()` for important events (always visible)
- `log.Debug()` for verbose output (often disabled)
- `log.Error()` for errors

**Important**: Use `log.Info()` for debugging - Debug level is often filtered.

### Database Migrations

When changing schema:
1. Update migration in `backend/db/migrations.go`
2. Update queries to match
3. Test on fresh database: `rm -rf .my-life-db/ && go run .`

### Error Handling

- Return errors up the call stack
- Log at the point where you handle (not at every level)
- API handlers return appropriate HTTP status codes
