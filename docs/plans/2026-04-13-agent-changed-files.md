# Agent Changed Files — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display files changed during an agent session (like `git status`) via an icon+count in the composer action bar, expandable into a popover with file details.

**Architecture:** New backend endpoint parses git status (git dirs) or tool calls from raw messages (non-git dirs) into a unified `ChangedFile` model. Frontend adds a button to the composer action bar that shows a popover above the composer (following the PermissionCard pattern).

**Tech Stack:** Go (backend endpoint), React + TypeScript + Tailwind (frontend), Radix Popover

---

### Task 1: Backend — Changed Files Endpoint

**Files:**
- Create: `backend/api/agent_changed_files.go`
- Modify: `backend/api/routes.go:137` (add route)

**Step 1: Create `backend/api/agent_changed_files.go`**

```go
package api

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// ChangedFile represents a single file change.
type ChangedFile struct {
	Path   string `json:"path"`
	Status string `json:"status"` // "added", "modified", "deleted", "renamed", "untracked"
}

// ChangedFilesResponse is the response for GET /api/agent/sessions/:id/changed-files.
type ChangedFilesResponse struct {
	Source string        `json:"source"` // "git" or "tools"
	Files  []ChangedFile `json:"files"`
}

// GetAgentChangedFiles returns files changed during an agent session.
// For git directories: runs git status --porcelain.
// For non-git directories: parses tool calls from session messages.
// GET /api/agent/sessions/:id/changed-files
func (h *Handlers) GetAgentChangedFiles(c *gin.Context) {
	sessionID := c.Param("id")

	session, err := db.GetAgentSession(sessionID)
	if err != nil {
		log.Error().Err(err).Str("sessionId", sessionID).Msg("failed to get agent session")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get session"})
		return
	}
	if session == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}

	workingDir := session.WorkingDir
	if workingDir == "" {
		c.JSON(http.StatusOK, ChangedFilesResponse{Source: "tools", Files: []ChangedFile{}})
		return
	}

	// Check if workingDir is a git repo
	if isGitDir(workingDir) {
		files := gitChangedFiles(workingDir)
		c.JSON(http.StatusOK, ChangedFilesResponse{Source: "git", Files: files})
		return
	}

	// Non-git: parse tool calls from session messages
	files := toolChangedFiles(sessionID)
	c.JSON(http.StatusOK, ChangedFilesResponse{Source: "tools", Files: files})
}

// isGitDir checks if a directory is inside a git repository.
func isGitDir(dir string) bool {
	cmd := exec.Command("git", "rev-parse", "--git-dir")
	cmd.Dir = dir
	return cmd.Run() == nil
}

// gitChangedFiles runs git status --porcelain and parses the output.
func gitChangedFiles(dir string) []ChangedFile {
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		log.Warn().Err(err).Str("dir", dir).Msg("git status failed")
		return []ChangedFile{}
	}

	var files []ChangedFile
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if len(line) < 4 {
			continue
		}
		xy := line[:2]
		path := strings.TrimSpace(line[3:])

		// Handle renames: "R  old -> new"
		if strings.Contains(path, " -> ") {
			parts := strings.SplitN(path, " -> ", 2)
			path = parts[1]
		}

		status := parseGitStatus(xy)
		files = append(files, ChangedFile{Path: path, Status: status})
	}
	return files
}

// parseGitStatus maps git status --porcelain XY codes to our status strings.
func parseGitStatus(xy string) string {
	x := xy[0]
	y := xy[1]

	// Check index (staged) status first, then working tree
	switch {
	case x == 'R' || y == 'R':
		return "renamed"
	case x == 'A' || y == 'A':
		return "added"
	case x == 'D' || y == 'D':
		return "deleted"
	case x == 'M' || y == 'M':
		return "modified"
	case x == '?' && y == '?':
		return "untracked"
	default:
		return "modified"
	}
}

// toolChangedFiles extracts file paths from tool_call frames in session messages.
func toolChangedFiles(sessionID string) []ChangedFile {
	ss := PeekSessionState(sessionID)
	if ss == nil {
		return []ChangedFile{}
	}

	raw := ss.GetRecentMessages(0)

	// Track unique paths and their status (last tool wins)
	seen := make(map[string]string)

	for _, msg := range raw {
		var frame struct {
			SessionUpdate string `json:"sessionUpdate"`
			Meta          *struct {
				ClaudeCode *struct {
					ToolName string `json:"toolName"`
				} `json:"claudeCode"`
			} `json:"_meta"`
			RawInput json.RawMessage `json:"rawInput"`
		}
		if err := json.Unmarshal(msg, &frame); err != nil {
			continue
		}
		if frame.SessionUpdate != "tool_call" {
			continue
		}

		toolName := ""
		if frame.Meta != nil && frame.Meta.ClaudeCode != nil {
			toolName = frame.Meta.ClaudeCode.ToolName
		}

		var input map[string]any
		if frame.RawInput != nil {
			json.Unmarshal(frame.RawInput, &input)
		}
		if input == nil {
			continue
		}

		switch toolName {
		case "Write":
			if fp, ok := input["file_path"].(string); ok && fp != "" {
				seen[fp] = "added"
			}
		case "Edit":
			if fp, ok := input["file_path"].(string); ok && fp != "" {
				seen[fp] = "modified"
			}
		case "mcp__agent-apps__putFile":
			if app, ok := input["app"].(string); ok {
				path := "apps/" + app
				if p, ok := input["path"].(string); ok {
					path += "/" + p
				}
				seen[path] = "added"
			}
		case "mcp__agent-apps__deleteFile":
			if app, ok := input["app"].(string); ok {
				path := "apps/" + app
				if p, ok := input["path"].(string); ok {
					path += "/" + p
				}
				seen[path] = "deleted"
			}
		}
	}

	files := make([]ChangedFile, 0, len(seen))
	for path, status := range seen {
		files = append(files, ChangedFile{Path: path, Status: status})
	}
	return files
}
```

**Step 2: Add route in `routes.go`**

After line 137 (`agentRoutes.GET("/sessions/:id/messages", h.GetAgentMessages)`), add:

```go
agentRoutes.GET("/sessions/:id/changed-files", h.GetAgentChangedFiles)
```

**Step 3: Build and verify**

Run: `cd backend && go build .`
Expected: Compiles successfully

**Step 4: Commit**

```bash
git add backend/api/agent_changed_files.go backend/api/routes.go
git commit -m "feat(agent): add GET /sessions/:id/changed-files endpoint"
```

---

### Task 2: Frontend — Changed Files Popover Component

**Files:**
- Create: `frontend/app/components/agent/changed-files-popover.tsx`

**Step 1: Create the component**

```tsx
/**
 * ChangedFilesPopover — shows files changed during an agent session.
 * Renders as an icon+count button in the composer action bar.
 * Click expands a popover above the composer with file details.
 */
import { useState, useEffect, useCallback } from "react"
import { FileText } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover"
import { cn } from "~/lib/utils"
import { fetchWithRefresh } from "~/lib/fetch-with-refresh"

interface ChangedFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
}

interface ChangedFilesResponse {
  source: "git" | "tools"
  files: ChangedFile[]
}

interface ChangedFilesPopoverProps {
  sessionId: string
  /** Bumped each time a turn completes — triggers re-fetch */
  refreshKey?: number
}

const STATUS_CONFIG: Record<string, { letter: string; color: string }> = {
  added:     { letter: "A", color: "text-green-500" },
  modified:  { letter: "M", color: "text-yellow-500" },
  deleted:   { letter: "D", color: "text-red-500" },
  renamed:   { letter: "R", color: "text-blue-500" },
  untracked: { letter: "?", color: "text-muted-foreground" },
}

export function ChangedFilesPopover({ sessionId, refreshKey }: ChangedFilesPopoverProps) {
  const [data, setData] = useState<ChangedFilesResponse | null>(null)
  const [open, setOpen] = useState(false)

  const fetchChangedFiles = useCallback(async () => {
    if (!sessionId) return
    try {
      const res = await fetchWithRefresh(`/api/agent/sessions/${sessionId}/changed-files`)
      if (res.ok) {
        setData(await res.json())
      }
    } catch {
      // Silently ignore — non-critical UI feature
    }
  }, [sessionId])

  // Fetch on mount and when refreshKey changes (turn completes)
  useEffect(() => {
    fetchChangedFiles()
  }, [fetchChangedFiles, refreshKey])

  // Don't render if no data or no files
  if (!data || data.files.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs",
            "text-muted-foreground hover:text-foreground hover:bg-muted",
            "transition-colors"
          )}
          aria-label={`${data.files.length} changed files`}
        >
          <FileText className="size-3.5" />
          <span>{data.files.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 max-h-64 overflow-y-auto p-2"
      >
        <div className="space-y-0.5">
          {data.files.map((file) => {
            const cfg = STATUS_CONFIG[file.status] ?? STATUS_CONFIG.modified
            return (
              <div
                key={file.path}
                className="flex items-center gap-2 rounded px-1.5 py-0.5 text-xs font-mono hover:bg-muted"
              >
                <span className={cn("w-3 shrink-0 text-center font-semibold", cfg.color)}>
                  {cfg.letter}
                </span>
                <span className="truncate text-foreground" title={file.path}>
                  {file.path}
                </span>
              </div>
            )
          })}
        </div>
        <div className="mt-2 border-t pt-1.5 text-[10px] text-muted-foreground">
          {data.source === "git" ? "from git status" : "from tool calls"}
        </div>
      </PopoverContent>
    </Popover>
  )
}
```

**Step 2: Commit**

```bash
git add frontend/app/components/agent/changed-files-popover.tsx
git commit -m "feat(agent): add ChangedFilesPopover component"
```

---

### Task 3: Frontend — Wire Into Composer Action Bar

**Files:**
- Modify: `frontend/app/components/assistant-ui/thread.tsx:303-391` (Composer component)
- Modify: `frontend/app/components/agent/agent-context.tsx` (add sessionId + resultCount to context)

**Step 1: Add `resultCount` to AgentContext**

In `agent-context.tsx`, add to `AgentContextValue`:

```typescript
/** Result count — incremented each turn, used as refresh key for changed files */
resultCount?: number
```

**Step 2: Pass `resultCount` through the context provider**

The context is provided in `agent.tsx` (the route). The `resultCount` needs to be wired from the agent runtime hook. Find where `AgentContextProvider` is rendered and add `resultCount` from the session state. This will vary based on how `useAgentRuntime` exposes it — check `use-agent-runtime.ts` for `resultCount` or equivalent turn counter.

If no turn counter is exposed, use the notification system: the frontend already listens for `agent_session_updated` SSE events with `"result"` reason — this is the right trigger. Add a simple counter state in the route that increments on each `"result"` notification.

**Step 3: Add ChangedFilesPopover to the Composer**

In `thread.tsx`, import and add to the left side of the action bar (after the existing selectors):

```tsx
import { ChangedFilesPopover } from "~/components/agent/changed-files-popover"
```

Inside Composer, destructure from context:

```tsx
const {
  // ...existing destructuring...
  sessionId,
  resultCount,
} = useAgentContext();
```

Add after the PermissionModeSelector in the left action bar section (around line 364):

```tsx
{sessionId && (
  <ChangedFilesPopover sessionId={sessionId} refreshKey={resultCount} />
)}
```

**Step 4: Build and verify**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: No errors

**Step 5: Commit**

```bash
git add frontend/app/components/agent/agent-context.tsx frontend/app/components/assistant-ui/thread.tsx
git commit -m "feat(agent): wire changed files popover into composer action bar"
```

---

### Task 4: Wire resultCount Through the Provider

**Files:**
- Modify: `frontend/app/routes/agent.tsx` (where AgentContextProvider is rendered)
- Modify: `frontend/app/hooks/use-agent-runtime.ts` (if resultCount not already exposed)

**Step 1: Expose a turn counter**

In `agent.tsx`, find where the `AgentContextProvider` is rendered with its value. Add a `resultCount` state that increments when the agent session notification fires with reason `"result"`.

The existing `useAgentSessionNotifications` hook likely already handles these events. Find it and add a counter:

```tsx
const [resultCount, setResultCount] = useState(0)
```

In the notification handler for `"result"` events, increment:

```tsx
setResultCount(prev => prev + 1)
```

Pass to context:

```tsx
resultCount,
```

**Step 2: Build and verify**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: No errors

**Step 3: Manual test**

1. Open agent page, start a session in a git directory
2. Have the agent edit a file (Write or Edit tool)
3. After the turn completes, the file icon + count should appear in the action bar
4. Click to expand the popover — should show changed files with colored status letters
5. Test with a non-git working directory to verify tool-call parsing fallback

**Step 4: Commit**

```bash
git add frontend/app/routes/agent.tsx frontend/app/hooks/use-agent-runtime.ts
git commit -m "feat(agent): wire resultCount for changed files refresh"
```
