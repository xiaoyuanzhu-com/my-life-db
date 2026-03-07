# Public Session Sharing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to share Claude Code sessions publicly via a URL, with live updates and read-only access.

**Architecture:** Extend the `claude_sessions` table with `share_token` + `shared_at` columns. Add public API routes (`/api/share/:token/*`) that resolve the share token to a session ID and serve messages/WebSocket without auth. Frontend gets a new `/share/:token` route that renders the chat interface read-only (no sidebar, no input, no todo panel).

**Tech Stack:** Go (Gin), SQLite, React, TypeScript, WebSocket

**Design doc:** `docs/plans/2026-03-07-public-session-sharing-design.md`

---

### Task 1: Database migration — add share columns

**Files:**
- Create: `backend/db/migration_013_share_sessions.go`

**Step 1: Write the migration**

```go
package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     13,
		Description: "Add share_token and shared_at to claude_sessions",
		Up:          migration013_shareSessions,
	})
}

func migration013_shareSessions(database *sql.DB) error {
	_, err := database.Exec(`
		ALTER TABLE claude_sessions ADD COLUMN share_token TEXT;
		ALTER TABLE claude_sessions ADD COLUMN shared_at INTEGER;
		CREATE UNIQUE INDEX idx_claude_sessions_share_token ON claude_sessions(share_token);
	`)
	return err
}
```

**Step 2: Verify migration runs on fresh DB**

Run: `cd backend && rm -rf ../.my-life-db/ && go run . &` then kill the process.
Expected: Server starts without migration errors, `claude_sessions` table has `share_token` and `shared_at` columns.

**Step 3: Commit**

```bash
git add backend/db/migration_013_share_sessions.go
git commit -m "feat: add share_token and shared_at columns to claude_sessions"
```

---

### Task 2: DB functions for sharing

**Files:**
- Modify: `backend/db/claude_sessions.go` (append new functions)

**Step 1: Add share DB functions**

Append to `backend/db/claude_sessions.go`:

```go
// ── Share operations ─────────────────────────────────────────────────────────

// ShareClaudeSession sets the share_token for a session, making it publicly accessible.
func ShareClaudeSession(sessionID, shareToken string) error {
	_, err := Run(
		`INSERT INTO claude_sessions (session_id, share_token, shared_at, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   share_token = excluded.share_token,
		   shared_at = excluded.shared_at,
		   updated_at = excluded.updated_at`,
		sessionID, shareToken, NowMs(), NowMs(),
	)
	return err
}

// UnshareClaudeSession removes the share_token, revoking public access.
func UnshareClaudeSession(sessionID string) error {
	_, err := Run(
		`UPDATE claude_sessions SET share_token = NULL, shared_at = NULL, updated_at = ?
		 WHERE session_id = ?`,
		NowMs(), sessionID,
	)
	return err
}

// GetSessionIDByShareToken resolves a share token to a session ID.
// Returns empty string if not found.
func GetSessionIDByShareToken(shareToken string) (string, error) {
	var sessionID string
	err := GetDB().QueryRow(
		`SELECT session_id FROM claude_sessions WHERE share_token = ?`,
		shareToken,
	).Scan(&sessionID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return sessionID, err
}

// GetShareToken returns the share token for a session, or empty string if not shared.
func GetShareToken(sessionID string) (string, error) {
	var token sql.NullString
	err := GetDB().QueryRow(
		`SELECT share_token FROM claude_sessions WHERE session_id = ?`,
		sessionID,
	).Scan(&token)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if token.Valid {
		return token.String, nil
	}
	return "", nil
}
```

**Step 2: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: No errors.

**Step 3: Commit**

```bash
git add backend/db/claude_sessions.go
git commit -m "feat: add share/unshare/lookup DB functions for session sharing"
```

---

### Task 3: Authenticated share/unshare API handlers

**Files:**
- Create: `backend/api/share.go`
- Modify: `backend/api/routes.go` (add routes)

**Step 1: Create share handlers**

Create `backend/api/share.go`:

```go
package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ShareClaudeSession handles POST /api/claude/sessions/:id/share
// Generates a share token and makes the session publicly accessible.
func (h *Handlers) ShareClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	// Check if already shared
	existing, err := db.GetShareToken(sessionID)
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to check existing share token")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to share session"})
		return
	}
	if existing != "" {
		// Already shared — return existing token
		c.JSON(http.StatusOK, gin.H{
			"shareToken": existing,
			"shareUrl":   "/share/" + existing,
		})
		return
	}

	// Generate new share token
	shareToken := uuid.New().String()

	if err := db.ShareClaudeSession(sessionID, shareToken); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to share session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to share session"})
		return
	}

	log.Info().Str("sessionId", sessionID).Str("shareToken", shareToken).Msg("session shared")

	c.JSON(http.StatusOK, gin.H{
		"shareToken": shareToken,
		"shareUrl":   "/share/" + shareToken,
	})
}

// UnshareClaudeSession handles DELETE /api/claude/sessions/:id/share
// Revokes public access by removing the share token.
func (h *Handlers) UnshareClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	if err := db.UnshareClaudeSession(sessionID); err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to unshare session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unshare session"})
		return
	}

	log.Info().Str("sessionId", sessionID).Msg("session unshared")

	c.Status(http.StatusNoContent)
}
```

**Step 2: Add routes to `backend/api/routes.go`**

In the `api` (authenticated) group, after the existing Claude session routes (around line 117), add:

```go
		api.POST("/claude/sessions/:id/share", h.ShareClaudeSession)
		api.DELETE("/claude/sessions/:id/share", h.UnshareClaudeSession)
```

**Step 3: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: No errors.

**Step 4: Commit**

```bash
git add backend/api/share.go backend/api/routes.go
git commit -m "feat: add authenticated share/unshare API endpoints"
```

---

### Task 4: Public share API handlers (metadata + messages)

**Files:**
- Modify: `backend/api/share.go` (add public handlers)
- Modify: `backend/api/routes.go` (add public routes)

**Step 1: Add public share handlers to `backend/api/share.go`**

Append to `share.go`:

```go
// GetSharedSession handles GET /api/share/:token
// Returns session metadata for a shared session (no auth required).
func (h *Handlers) GetSharedSession(c *gin.Context) {
	token := c.Param("token")

	sessionID, err := db.GetSessionIDByShareToken(token)
	if err != nil {
		log.Error().Err(err).Msg("failed to look up share token")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal error"})
		return
	}
	if sessionID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Shared session not found"})
		return
	}

	session, err := h.server.Claude().GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	c.JSON(http.StatusOK, session.ToJSON())
}

// GetSharedSessionMessages handles GET /api/share/:token/messages
// Returns messages for a shared session (no auth required).
// Supports same pagination as the authenticated endpoint.
func (h *Handlers) GetSharedSessionMessages(c *gin.Context) {
	token := c.Param("token")

	sessionID, err := db.GetSessionIDByShareToken(token)
	if err != nil {
		log.Error().Err(err).Msg("failed to look up share token")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal error"})
		return
	}
	if sessionID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Shared session not found"})
		return
	}

	// Reuse the same logic as GetClaudeSessionMessages by setting the param
	c.Params = append(c.Params, gin.Param{Key: "id", Value: sessionID})
	h.GetClaudeSessionMessages(c)
}
```

**Step 2: Add public routes to `backend/api/routes.go`**

In the `public` group (around line 24), add:

```go
		// Public share routes (no auth required)
		public.GET("/share/:token", h.GetSharedSession)
		public.GET("/share/:token/messages", h.GetSharedSessionMessages)
```

**Step 3: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: No errors.

**Step 4: Commit**

```bash
git add backend/api/share.go backend/api/routes.go
git commit -m "feat: add public share API endpoints for metadata and messages"
```

---

### Task 5: Public share WebSocket (read-only subscribe)

**Files:**
- Modify: `backend/api/share.go` (add WebSocket handler)
- Modify: `backend/api/routes.go` (add WebSocket route)

**Step 1: Add read-only WebSocket handler to `backend/api/share.go`**

Append to `share.go`. This is a simplified version of `ClaudeSubscribeWebSocket` that:
- Resolves share token → session ID
- Sends initial burst + live updates
- Does NOT accept any incoming messages (read-only)
- Does NOT track read state

```go
import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
	"github.com/xiaoyuanzhu-com/my-life-db/claude"
)

// SharedSessionSubscribeWebSocket handles WebSocket connection for real-time
// updates on a shared session. Read-only — no messages from client are processed.
func (h *Handlers) SharedSessionSubscribeWebSocket(c *gin.Context) {
	token := c.Param("token")

	sessionID, err := db.GetSessionIDByShareToken(token)
	if err != nil || sessionID == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Shared session not found"})
		return
	}

	session, err := h.server.Claude().GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	// Accept WebSocket
	var w http.ResponseWriter = c.Writer
	if unwrapper, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		w = unwrapper.Unwrap()
	}

	conn, err := websocket.Accept(w, c.Request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Error().Err(err).Msg("shared subscribe WebSocket upgrade failed")
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	c.Abort()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Monitor server shutdown
	go func() {
		select {
		case <-h.server.ShutdownContext().Done():
			cancel()
		case <-ctx.Done():
		}
	}()

	// Load raw messages
	if err := session.LoadRawMessages(); err != nil {
		log.Warn().Err(err).Str("sessionId", sessionID).Msg("failed to load raw messages for shared session")
	}

	// Send session_info
	totalPages := session.TotalPages()
	lowestBurstPage := totalPages - 2
	if lowestBurstPage < 0 {
		lowestBurstPage = 0
	}

	sessionInfo := map[string]any{
		"type":            "session_info",
		"totalPages":      totalPages,
		"lowestBurstPage": lowestBurstPage,
	}
	if infoBytes, err := json.Marshal(sessionInfo); err == nil {
		if err := conn.Write(ctx, websocket.MessageText, infoBytes); err != nil {
			return
		}
	}

	// Send initial burst
	burstMessages := session.GetPageRange(lowestBurstPage, totalPages)
	for _, msgBytes := range burstMessages {
		if err := conn.Write(ctx, websocket.MessageText, msgBytes); err != nil {
			return
		}
	}

	// Register as broadcast client for live updates
	uiClient := &claude.Client{
		Conn: conn,
		Send: make(chan []byte, 256),
	}
	session.AddClient(uiClient)
	defer session.RemoveClient(uiClient)

	// Forward broadcasts to WebSocket
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		for {
			select {
			case <-ctx.Done():
				return
			case data, ok := <-uiClient.Send:
				if !ok {
					return
				}
				if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
					return
				}
			}
		}
	}()

	// Ping goroutine
	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()
	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		for {
			select {
			case <-ctx.Done():
				return
			case <-pingTicker.C:
				if err := conn.Ping(ctx); err != nil {
					return
				}
			}
		}
	}()

	// Read loop — ignore all incoming messages (read-only), but needed to detect close
	for {
		_, _, err := conn.Read(ctx)
		if err != nil {
			cancel()
			break
		}
	}

	<-pollDone
	<-pingDone
}
```

Note: The imports at the top of `share.go` need to be updated. Ensure the file has all necessary imports (context, encoding/json, time, websocket, claude package).

**Step 2: Add WebSocket route to `backend/api/routes.go`**

After the existing WebSocket routes (around line 128), add the shared WebSocket route. It must NOT have auth middleware:

```go
	r.GET("/api/share/:token/subscribe", h.SharedSessionSubscribeWebSocket)
```

**Step 3: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: No errors.

**Step 4: Commit**

```bash
git add backend/api/share.go backend/api/routes.go
git commit -m "feat: add read-only WebSocket endpoint for shared sessions"
```

---

### Task 6: Include share status in session metadata

**Files:**
- Modify: `backend/api/claude.go` — `GetClaudeSession` handler and `ListAllClaudeSessions` handler

**Step 1: Add share token to GetClaudeSession response**

In `GetClaudeSession` (around line 80), after getting the session, look up the share token and include it in the response:

```go
func (h *Handlers) GetClaudeSession(c *gin.Context) {
	sessionID := c.Param("id")

	session, err := h.server.Claude().GetSession(sessionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
		return
	}

	result := session.ToJSON()

	// Include share status
	if shareToken, err := db.GetShareToken(sessionID); err == nil && shareToken != "" {
		result["shareToken"] = shareToken
		result["shareUrl"] = "/share/" + shareToken
	}

	c.JSON(http.StatusOK, result)
}
```

**Step 2: Add share info to ListAllClaudeSessions response**

In `ListAllClaudeSessions`, after building the `sessionData` map (around line 253), add share token lookup. For efficiency, do a bulk query before the loop. Add a helper function in `db/claude_sessions.go`:

```go
// GetAllShareTokens returns all share tokens as a map of sessionID -> shareToken.
func GetAllShareTokens() (map[string]string, error) {
	rows, err := Select(
		`SELECT session_id, share_token FROM claude_sessions WHERE share_token IS NOT NULL`,
		nil,
		func(rows *sql.Rows) ([2]string, error) {
			var pair [2]string
			err := rows.Scan(&pair[0], &pair[1])
			return pair, err
		},
	)
	if err != nil {
		return nil, err
	}
	result := make(map[string]string, len(rows))
	for _, pair := range rows {
		result[pair[0]] = pair[1]
	}
	return result, nil
}
```

Then in `ListAllClaudeSessions`, load share tokens alongside read states:

```go
	shareTokens, err := db.GetAllShareTokens()
	if err != nil {
		log.Warn().Err(err).Msg("failed to load share tokens")
		shareTokens = make(map[string]string)
	}
```

And in the session data loop, after setting `sessionData`, add:

```go
		if token, ok := shareTokens[snap.ID]; ok {
			sessionData["shareToken"] = token
			sessionData["shareUrl"] = "/share/" + token
		}
```

**Step 3: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: No errors.

**Step 4: Commit**

```bash
git add backend/api/claude.go backend/db/claude_sessions.go
git commit -m "feat: include share status in session metadata responses"
```

---

### Task 7: Frontend — share route page

**Files:**
- Create: `frontend/app/routes/share.$token.tsx`

**Step 1: Create the share page route**

This route renders the `ChatInterface` component in read-only mode. It fetches session metadata via the public API, connects to the public WebSocket, and hides all interactive elements.

The key differences from `claude.tsx`:
- No session list sidebar
- No `ChatInput` (no sending messages)
- No todo panel
- No permission modal
- No auth required
- Uses `/api/share/:token` endpoints instead of `/api/claude/sessions/:id`

Create `frontend/app/routes/share.$token.tsx`. The page should:

1. Extract `token` from URL params
2. Fetch session metadata from `GET /api/share/:token`
3. Render a header with session title
4. Render `MessageList` (reuse from `~/components/claude/chat`)
5. Connect to WebSocket at `/api/share/:token/subscribe` for live updates
6. Handle the same WebSocket protocol (session_info, burst messages, live messages)

Since the existing `ChatInterface` component is tightly coupled to the authenticated flow (sending messages, permissions, etc.), create a new lightweight `SharedChatView` component or build the share page directly in the route file using the lower-level `MessageList` component and a simplified WebSocket hook.

The page structure:

```tsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'react-router'
import { MessageList } from '~/components/claude/chat'
import type { SessionMessage } from '~/lib/session-message-utils'
import { normalizeMessage, buildToolResultMap } from '~/lib/session-message-utils'

export default function SharePage() {
  const { token } = useParams()
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [sessionTitle, setSessionTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  // Fetch session metadata
  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then(res => {
        if (!res.ok) throw new Error('Session not found')
        return res.json()
      })
      .then(data => {
        setSessionTitle(data.summary || data.customTitle || data.title || 'Shared Session')
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [token])

  // WebSocket connection for live updates
  useEffect(() => {
    if (!token) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/api/share/${token}/subscribe`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)

      if (data.type === 'session_info') {
        // Session info frame — ignore for now
        return
      }

      // Normalize and add message
      const normalized = normalizeMessage(data)
      if (normalized) {
        setMessages(prev => {
          // Dedup by uuid
          if (normalized.uuid) {
            const exists = prev.some(m => m.uuid === normalized.uuid)
            if (exists) return prev
          }
          return [...prev, normalized]
        })
      }
    }

    ws.onerror = () => setError('Connection error')

    return () => {
      ws.close()
    }
  }, [token])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-muted-foreground">Loading shared session...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-destructive">{error}</div>
      </div>
    )
  }

  // Build tool result map for message rendering
  const toolResultMap = buildToolResultMap(messages)

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-border">
        <h1 className="text-sm font-medium text-foreground truncate">
          {sessionTitle}
        </h1>
        <span className="ml-2 text-xs text-muted-foreground">Shared session</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-hidden">
        <MessageList
          messages={messages}
          toolResultMap={toolResultMap}
          sessionId={token || ''}
          readOnly={true}
        />
      </div>
    </div>
  )
}
```

**Important notes for implementation:**
- Check what props `MessageList` requires and whether it supports a `readOnly` prop. If not, you may need to add one or conditionally hide interactive elements.
- The `normalizeMessage` and `buildToolResultMap` functions from `~/lib/session-message-utils` handle message format normalization — reuse them.
- The header in `root.tsx` checks for `/claude/*` routes to hide on mobile. Add a similar check for `/share/*` to hide the main app header entirely on the share page.

**Step 2: Update root.tsx to hide header on share pages**

In `frontend/app/root.tsx`, the `ConditionalHeader` component hides the header on Claude session detail pages. Update it to also hide on share pages entirely:

```tsx
function ConditionalHeader() {
  const location = useLocation();
  const isClaudeSessionDetail = /^\/claude\/[^/]+/.test(location.pathname);
  const isSharePage = /^\/share\//.test(location.pathname);

  // Hide header entirely on share pages
  if (isSharePage) return null;

  return (
    <div className={isClaudeSessionDetail ? 'hidden md:block' : ''}>
      <Header />
    </div>
  );
}
```

**Step 3: Verify frontend builds**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: No type errors, build succeeds.

**Step 4: Commit**

```bash
git add frontend/app/routes/share.\$token.tsx frontend/app/root.tsx
git commit -m "feat: add shared session view page with live WebSocket updates"
```

---

### Task 8: Frontend — share/unshare controls in session UI

**Files:**
- Modify: `frontend/app/routes/claude.tsx` or the session header component
- Modify: `frontend/app/components/claude/session-list.tsx` (add share indicator)

**Step 1: Identify where archive/delete buttons live**

The archive and unarchive buttons are in `session-list.tsx` (line ~307-315). Add a share button in the same area or in the session header within `claude.tsx`.

**Step 2: Add share button to session actions**

Add a share/unshare toggle button. When clicked:
- If not shared: `POST /api/claude/sessions/:id/share` → show share URL in a popover/dialog with copy button
- If shared: show existing URL + "Unshare" button → `DELETE /api/claude/sessions/:id/share`

Use a small dialog/popover component. The share state comes from the session metadata (`shareToken` and `shareUrl` fields added in Task 6).

Update the `Session` interface in `claude.tsx` to include:

```typescript
interface Session {
  // ... existing fields ...
  shareToken?: string
  shareUrl?: string
}
```

Add a share button in the session header (the area with session title, permission mode selector, etc.). Use the `Share2` icon from lucide-react.

**Step 3: Implement share dialog**

Create a small inline component or popover that:
- Shows "Share" button (Share2 icon) in the session header
- On click, calls `POST /api/claude/sessions/${sessionId}/share`
- Shows the returned URL with a "Copy" button (use `navigator.clipboard.writeText`)
- If already shared, shows the URL + "Unshare" button
- Unshare calls `DELETE /api/claude/sessions/${sessionId}/share`

**Step 4: Verify frontend builds**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: No type errors, build succeeds.

**Step 5: Commit**

```bash
git add frontend/app/routes/claude.tsx frontend/app/components/claude/session-list.tsx
git commit -m "feat: add share/unshare controls to session UI"
```

---

### Task 9: End-to-end testing

**Step 1: Start the dev server**

Run: `cd backend && go run .` (with frontend already built)

**Step 2: Test share flow**

1. Open the Claude sessions page
2. Open a session with messages
3. Click the Share button → verify a share URL is returned
4. Copy the URL
5. Open the URL in an incognito/private window (no auth)
6. Verify the shared session loads with messages
7. Verify live updates work (if the session is active, send a message from the authenticated window and verify it appears in the shared view)

**Step 3: Test unshare flow**

1. Click "Unshare" on the shared session
2. Verify the share URL now returns 404
3. Verify the incognito window shows an error

**Step 4: Test edge cases**

- Share a session, close and reopen the app — share status should persist
- Share token should be included in session list and detail responses
- Archiving a shared session should not affect the share (it's still accessible)

---

### Task 10: Gateway integration (cloud-hosted, optional)

**Files:**
- Modify: `backend/api/share.go` (add gateway registration)
- Modify: `backend/config/config.go` (add `MLD_SHARE_GATEWAY_URL`)

**Note:** This task is for cloud-hosted deployments only. Skip if only self-hosting.

**Step 1: Add env var to config**

In `backend/config/config.go`, add:

```go
ShareGatewayURL string // MLD_SHARE_GATEWAY_URL — gateway for cloud share registration
```

Load from env: `ShareGatewayURL: os.Getenv("MLD_SHARE_GATEWAY_URL")`

**Step 2: Add gateway registration calls**

In `ShareClaudeSession` handler, after storing the token in DB, if `config.Get().ShareGatewayURL` is set:

```go
if gwURL := config.Get().ShareGatewayURL; gwURL != "" {
    go registerShareWithGateway(gwURL, shareToken, config.Get().ExpectedUsername)
}
```

In `UnshareClaudeSession` handler, after nulling the token:

```go
if gwURL := config.Get().ShareGatewayURL; gwURL != "" {
    // Get the old token before unsharing (need to fetch it first)
    go deregisterShareWithGateway(gwURL, oldToken)
}
```

Implement `registerShareWithGateway` and `deregisterShareWithGateway` as simple HTTP calls:

```go
func registerShareWithGateway(gatewayURL, token, username string) {
    body, _ := json.Marshal(map[string]string{"token": token, "username": username})
    resp, err := http.Post(gatewayURL+"/api/shares", "application/json", bytes.NewReader(body))
    if err != nil {
        log.Error().Err(err).Msg("failed to register share with gateway")
        return
    }
    resp.Body.Close()
}

func deregisterShareWithGateway(gatewayURL, token string) {
    req, _ := http.NewRequest("DELETE", gatewayURL+"/api/shares/"+token, nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        log.Error().Err(err).Msg("failed to deregister share with gateway")
        return
    }
    resp.Body.Close()
}
```

**Step 3: Commit**

```bash
git add backend/api/share.go backend/config/config.go
git commit -m "feat: add gateway registration for cloud-hosted session sharing"
```
