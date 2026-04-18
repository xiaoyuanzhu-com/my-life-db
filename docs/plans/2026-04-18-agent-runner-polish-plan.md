# Agent Runner Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor agent definitions to live in per-agent folders, and expose session initiator (user vs. auto, plus agent name) through the API and UI.

**Architecture:** Three layers. (1) DB — rename `agent_file` column to `agent_name` in migration 021; propagate through the Go struct and all call sites. (2) Runner/Parser — parser reads `<agents>/<name>/<name>.md`, folder name is canonical agent name; watcher watches subdirectories. (3) API/UI — list/get endpoints include `source` and `agentName`; sidebar splits into Auto/Manual sections with the existing auto badge finally firing, plus an `agentName` secondary label under auto sessions.

**Tech Stack:** Go 1.25, SQLite, `fsnotify`, Gin, React/TypeScript (React Router v7), npm. Design doc: `docs/plans/2026-04-18-agent-runner-polish-design.md`.

**Working directory:** All work happens in `/home/xiaoyuanzhu/my-life-db/data/projects/MyLifeDB/my-life-db/.worktrees/agent-runner-polish`.

---

## Task 0: Verify baseline

**Step 1: cd into worktree**

Run:
```
cd /home/xiaoyuanzhu/my-life-db/data/projects/MyLifeDB/my-life-db/.worktrees/agent-runner-polish
```

**Step 2: Build the backend**

Run:
```
cd backend && go build ./... && cd ..
```
Expected: no output, exit 0.

**Step 3: Run agentrunner tests**

Run:
```
cd backend && go test -v ./agentrunner/ && cd ..
```
Expected: all tests pass.

**Step 4: Typecheck frontend**

Run:
```
cd frontend && npm run typecheck && cd ..
```
Expected: no errors.

If any step fails: stop, report the failure, ask before continuing.

---

## Phase A — Rename `agent_file` → `agent_name` through the stack

### Task A1: Write DB migration 021

**Files:**
- Create: `backend/db/migration_021_agent_session_agent_name.go`

**Step 1: Create the migration file**

Write:
```go
package db

import "database/sql"

func init() {
	RegisterMigration(Migration{
		Version:     21,
		Description: "Rename agent_sessions.agent_file to agent_name and strip .md suffix from existing values",
		Up: func(db *sql.DB) error {
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()

			// SQLite supports RENAME COLUMN since 3.25 (2018). Safe here.
			if _, err := tx.Exec(`ALTER TABLE agent_sessions RENAME COLUMN agent_file TO agent_name`); err != nil {
				return err
			}

			// Backfill: strip trailing ".md" from any non-empty value.
			if _, err := tx.Exec(`
				UPDATE agent_sessions
				SET agent_name = substr(agent_name, 1, length(agent_name) - 3)
				WHERE agent_name LIKE '%.md'
			`); err != nil {
				return err
			}

			return tx.Commit()
		},
	})
}
```

**Step 2: Build to confirm it compiles and is registered**

Run:
```
cd backend && go build ./... && cd ..
```
Expected: exit 0.

**Step 3: Commit**

Run:
```
git add backend/db/migration_021_agent_session_agent_name.go
git commit -m "db: add migration 021 renaming agent_file -> agent_name"
```

---

### Task A2: Update `AgentSessionRecord` struct

**Files:**
- Modify: `backend/db/agent_sessions.go` (L12-22, L25-43, L46-64, L69-102)

**Step 1: Rename the struct field**

In `AgentSessionRecord`, change:
```go
AgentFile  string `json:"agentFile"` // agent definition filename (for auto sessions)
```
to:
```go
AgentName  string `json:"agentName"` // agent folder name (for auto sessions)
```

**Step 2: Update `CreateAgentSession` signature and SQL**

Change the function signature from:
```go
func CreateAgentSession(sessionID, agentType, workingDir, title, source, agentFile string) error
```
to:
```go
func CreateAgentSession(sessionID, agentType, workingDir, title, source, agentName string) error
```

Update the `INSERT` / upsert SQL to use the column name `agent_name` and bind `agentName`. Keep the `ON CONFLICT(session_id) DO UPDATE SET ...` behavior. If `agent_name` was used in the update clause, rename it there too.

**Step 3: Update `ListAgentSessions` and `GetAgentSession` SELECTs**

In both functions, change the SELECT column list from:
```
session_id, agent_type, working_dir, title, source, agent_file, created_at, updated_at, archived_at
```
to:
```
session_id, agent_type, working_dir, title, source, agent_name, created_at, updated_at, archived_at
```

Update the corresponding `rows.Scan(...)` / `row.Scan(...)` calls so the scanned pointer is `&rec.AgentName` instead of `&rec.AgentFile`.

**Step 4: Build**

Run:
```
cd backend && go build ./... && cd ..
```
Expected: compile errors from call sites that still pass `AgentFile`. Note them — the next tasks fix those.

**Step 5: Commit**

Run:
```
git add backend/db/agent_sessions.go
git commit -m "db: rename AgentSessionRecord.AgentFile -> AgentName"
```

---

### Task A3: Update `api.SessionParams`

**Files:**
- Modify: `backend/api/agent_session.go` (L8-17)

**Step 1: Rename the field**

Change:
```go
AgentFile      string // agent definition file (auto-run only)
```
to:
```go
AgentName      string // agent folder name (auto-run only)
```

**Step 2: Update the `CreateSession` DB call**

In `backend/api/agent_manager.go` (L333), change:
```go
if err := db.CreateAgentSession(sessionID, agentTypeStr, params.WorkingDir, params.Title, params.Source, params.AgentFile); err != nil {
```
to:
```go
if err := db.CreateAgentSession(sessionID, agentTypeStr, params.WorkingDir, params.Title, params.Source, params.AgentName); err != nil {
```

**Step 3: Build**

Run:
```
cd backend && go build ./... && cd ..
```
Expected: compile errors narrow to `agentrunner` + `main.go`. Continue.

**Step 4: Commit**

Run:
```
git add backend/api/agent_session.go backend/api/agent_manager.go
git commit -m "api: rename SessionParams.AgentFile -> AgentName"
```

---

### Task A4: Update `agentrunner.SessionParams` and `execute`

**Files:**
- Modify: `backend/agentrunner/runner.go` (L19-29, L425-458)

**Step 1: Rename the struct field**

In `SessionParams` change:
```go
AgentFile      string // agent definition file
```
to:
```go
AgentName      string // agent folder name
```

**Step 2: Update `execute` to pass the agent name**

In `execute`, change:
```go
AgentFile:      def.File,
```
to:
```go
AgentName:      def.Name,
```
(We'll ensure `def.Name` is the folder name in Phase B.)

**Step 3: Build**

Run:
```
cd backend && go build ./... && cd ..
```
Expected: compile errors narrow to `main.go` wiring. Continue.

**Step 4: Commit**

Run:
```
git add backend/agentrunner/runner.go
git commit -m "agentrunner: rename SessionParams.AgentFile -> AgentName"
```

---

### Task A5: Update `main.go` wiring

**Files:**
- Modify: `backend/main.go` (L79-95)

**Step 1: Update the bridge**

In the `srv.AgentRunner().SetCreateSession(...)` block, change:
```go
AgentFile:      params.AgentFile,
```
to:
```go
AgentName:      params.AgentName,
```

**Step 2: Build the whole backend**

Run:
```
cd backend && go build ./... && cd ..
```
Expected: exit 0, no errors.

**Step 3: Run the agentrunner tests**

Run:
```
cd backend && go test -v ./agentrunner/ && cd ..
```
Expected: all pass. (Existing tests don't touch `AgentFile`/`AgentName` — confirm.)

**Step 4: Commit**

Run:
```
git add backend/main.go
git commit -m "main: update agent-runner wiring to AgentName field"
```

---

## Phase B — Folder-per-agent loading

### Task B1: Add failing parser test for folder-per-agent layout

**Files:**
- Modify: `backend/agentrunner/parser_test.go` — add a new test.
- Read first: the existing `parser_test.go` to match its patterns (stdlib `testing`, `t.TempDir()`).

**Step 1: Read the existing tests**

Use the Read tool on `backend/agentrunner/parser_test.go` to see the current test style.

**Step 2: Add the new test**

We're introducing a new API on the runner: `LoadDefs` should read subdirectories. Before touching parser behavior, update the test that exercises loading. Since loading logic lives in `runner.go:LoadDefs`, add the test to `backend/agentrunner/runner_test.go` (not `parser_test.go`). Read `runner_test.go` first to match its pattern.

Add this test:
```go
func TestLoadDefsFolderPerAgent(t *testing.T) {
	dir := t.TempDir()

	// Valid agent in its own folder
	agentDir := filepath.Join(dir, "my-agent")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	content := []byte(`---
agent: claude_code
trigger: cron
schedule: "0 3 * * *"
---
Hello from my-agent.
`)
	if err := os.WriteFile(filepath.Join(agentDir, "my-agent.md"), content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Flat file at root — must be ignored
	if err := os.WriteFile(filepath.Join(dir, "flat.md"), content, 0o644); err != nil {
		t.Fatalf("write flat: %v", err)
	}

	// Folder missing its inner .md — must be skipped without error
	emptyDir := filepath.Join(dir, "empty-agent")
	if err := os.MkdirAll(emptyDir, 0o755); err != nil {
		t.Fatalf("mkdir empty: %v", err)
	}

	r := &Runner{cfg: Config{AgentsDir: dir}}
	if err := r.LoadDefs(); err != nil {
		t.Fatalf("LoadDefs: %v", err)
	}

	defs := r.Defs()
	if len(defs) != 1 {
		t.Fatalf("expected 1 def, got %d: %+v", len(defs), defs)
	}
	if defs[0].Name != "my-agent" {
		t.Errorf("expected def.Name='my-agent', got %q", defs[0].Name)
	}
	if defs[0].File != "my-agent.md" {
		t.Errorf("expected def.File='my-agent.md', got %q", defs[0].File)
	}
}
```

**Step 3: Run the test — verify it fails**

Run:
```
cd backend && go test -v -run TestLoadDefsFolderPerAgent ./agentrunner/ && cd ..
```
Expected: FAIL (the current `LoadDefs` reads flat `.md` files at the root, so it'll find `flat.md` and not `my-agent/my-agent.md`).

**Step 4: Do not commit yet — commit after implementation**

---

### Task B2: Check if `Runner.Defs()` helper exists, or add it

**Files:**
- Modify: `backend/agentrunner/runner.go`

**Step 1: Search for existing accessor**

Run:
```
grep -n "func (r \*Runner) Defs" backend/agentrunner/runner.go
```

If it exists, use it. If not, add:
```go
// Defs returns a copy of the currently loaded agent definitions.
func (r *Runner) Defs() []*AgentDef {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*AgentDef, 0, len(r.defs))
	for _, d := range r.defs {
		out = append(out, d)
	}
	return out
}
```

Place it near `LoadDefs`. If the map is `map[string]*AgentDef` keyed differently, adjust accordingly. Read the `r.defs` type definition near the top of `runner.go` first.

---

### Task B3: Implement folder-per-agent loading

**Files:**
- Modify: `backend/agentrunner/runner.go` — `LoadDefs` (L71-117)
- Modify: `backend/agentrunner/parser.go` — `ParseAgentDef` signature/behavior

**Step 1: Update `ParseAgentDef` so folder name wins**

Change `ParseAgentDef` to accept an explicit `name` parameter and set `def.Name = name` after YAML parsing (overriding any frontmatter `name`). Also set `def.File` to the basename. New signature:
```go
func ParseAgentDef(data []byte, name, filename string) (*AgentDef, error)
```

In the body, after unmarshalling the YAML, do:
```go
def.Name = name
def.File = filename
```
Keep existing validation, but remove the "name required" error from frontmatter — the caller now supplies the name.

**Step 2: Update `LoadDefs` to walk subdirectories**

Rewrite `LoadDefs` to:
```go
func (r *Runner) LoadDefs() error {
	entries, err := os.ReadDir(r.cfg.AgentsDir)
	if err != nil {
		if os.IsNotExist(err) {
			r.mu.Lock()
			r.defs = map[string]*AgentDef{}
			r.mu.Unlock()
			return nil
		}
		return err
	}

	next := make(map[string]*AgentDef)
	for _, entry := range entries {
		if !entry.IsDir() {
			// Flat files at root are ignored.
			if strings.HasSuffix(entry.Name(), ".md") {
				log.Debug().Str("file", entry.Name()).Msg("agentrunner: ignoring flat .md file at agents root")
			}
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		filename := name + ".md"
		path := filepath.Join(r.cfg.AgentsDir, name, filename)
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				log.Warn().Str("agent", name).Str("expected", path).Msg("agentrunner: agent folder missing its .md file, skipping")
				continue
			}
			return err
		}
		def, err := ParseAgentDef(data, name, filename)
		if err != nil {
			log.Warn().Err(err).Str("agent", name).Msg("agentrunner: failed to parse agent definition")
			continue
		}
		next[name] = def
	}

	r.mu.Lock()
	r.defs = next
	r.mu.Unlock()
	return nil
}
```

Adjust the `r.defs` type (map key) to match existing shape — if today it's keyed by filename, change to keyed by agent name. Read the struct definition first and update other readers (`executeMatchingAgents`, `syncCronSchedules`) to match the new key.

**Step 3: Update all `ParseAgentDef` callers**

Find callers:
```
grep -n "ParseAgentDef(" backend/agentrunner
```

Update each call site — most should now come from `LoadDefs` only, but tests call it too. Update `parser_test.go` to pass both `name` and `filename`.

**Step 4: Run the new test**

Run:
```
cd backend && go test -v -run TestLoadDefsFolderPerAgent ./agentrunner/ && cd ..
```
Expected: PASS.

**Step 5: Run all agentrunner tests**

Run:
```
cd backend && go test -v ./agentrunner/ && cd ..
```
Expected: all pass. If any fail, read the failure and fix (most likely: older tests that called the old signature or relied on flat-file loading).

**Step 6: Commit**

Run:
```
git add backend/agentrunner/parser.go backend/agentrunner/parser_test.go \
        backend/agentrunner/runner.go backend/agentrunner/runner_test.go
git commit -m "agentrunner: load agent defs from per-agent subdirectories"
```

---

### Task B4: Update the fsnotify watcher to handle subdirectories

**Files:**
- Modify: `backend/agentrunner/runner.go` — `watchAgentsDir` (L276-333)

**Step 1: Change watch topology**

Current watcher adds a single watch on `AgentsDir` and filters `.md` events. Update it to:
1. Add a watch on `AgentsDir` (so new/removed subdirectories trigger events).
2. For each existing subdirectory, add a watch.
3. On any event:
   - If the event is on the root (subdir created): add a watch on the new subdir, reload.
   - If the event is on a subdir (any file change): reload.
4. Keep the 500 ms debounce.

Pseudocode replacement for the watcher loop:
```go
addedWatches := map[string]struct{}{r.cfg.AgentsDir: {}}
if err := watcher.Add(r.cfg.AgentsDir); err != nil {
    // handle
}

// Initial subdir watches
if entries, err := os.ReadDir(r.cfg.AgentsDir); err == nil {
    for _, e := range entries {
        if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
            p := filepath.Join(r.cfg.AgentsDir, e.Name())
            if err := watcher.Add(p); err == nil {
                addedWatches[p] = struct{}{}
            }
        }
    }
}

// In the event loop:
// - if event is on r.cfg.AgentsDir and Op has Create and it's a dir: watcher.Add(event.Name)
// - if event.Op has Remove/Rename: try watcher.Remove(event.Name) (ignore error), reload
// - any event: trigger debounced reload
```

Details to get right:
- When a new subdirectory is created, add a watch.
- When a subdirectory is deleted, `watcher.Add` may have lingering state — call `watcher.Remove`, ignore its error if the watch is already gone.
- `fsnotify` does not recurse. We must maintain watches manually.

**Step 2: Build**

Run:
```
cd backend && go build ./... && cd ..
```
Expected: exit 0.

**Step 3: Write an integration-ish test for watcher**

Add to `runner_test.go`:
```go
func TestWatcherReloadsOnNewAgentFolder(t *testing.T) {
	dir := t.TempDir()
	r := &Runner{cfg: Config{AgentsDir: dir, CronHook: nil, Hooks: hooks.NewRegistry()}}
	if err := r.LoadDefs(); err != nil {
		t.Fatalf("initial load: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.watchAgentsDir(ctx)

	// Give watcher time to attach
	time.Sleep(100 * time.Millisecond)

	// Create new agent folder + file
	agentDir := filepath.Join(dir, "new-agent")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	content := []byte(`---
agent: claude_code
trigger: cron
schedule: "0 3 * * *"
---
Hello.
`)
	if err := os.WriteFile(filepath.Join(agentDir, "new-agent.md"), content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Wait up to 2s for reload (500ms debounce + slack)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		defs := r.Defs()
		if len(defs) == 1 && defs[0].Name == "new-agent" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("watcher did not pick up new agent; defs=%+v", r.Defs())
}
```

Check whether `watchAgentsDir` needs exporting or a helper like `r.runWatcher(ctx)` exists. Read existing watcher signature first — adjust call accordingly.

**Step 4: Run watcher test**

Run:
```
cd backend && go test -v -run TestWatcherReloadsOnNewAgentFolder ./agentrunner/ && cd ..
```
Expected: PASS. If it's flaky under time sensitivity, increase deadline modestly (but do not exceed 5s).

**Step 5: Commit**

Run:
```
git add backend/agentrunner/runner.go backend/agentrunner/runner_test.go
git commit -m "agentrunner: watch per-agent subdirectories recursively"
```

---

## Phase C — API JSON includes `source` and `agentName`

### Task C1: Include `source` and `agentName` in list response

**Files:**
- Modify: `backend/api/agent_api.go` — `GetAgentSessions` (L115-190, specifically the map at L164-173)

**Step 1: Add fields**

Change the `entry` map from:
```go
entry := map[string]any{
    "id":           s.SessionID,
    "title":        s.Title,
    "workingDir":   s.WorkingDir,
    "agentType":    s.AgentType,
    "sessionState": state,
    "createdAt":    s.CreatedAt,
    "lastActivity": s.UpdatedAt,
}
```
to:
```go
entry := map[string]any{
    "id":           s.SessionID,
    "title":        s.Title,
    "workingDir":   s.WorkingDir,
    "agentType":    s.AgentType,
    "sessionState": state,
    "createdAt":    s.CreatedAt,
    "lastActivity": s.UpdatedAt,
    "source":       s.Source,
}
if s.AgentName != "" {
    entry["agentName"] = s.AgentName
}
```

**Step 2: Build**

Run:
```
cd backend && go build ./... && cd ..
```
Expected: exit 0.

---

### Task C2: Include `source` and `agentName` in single-session response

**Files:**
- Modify: `backend/api/agent_api.go` — `GetAgentSession` (L194-222, specifically the JSON at L213-221)

**Step 1: Add fields**

Change the response from:
```go
c.JSON(http.StatusOK, gin.H{
    "id":           session.SessionID,
    "title":        session.Title,
    "workingDir":   session.WorkingDir,
    "agentType":    session.AgentType,
    "sessionState": state,
    "createdAt":    session.CreatedAt,
    "lastActivity": session.UpdatedAt,
})
```
to:
```go
resp := gin.H{
    "id":           session.SessionID,
    "title":        session.Title,
    "workingDir":   session.WorkingDir,
    "agentType":    session.AgentType,
    "sessionState": state,
    "createdAt":    session.CreatedAt,
    "lastActivity": session.UpdatedAt,
    "source":       session.Source,
}
if session.AgentName != "" {
    resp["agentName"] = session.AgentName
}
c.JSON(http.StatusOK, resp)
```

**Step 2: Build**

Run:
```
cd backend && go build ./... && cd ..
```
Expected: exit 0.

**Step 3: Commit**

Run:
```
git add backend/api/agent_api.go
git commit -m "api: include source and agentName in agent-session list/get responses"
```

---

## Phase D — Frontend: TS rename + sectioned sidebar

### Task D1: Rename `agentFile` → `agentName` in TS types

**Files:**
- Modify: `frontend/app/routes/agent.tsx` — `Session` interface (L33-51)

**Step 1: Edit the interface**

Change:
```typescript
agentFile?: string
```
to:
```typescript
agentName?: string
```

**Step 2: Find other uses of `agentFile` in the frontend**

Run:
```
grep -rn "agentFile" frontend/app
```

For each hit, rename to `agentName`. If any are in JSX that displays the file (unlikely based on the report), update that display to show the agent name directly (no extension to strip).

**Step 3: Typecheck**

Run:
```
cd frontend && npm run typecheck && cd ..
```
Expected: no errors.

**Step 4: Commit**

Run:
```
git add frontend/app
git commit -m "frontend: rename Session.agentFile -> agentName"
```

---

### Task D2: Split sidebar into Auto / Manual sections

**Files:**
- Modify: `frontend/app/components/assistant-ui/thread-list.tsx`
- Possibly: `frontend/app/routes/agent.tsx` (if section-list must be composed at caller rather than inside ThreadList)

**Step 1: Read the full `ThreadList` component**

Read `thread-list.tsx` end-to-end. Understand how the list is currently rendered (likely via `@assistant-ui/react`'s `ThreadListPrimitive.Items` or a mapped array). The grouping implementation depends on this.

**Step 2: Decide placement**

If `ThreadList` renders a flat map over `sessions`, the cleanest path is to split inside `ThreadList` by consulting `sessionSources`:
- `autoIds`: item IDs where `sessionSources[id] === 'auto'`
- `manualIds`: everything else
Render two subsections with headers, counts, and hide empty sections.

If it uses `ThreadListPrimitive.Items` (which iterates by the library's internal order), grouping has to happen at the caller (`agent.tsx`) by passing two separate lists or by rendering two `ThreadList` instances with filtered sets. Adapt to whichever the code supports.

**Step 3: Implement the split**

Add two section headers:
```tsx
<div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
  Auto {autoCount > 0 && <span className="ml-1 opacity-70">({autoCount})</span>}
</div>
```
and
```tsx
<div className="px-2 pt-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
  Manual {manualCount > 0 && <span className="ml-1 opacity-70">({manualCount})</span>}
</div>
```

Hide the header + its section if that section is empty.

**Step 4: Typecheck**

Run:
```
cd frontend && npm run typecheck && cd ..
```
Expected: no errors.

**Step 5: Commit**

Run:
```
git add frontend/app
git commit -m "frontend: split agent sidebar into Auto and Manual sections"
```

---

### Task D3: Show `agentName` label on auto session rows

**Files:**
- Modify: `frontend/app/components/assistant-ui/thread-list.tsx` — `ThreadListItem` (L97-147)

**Step 1: Plumb `agentName` through**

`ThreadListItem` currently gets `sessionSources`. Add a parallel prop `sessionAgentNames?: Record<string, string>`. Construct it in `agent.tsx` next to `sessionSources`:
```typescript
const sessionAgentNames = useMemo(() => {
  const map: Record<string, string> = {}
  for (const s of sessions) {
    if (s.agentName) map[s.id] = s.agentName
  }
  return map
}, [sessions])
```
Pass `sessionAgentNames` into `ThreadList` and forward it to `ThreadListItem`.

**Step 2: Render the label**

In `ThreadListItem`, compute:
```typescript
const agentName = itemId ? sessionAgentNames?.[itemId] : undefined;
```
Below the primary title row, when `isAuto && agentName`, render:
```tsx
<div className="text-[11px] text-muted-foreground truncate">
  {agentName}
</div>
```
Keep it visually subordinate to the title.

**Step 3: Typecheck**

Run:
```
cd frontend && npm run typecheck && cd ..
```
Expected: no errors.

**Step 4: Commit**

Run:
```
git add frontend/app
git commit -m "frontend: show agent name under auto session rows"
```

---

## Phase E — Data migration and end-to-end verification

### Task E1: Move existing agent files into per-agent folders

**Files:**
- `/home/xiaoyuanzhu/my-life-db/data/agents/backup-xiaoyuanzhu-apps.md`
- `/home/xiaoyuanzhu/my-life-db/data/agents/vocabulary-flashcard.md`

Note: `data/agents/` is the LIVE data directory, outside the worktree. Confirm with the user before moving — it's a destructive filesystem change on real data. If approved, run:

```
cd /home/xiaoyuanzhu/my-life-db/data/agents
mkdir -p backup-xiaoyuanzhu-apps vocabulary-flashcard
mv backup-xiaoyuanzhu-apps.md backup-xiaoyuanzhu-apps/backup-xiaoyuanzhu-apps.md
mv vocabulary-flashcard.md vocabulary-flashcard/vocabulary-flashcard.md
```

Verify:
```
ls -l /home/xiaoyuanzhu/my-life-db/data/agents/backup-xiaoyuanzhu-apps/
ls -l /home/xiaoyuanzhu/my-life-db/data/agents/vocabulary-flashcard/
```

Do not commit — this is a data-dir change, not a repo change.

---

### Task E2: End-to-end smoke test

**Step 1: Start the backend with the worktree build**

Run (in a separate terminal or background):
```
cd backend && go run .
```
Expected: no startup errors; migration 021 applies cleanly (watch logs for `schema migration 21 applied`).

**Step 2: Start the frontend**

Run:
```
cd frontend && npm run dev
```

**Step 3: Open the Agent page**

In the browser, navigate to the Agent page. Verify:
- Sidebar shows two sections: Auto and Manual (Auto may be empty until an agent runs).
- Any sessions that were previously auto-initiated show under Auto with the "auto" badge and the agent name label.
- Manual sessions display unchanged.

**Step 4: Trigger an auto-run**

Pick one of the cron-scheduled agents and wait for a tick, OR temporarily set its schedule to `* * * * *` for the test (remember to revert).

Verify:
- A new session appears under Auto with the correct `agentName`.
- The "auto" badge is present.

**Step 5: Curl the API**

Run:
```
curl -s http://localhost:$PORT/api/agent/sessions/all?limit=5 | jq '.sessions[] | {id, source, agentName}'
```
Replace `$PORT` with the actual port. Expected: `source` present on every row, `agentName` present on auto rows.

**Step 6: Report results**

Report any discrepancies. Do not mark tasks complete if the smoke test reveals issues — fix them first.

---

## Phase F — Wrap up

### Task F1: Final review

**Step 1: Check full test suite**

Run:
```
cd backend && go test -v ./... && cd ..
```
Expected: all pass.

**Step 2: Typecheck frontend**

Run:
```
cd frontend && npm run typecheck && npm run lint && cd ..
```
Expected: no errors.

**Step 3: Confirm commits look clean**

Run:
```
git log origin/main..HEAD --oneline
```
Expected: commits roughly matching the task structure above.

**Step 4: Prompt the user for commit/push consent**

Say: *"All tasks complete and tests pass. Ready to push the branch and clean up the worktree?"* Wait for explicit `go` before pushing.

---

## Notes for the executor

- **Do not auto-push or auto-remove the worktree.** Per `CLAUDE.md`, push + rebase + clean up only after the user says `go`.
- **If a migration or test fails, stop.** Do not paper over with `git checkout .` or destructive commands. Investigate and report.
- **If the frontend grouping approach runs into `@assistant-ui/react` constraints** (e.g., `ThreadListPrimitive.Items` owns iteration), fall back to rendering two separate `ThreadList` instances with filtered session lists at the caller. The design's intent is visible two-group split, not a specific component shape.
- **Do not change title behavior.** Agent session titles remain whatever the runner passes in (`def.Name`). Dynamic titles are explicitly deferred.
