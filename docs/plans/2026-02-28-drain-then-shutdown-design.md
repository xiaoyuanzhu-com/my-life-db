# Drain-Then-Shutdown Design

Non-interruptive deployment: wait for active Claude sessions to finish before shutting down the server.

## Problem

Deploying a new server version kills all active Claude sessions. Users lose in-progress work and context with no warning. A session that was mid-turn appears broken after restart.

## UX Goal

Users never see an interruption. By the time the server shuts down, every Claude session is idle. After restart, sessions appear naturally finished — user checks status and gives the next instruction.

## Approach

Graceful drain — no blue-green deployment, no two containers, no traffic routing. Reorder the existing shutdown sequence and replace the aggressive 2-second force-kill with a patient 10-minute wait.

## Shutdown Sequence (New)

```
SIGTERM received (docker stop)
  │
  ├─ 1. http.Server.Shutdown()
  │     Close listener, finish in-flight HTTP requests.
  │     WebSocket connections are hijacked — not tracked by HTTP server, returns fast.
  │     Client gets connection refused → reconnect logic retries → hits new server after restart.
  │
  ├─ 2. claudeManager.SignalShutdown()
  │     Mark all sessions as shutting down (child processes expect exit).
  │
  ├─ 3. shutdownCancel()
  │     Cancel shutdown context → WebSocket/SSE handlers exit gracefully.
  │
  ├─ 4. sleep 100ms
  │     Let hijacked connections close cleanly.
  │
  ├─ 5. notifService.Shutdown()
  │     Close SSE notification connections.
  │
  ├─ 6. claudeManager.DrainAndShutdown(ctx)    ← NEW
  │     Wait up to 10 minutes for all "working" sessions to finish.
  │     "Working" = isProcessing && pendingPermissionCount == 0.
  │     Sessions blocked on permission are NOT working — they won't progress without human input.
  │     After all sessions leave "working" state → sleep 5s settle buffer.
  │     On timeout → force kill remaining sessions.
  │
  ├─ 7. Stop background workers (meiliSync, digest, fs)
  │
  └─ 8. Close database
```

## Drain Logic (SessionManager.DrainAndShutdown)

```
func DrainAndShutdown(ctx context.Context):
    count working sessions
    if none → skip to settle

    log "draining: waiting for N working sessions"
    subscribe to state change events (onStateChanged already fires on init/result transitions)

    loop:
        wait for state change event OR ctx.Done()
        if ctx.Done() → log timeout, force kill remaining, return
        recount working sessions
        log "session X finished, N remaining"
        if none → break

    log "drain complete, settling for 5s"
    sleep 5s

    cleanup (close sessions, subscriber channels, wait for goroutines)
```

A session is "working" when `isProcessing == true && pendingPermissionCount == 0`. This maps to the existing `"working"` state in the API session list.

## Timeout & Docker Config

- `main.go`: shutdown context timeout 15s → **10m5s** (10 min drain + 5s settle)
- Docker Compose: `stop_grace_period: 10m` (must exceed internal timeout so Go cleans up before SIGKILL)

## Logging

Operators see drain progress during slow deployments:

- Drain start: `"draining: waiting for N working sessions"`
- Each session finishing: `"draining: session <id> finished, N remaining"`
- Drain complete: `"drain complete, settling for 5s"`
- Timeout: `"drain timeout: force killing N remaining sessions"`

## Files Changed

| File | Change |
|------|--------|
| `backend/main.go` | Timeout 15s → 10m5s |
| `backend/server/server.go` | Reorder shutdown (HTTP first, drain before cleanup) |
| `backend/claude/session_manager.go` | New `DrainAndShutdown()` replacing current `Shutdown()` |
| `docker-compose.yml` | Add `stop_grace_period: 10m` |

## What Doesn't Change

- **Frontend** — no changes, reconnect logic handles everything
- **Session state model** — `isProcessing`, `pendingPermissionCount` already exist
- **`onStateChanged` callback** — already fires on state transitions
- **WebSocket/SSE handlers** — `shutdownCtx` pattern unchanged
- **Claude SDK client** — processes run independently, finish naturally
