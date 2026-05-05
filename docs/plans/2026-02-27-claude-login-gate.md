# Claude Login Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Gate the Claude new-session page behind Claude Code CLI authentication, showing a scoped login terminal when not authenticated.

**Architecture:** Backend checks `claude auth status` at startup and caches the result. A new public endpoint exposes this status. A second WebSocket endpoint spawns a PTY running only `claude auth login` for the login flow. Frontend conditionally renders a lazy-loaded xterm.js terminal or the normal session UI based on auth status.

**Tech Stack:** Go (Gin, creack/pty, coder/websocket), React (xterm.js lazy-loaded), TypeScript

---

### Task 1: Add `creack/pty` dependency

**Files:**
- Modify: `backend/go.mod`

**Step 1: Add dependency**

Run: `cd backend && go get github.com/creack/pty`

**Step 2: Verify**

Run: `grep creack backend/go.mod`
Expected: `github.com/creack/pty` appears in require block

**Step 3: Commit**

```bash
git add backend/go.mod backend/go.sum
git commit -m "deps: add creack/pty for terminal login"
```

---

### Task 2: Add Claude auth status to Server

**Files:**
- Modify: `backend/server/server.go`

**Step 1: Add field to Server struct (after line 35)**

In the Server struct, after `agent *agent.Agent`, add:

```go
	// Claude Code CLI auth
	claudeLoggedIn bool
```

**Step 2: Add startup check in New() (after line 127, before "server initialized" log)**

After `s.setupRouter()` (line 125), add:

```go
	// 10. Check Claude Code CLI auth status
	s.claudeLoggedIn = checkClaudeAuthStatus()
```

**Step 3: Add the check function (before or after New)**

```go
// checkClaudeAuthStatus runs `claude auth status` and returns true if exit code 0
func checkClaudeAuthStatus() bool {
	cmd := exec.Command("claude", "auth", "status")
	err := cmd.Run()
	if err != nil {
		log.Info().Msg("Claude Code CLI not authenticated")
		return false
	}
	log.Info().Msg("Claude Code CLI authenticated")
	return true
}
```

Add `"os/exec"` to the imports.

**Step 4: Add accessor and setter (after line 385)**

```go
func (s *Server) ClaudeLoggedIn() bool       { return s.claudeLoggedIn }
func (s *Server) SetClaudeLoggedIn(v bool)    { s.claudeLoggedIn = v }
```

**Step 5: Verify build**

Run: `cd backend && go build ./...`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add backend/server/server.go
git commit -m "feat: check Claude CLI auth status at server startup"
```

---

### Task 3: Create login handlers

**Files:**
- Create: `backend/api/claude_login.go`

**Step 1: Create the handler file**

```go
package api

import (
	"net/http"
	"os/exec"

	"github.com/coder/websocket"
	"github.com/creack/pty"
	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ClaudeAuthStatus returns the cached Claude CLI auth status
func (h *Handlers) ClaudeAuthStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"loggedIn": h.server.ClaudeLoggedIn(),
	})
}

// ClaudeLoginWebSocket spawns `claude auth login` in a PTY and pipes I/O over WebSocket.
// The PTY is killed when the WebSocket closes. Only `claude auth login` runs — no shell access.
func (h *Handlers) ClaudeLoginWebSocket(c *gin.Context) {
	conn, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Allow all origins (same as existing WS handlers)
	})
	if err != nil {
		log.Error().Err(err).Msg("claude login: websocket accept failed")
		return
	}

	// Abort gin context to prevent middleware from writing to hijacked connection
	c.Abort()

	ctx := c.Request.Context()

	// Spawn `claude auth login` in a PTY
	cmd := exec.Command("claude", "auth", "login")
	cmd.Env = append(cmd.Environ(), "TERM=xterm-256color")

	ptmx, err := pty.Start(cmd)
	if err != nil {
		log.Error().Err(err).Msg("claude login: failed to start pty")
		conn.Close(websocket.StatusInternalError, "failed to start login process")
		return
	}
	defer ptmx.Close()

	done := make(chan struct{})

	// PTY → WebSocket
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				return
			}
			if err := conn.Write(ctx, websocket.MessageBinary, buf[:n]); err != nil {
				return
			}
		}
	}()

	// WebSocket → PTY
	go func() {
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				// WebSocket closed — kill the process
				cmd.Process.Kill()
				return
			}
			ptmx.Write(data)
		}
	}()

	// Wait for process to exit
	<-done
	exitErr := cmd.Wait()

	if exitErr == nil {
		// Login succeeded — update cached status
		h.server.SetClaudeLoggedIn(true)
		conn.Close(websocket.StatusNormalClosure, "login successful")
	} else {
		conn.Close(websocket.StatusNormalClosure, "login process exited")
	}
}
```

**Step 2: Verify build**

Run: `cd backend && go build ./...`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add backend/api/claude_login.go
git commit -m "feat: add Claude auth status + login WebSocket handlers"
```

---

### Task 4: Register routes and gzip exclusion

**Files:**
- Modify: `backend/api/routes.go`
- Modify: `backend/server/server.go`

**Step 1: Register routes in routes.go**

Add to the `public` group (after line 21, before the closing brace):

```go
		// Claude Code CLI auth status (public — independent of app auth)
		public.GET("/claude/auth-status", h.ClaudeAuthStatus)
```

Add the WebSocket route after line 123 (after the existing WS routes):

```go
	r.GET("/api/claude-login/ws", h.ClaudeLoginWebSocket)
```

**Step 2: Add gzip exclusion in server.go**

In `setupRouter()`, add to the `gzip.WithExcludedPaths` list (after line 217):

```go
			"/api/claude-login/ws",          // WebSocket - login terminal
```

**Step 3: Verify build**

Run: `cd backend && go build ./...`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add backend/api/routes.go backend/server/server.go
git commit -m "feat: register Claude login routes and gzip exclusion"
```

---

### Task 5: Create lazy-loaded login terminal component

**Files:**
- Create: `frontend/app/components/claude/claude-login-terminal.tsx`

**Step 1: Create the component**

```tsx
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface ClaudeLoginTerminalProps {
  onLoginSuccess: () => void
}

export function ClaudeLoginTerminal({ onLoginSuccess }: ClaudeLoginTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<'connecting' | 'running' | 'success' | 'error'>('connecting')

  useEffect(() => {
    if (!terminalRef.current) return

    const term = new Terminal({
      fontSize: 14,
      fontFamily: 'JetBrains Mono, monospace',
      cursorBlink: true,
      rows: 12,
      cols: 80,
      theme: {
        background: 'transparent',
      },
      convertEol: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    term.open(terminalRef.current)
    fitAddon.fit()
    termRef.current = term

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/claude-login/ws`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('running')
    }

    ws.onmessage = (event) => {
      const data = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : event.data
      term.write(data)
    }

    ws.onclose = (event) => {
      if (event.reason === 'login successful') {
        setStatus('success')
      } else {
        setStatus('error')
      }
    }

    ws.onerror = () => {
      setStatus('error')
    }

    // Terminal input → WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data))
      }
    })

    // Handle resize
    const observer = new ResizeObserver(() => {
      fitAddon.fit()
    })
    observer.observe(terminalRef.current)

    return () => {
      observer.disconnect()
      ws.close()
      term.dispose()
    }
  }, [])

  return (
    <div className="flex flex-col items-center justify-center gap-6 p-8">
      <div className="max-w-2xl w-full space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">Claude Code Login</h2>
          <p className="text-sm text-muted-foreground">
            Claude Code is not authenticated. Complete the login below to continue.
          </p>
        </div>

        <div
          ref={terminalRef}
          className="w-full rounded-lg border border-border overflow-hidden p-2"
          style={{ backgroundColor: 'var(--claude-bg-code-block)' }}
        />

        {status === 'success' && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-green-600 dark:text-green-400">
              ✓ Login successful
            </p>
            <button
              onClick={onLoginSuccess}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Continue
            </button>
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-red-600 dark:text-red-400">
              Login process exited. Reload to try again.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
```

**Step 2: Verify types**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/app/components/claude/claude-login-terminal.tsx
git commit -m "feat: add lazy-loaded Claude login terminal component"
```

---

### Task 6: Gate the Claude page behind auth status

**Files:**
- Modify: `frontend/app/routes/claude.tsx`

**Step 1: Add imports (top of file)**

Add after existing imports:

```tsx
import { lazy, Suspense } from 'react'

const ClaudeLoginTerminal = lazy(() =>
  import('~/components/claude/claude-login-terminal').then(m => ({ default: m.ClaudeLoginTerminal }))
)
```

**Step 2: Add Claude auth state (inside ClaudePage, after line 56)**

After `const [loading, setLoading] = useState(true)` (line 56), add:

```tsx
  const [claudeLoggedIn, setClaudeLoggedIn] = useState<boolean | null>(null) // null = loading
```

**Step 3: Add Claude auth check effect (after the existing useEffect blocks)**

Add a new useEffect:

```tsx
  // Check Claude Code CLI auth status
  useEffect(() => {
    api.get('/api/claude/auth-status')
      .then(res => res.json())
      .then(data => setClaudeLoggedIn(data.loggedIn))
      .catch(() => setClaudeLoggedIn(false))
  }, [])
```

**Step 4: Add login gate (after the auth loading check at line 533)**

After the existing `if (authLoading || loading)` block (lines 533-539), add:

```tsx
  // Show Claude Code login terminal when CLI is not authenticated
  if (claudeLoggedIn === false) {
    return (
      <Suspense fallback={
        <div className="flex h-full items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      }>
        <ClaudeLoginTerminal onLoginSuccess={() => setClaudeLoggedIn(true)} />
      </Suspense>
    )
  }
```

The `claudeLoggedIn === null` case (still loading) falls through to the existing loading check since `loading` will also be true at that point. Once it resolves to `true`, the normal UI renders without ever loading xterm.js.

**Step 5: Verify types and build**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: No errors, build succeeds

**Step 6: Commit**

```bash
git add frontend/app/routes/claude.tsx
git commit -m "feat: gate Claude page behind CLI auth status"
```

---

### Task 7: End-to-end verification

**Step 1: Start backend**

Run the Go backend and verify startup log includes either:
- `Claude Code CLI authenticated`
- `Claude Code CLI not authenticated`

**Step 2: Test auth-status endpoint**

Run: `curl http://localhost:12345/api/claude/auth-status`
Expected: `{"loggedIn":true}` or `{"loggedIn":false}`

**Step 3: Test logged-in flow**

If already logged in, visit `/claude` — should see normal session UI. DevTools Network tab should NOT show any xterm.js chunks loaded.

**Step 4: Test logged-out flow**

Log out of Claude CLI (`claude auth logout`), restart server, visit `/claude`. Should see login terminal. Complete login, click Continue, should see normal session UI.

**Step 5: Commit (if any fixes needed)**

```bash
git commit -m "fix: address e2e verification issues"
```
