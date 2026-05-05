# Agent Trigger Path Filtering — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a required `path` glob field to file-trigger agents so the runner filters events before spawning sessions.

**Architecture:** Add `Path` field to `AgentDef`, validate it in the parser for file triggers, and glob-match in `executeMatchingAgents` using `doublestar`. Cron triggers are unaffected.

**Tech Stack:** Go, `github.com/bmatcuk/doublestar/v4`, existing `agentrunner` package.

---

### Task 1: Add `doublestar` dependency

**Files:**
- Modify: `backend/go.mod`

**Step 1: Add the dependency**

Run: `cd <worktree> && go get github.com/bmatcuk/doublestar/v4`

**Step 2: Verify**

Run: `grep doublestar backend/go.mod`
Expected: line containing `github.com/bmatcuk/doublestar/v4`

**Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "chore: add doublestar/v4 dependency for glob matching"
```

---

### Task 2: Add `Path` field to `AgentDef` and validate in parser

**Files:**
- Modify: `backend/agentrunner/parser.go`
- Test: `backend/agentrunner/parser_test.go`

**Step 1: Write failing tests**

Add these tests to `parser_test.go`:

```go
func TestParseFileAgentWithPath(t *testing.T) {
	input := `---
name: Inbox Watcher
agent: claude_code
trigger: file.created
path: "inbox/**"
---

Process the new file.
`
	def, err := ParseAgentDef([]byte(input), "inbox-watcher.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if def.Path != "inbox/**" {
		t.Errorf("Path = %q, want %q", def.Path, "inbox/**")
	}
}

func TestErrorOnFileCreatedWithoutPath(t *testing.T) {
	input := `---
name: No Path Agent
agent: claude_code
trigger: file.created
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "no-path.md")
	if err == nil {
		t.Fatal("expected error for file.created without path, got nil")
	}
}

func TestErrorOnFileChangedWithoutPath(t *testing.T) {
	input := `---
name: No Path Agent
agent: claude_code
trigger: file.changed
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "no-path.md")
	if err == nil {
		t.Fatal("expected error for file.changed without path, got nil")
	}
}

func TestErrorOnFileMovedWithoutPath(t *testing.T) {
	input := `---
name: No Path Agent
agent: claude_code
trigger: file.moved
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "no-path.md")
	if err == nil {
		t.Fatal("expected error for file.moved without path, got nil")
	}
}

func TestErrorOnFileDeletedWithoutPath(t *testing.T) {
	input := `---
name: No Path Agent
agent: claude_code
trigger: file.deleted
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "no-path.md")
	if err == nil {
		t.Fatal("expected error for file.deleted without path, got nil")
	}
}

func TestCronAgentIgnoresPath(t *testing.T) {
	input := `---
name: Daily Summary
agent: claude_code
trigger: cron
schedule: "0 9 * * *"
---

Generate a daily summary.
`
	def, err := ParseAgentDef([]byte(input), "daily-summary.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if def.Path != "" {
		t.Errorf("Path = %q, want empty for cron trigger", def.Path)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd <worktree> && go test ./backend/agentrunner/ -run "TestParseFileAgentWithPath|TestErrorOnFile|TestCronAgentIgnoresPath" -v`
Expected: `TestParseFileAgentWithPath` passes (field just empty), the four `TestErrorOnFile*WithoutPath` tests FAIL (no validation yet), `TestCronAgentIgnoresPath` passes.

**Step 3: Add `Path` field and validation to parser**

In `parser.go`, add the field to the struct:

```go
type AgentDef struct {
	Name     string `yaml:"name"`
	Agent    string `yaml:"agent"`
	Trigger  string `yaml:"trigger"`
	Schedule string `yaml:"schedule,omitempty"`
	Path     string `yaml:"path,omitempty"`
	Enabled  *bool  `yaml:"enabled,omitempty"`
	Prompt   string `yaml:"-"`
	File     string `yaml:"-"`
}
```

Add a helper function and validation after the existing cron check:

```go
// isFileTrigger reports whether the trigger is a file-based event.
func isFileTrigger(trigger string) bool {
	switch trigger {
	case "file.created", "file.changed", "file.moved", "file.deleted":
		return true
	}
	return false
}
```

Add this validation after the cron schedule check in `ParseAgentDef`:

```go
if isFileTrigger(def.Trigger) && def.Path == "" {
	return nil, fmt.Errorf("parsing %s: file trigger %q requires a \"path\" glob pattern", filename, def.Trigger)
}
```

**Step 4: Run tests to verify they pass**

Run: `cd <worktree> && go test ./backend/agentrunner/ -run "TestParseFileAgentWithPath|TestErrorOnFile|TestCronAgentIgnoresPath" -v`
Expected: ALL PASS

**Step 5: Fix existing tests that use file triggers without `path`**

The existing tests `TestParseCompleteFileCreatedAgent` and `TestDefaultEnabledTrue` use `file.created` without `path` — they will now fail. Update them:

In `TestParseCompleteFileCreatedAgent`, add `path: "inbox/**"` to the frontmatter:

```yaml
name: Organize Inbox
agent: claude_code
trigger: file.created
path: "inbox/**"
enabled: true
```

In `TestDefaultEnabledTrue`, add `path: "**"` to the frontmatter:

```yaml
name: Test Agent
agent: claude_code
trigger: file.created
path: "**"
```

In `TestEnabledFalse`, add `path: "**"` to the frontmatter:

```yaml
name: Disabled Agent
agent: claude_code
trigger: file.created
path: "**"
enabled: false
```

In `TestErrorOnMissingName`, add `path: "**"` to the frontmatter:

```yaml
agent: claude_code
trigger: file.created
path: "**"
```

**Step 6: Run all parser tests**

Run: `cd <worktree> && go test ./backend/agentrunner/ -run "TestParse|TestDefault|TestEnabled|TestError" -v`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add backend/agentrunner/parser.go backend/agentrunner/parser_test.go
git commit -m "feat: add required path field to AgentDef for file triggers"
```

---

### Task 3: Add glob filtering in `executeMatchingAgents`

**Files:**
- Modify: `backend/agentrunner/runner.go`
- Test: `backend/agentrunner/runner_test.go`

**Step 1: Write failing tests**

Update the `fileAgentMD` constant in `runner_test.go` to include `path`:

```go
const fileAgentMD = `---
name: file-watcher
agent: claude_code
trigger: file.created
path: "inbox/**"
---

Process the new file.
`
```

Add these tests to `runner_test.go`:

```go
func TestExecuteMatchingAgentsPathFilter(t *testing.T) {
	dir := t.TempDir()

	agentDef := `---
name: inbox-watcher
agent: claude_code
trigger: file.created
path: "inbox/**"
---

Process the new file.
`
	if err := os.WriteFile(filepath.Join(dir, "inbox-watcher.md"), []byte(agentDef), 0644); err != nil {
		t.Fatal(err)
	}

	var executed []string
	registry := hooks.NewRegistry()
	r := New(Config{
		AgentsDir: dir,
		Registry:  registry,
		CreateSession: func(ctx context.Context, params SessionParams) (agentsdk.Session, <-chan struct{}, error) {
			executed = append(executed, params.Title)
			return nil, nil, fmt.Errorf("test: skip session")
		},
	})

	if _, err := r.LoadDefs(); err != nil {
		t.Fatal(err)
	}

	// File in inbox/ — should match
	r.executeMatchingAgents(context.Background(), "file.created", hooks.Payload{
		EventType: hooks.EventFileCreated,
		Timestamp: time.Now(),
		Data: map[string]any{
			"path":   "inbox/receipt.pdf",
			"name":   "receipt.pdf",
			"folder": "inbox",
		},
	})

	// File outside inbox/ — should NOT match
	r.executeMatchingAgents(context.Background(), "file.created", hooks.Payload{
		EventType: hooks.EventFileCreated,
		Timestamp: time.Now(),
		Data: map[string]any{
			"path":   "explore/post.svg",
			"name":   "post.svg",
			"folder": "explore",
		},
	})

	if len(executed) != 1 {
		t.Fatalf("expected 1 execution, got %d: %v", len(executed), executed)
	}
	if executed[0] != "inbox-watcher" {
		t.Errorf("expected inbox-watcher, got %q", executed[0])
	}
}
```

Note: This test uses `CreateSession` which returns an error to avoid needing a real `agentsdk.Session`. The runner's `execute` method will log the error but `executeMatchingAgents` will still call it — that's what we're testing.

**Step 2: Run the test to verify it fails**

Run: `cd <worktree> && go test ./backend/agentrunner/ -run "TestExecuteMatchingAgentsPathFilter" -v`
Expected: FAIL — both events trigger execution (2 executions instead of 1).

**Step 3: Add glob matching to `executeMatchingAgents`**

In `runner.go`, add the import:

```go
import (
	// ... existing imports ...
	"github.com/bmatcuk/doublestar/v4"
)
```

Modify `executeMatchingAgents` to filter by path:

```go
func (r *Runner) executeMatchingAgents(ctx context.Context, trigger string, p hooks.Payload) {
	eventPath, _ := p.Data["path"].(string)

	r.mu.RLock()
	var matching []*AgentDef
	for _, def := range r.defs {
		if def.Trigger == trigger && def.Enabled != nil && *def.Enabled {
			// Filter by path glob if set
			if def.Path != "" && eventPath != "" {
				matched, err := doublestar.Match(def.Path, eventPath)
				if err != nil {
					log.Error().Err(err).Str("agent", def.Name).Str("pattern", def.Path).Msg("bad path glob pattern")
					continue
				}
				if !matched {
					continue
				}
			}
			matching = append(matching, def)
		}
	}
	r.mu.RUnlock()

	for _, def := range matching {
		r.execute(ctx, def, p)
	}
}
```

**Step 4: Run test to verify it passes**

Run: `cd <worktree> && go test ./backend/agentrunner/ -run "TestExecuteMatchingAgentsPathFilter" -v`
Expected: PASS

**Step 5: Fix existing runner tests**

Update the `disabledAgentMD` and `fileAgentMD` constants if not already done, and update `TestBuildPrompt` to set a `Path` on the def:

In `TestBuildPrompt`, add `Path: "inbox/**"` to the `AgentDef` literal (optional — `buildPrompt` doesn't use `Path`, but keeps the struct consistent).

**Step 6: Run all agentrunner tests**

Run: `cd <worktree> && go test ./backend/agentrunner/ -v`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add backend/agentrunner/runner.go backend/agentrunner/runner_test.go
git commit -m "feat: filter file-trigger agents by path glob before spawning sessions"
```

---

### Task 4: Update existing agent definitions

**Files:**
- Modify: `../../agents/vocabulary-flashcard.md` (relative to repo root: `/home/xiaoyuanzhu/my-life-db/data/agents/vocabulary-flashcard.md`)

**Step 1: Add `path` to vocabulary-flashcard.md frontmatter**

Add `path: "words/**"` to the YAML frontmatter:

```yaml
---
name: Vocabulary Flashcard
agent: claude_code
trigger: file.created
path: "words/**"
enabled: true
---
```

**Step 2: Remove self-filtering instructions from the prompt**

Remove this section from the prompt body:

```markdown
## When to act

Only process files created in the `words/` folder. If the file is NOT in `words/`, respond "Skipping, not a words file." and stop.
```

Replace with:

```markdown
## When to act

The trigger fires only for files created in the `words/` folder.
```

**Step 3: Commit**

```bash
git add ../../agents/vocabulary-flashcard.md
git commit -m "chore: add path filter to vocabulary-flashcard agent"
```

---

### Task 5: Update agent validation (if applicable)

**Files:**
- Check: `backend/api/` for any agent validation endpoint that parses agent defs

**Step 1: Search for validation code**

Run: `grep -r "ParseAgentDef\|AgentDef\|validateAgent\|ValidateAgent" <worktree>/backend/api/ --include="*.go"`

If there's a validation endpoint that calls `ParseAgentDef`, it will automatically enforce the new `path` requirement — no code change needed. Just verify by running the full test suite.

**Step 2: Run full test suite**

Run: `cd <worktree> && go test ./backend/... -v -count=1`
Expected: ALL PASS

**Step 3: Commit (only if changes were needed)**

---

### Task 6: Final verification

**Step 1: Build the project**

Run: `cd <worktree> && go build ./backend/...`
Expected: clean build, no errors

**Step 2: Run full test suite one more time**

Run: `cd <worktree> && go test ./backend/... -count=1`
Expected: ALL PASS
