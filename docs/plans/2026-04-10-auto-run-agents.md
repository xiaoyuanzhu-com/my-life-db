# Auto-Run Agents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable user-defined agents that run automatically in response to hooks (cron schedules, file system events), with every run creating a visible ACP session on the agent page.

**Architecture:** Two independent systems — a Hooks module (`backend/hooks/`) providing a general-purpose event registry, and an Agent Runner (`backend/agentrunner/`) that loads agent definitions from markdown files and spawns ACP sessions when triggers fire. The hooks module is a first-class MyLifeDB subsystem usable by any feature; the agent runner is just one consumer.

**Tech Stack:** Go, fsnotify (already in go.mod), robfig/cron/v3 (new dependency), existing agentsdk/ACP infrastructure

---

### Task 1: Add robfig/cron dependency

**Files:**
- Modify: `backend/go.mod`

**Step 1: Add the cron library**

Run:
```bash
cd backend && go get github.com/robfig/cron/v3
```

**Step 2: Verify it's in go.mod**

Run: `grep robfig backend/go.mod`
Expected: `github.com/robfig/cron/v3 v3.x.x`

**Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "deps: add robfig/cron for scheduled agent triggers"
```

---

### Task 2: Hooks module — core types and registry

**Files:**
- Create: `backend/hooks/hooks.go`
- Create: `backend/hooks/registry.go`
- Create: `backend/hooks/registry_test.go`

**Step 1: Write the test for registry subscribe + emit**

```go
// backend/hooks/registry_test.go
package hooks

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestRegistryEmitFansOutToSubscribers(t *testing.T) {
	r := NewRegistry()

	var mu sync.Mutex
	var received []Payload

	r.Subscribe(EventFileCreated, func(ctx context.Context, p Payload) {
		mu.Lock()
		received = append(received, p)
		mu.Unlock()
	})

	r.Emit(Payload{
		EventType: EventFileCreated,
		Timestamp: time.Now(),
		Data: map[string]any{
			"path": "inbox/test.pdf",
			"name": "test.pdf",
		},
	})

	// Give async dispatch a moment
	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 1 {
		t.Fatalf("expected 1 payload, got %d", len(received))
	}
	if received[0].Data["path"] != "inbox/test.pdf" {
		t.Fatalf("unexpected path: %v", received[0].Data["path"])
	}
}

func TestRegistryEmitOnlyMatchingSubscribers(t *testing.T) {
	r := NewRegistry()

	called := false
	r.Subscribe(EventCronTick, func(ctx context.Context, p Payload) {
		called = true
	})

	r.Emit(Payload{EventType: EventFileCreated})

	time.Sleep(10 * time.Millisecond)

	if called {
		t.Fatal("cron subscriber should not be called for file.created event")
	}
}

func TestRegistryMultipleSubscribersSameEvent(t *testing.T) {
	r := NewRegistry()

	var count int
	var mu sync.Mutex

	for i := 0; i < 3; i++ {
		r.Subscribe(EventFileCreated, func(ctx context.Context, p Payload) {
			mu.Lock()
			count++
			mu.Unlock()
		})
	}

	r.Emit(Payload{EventType: EventFileCreated})

	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if count != 3 {
		t.Fatalf("expected 3 calls, got %d", count)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test ./hooks/ -v`
Expected: FAIL (package doesn't exist yet)

**Step 3: Write the types and registry**

```go
// backend/hooks/hooks.go
package hooks

import "time"

// EventType identifies the kind of event.
type EventType string

const (
	// Time-based
	EventCronTick EventType = "cron.tick"

	// File system
	EventFileCreated EventType = "file.created"
	EventFileMoved   EventType = "file.moved"
	EventFileDeleted EventType = "file.deleted"
	EventFileChanged EventType = "file.changed"

	// Lifecycle
	EventAppStarted  EventType = "app.started"
	EventAppStopping EventType = "app.stopping"
)

// Payload is the universal event envelope.
type Payload struct {
	EventType EventType      `json:"event_type"`
	Timestamp time.Time      `json:"timestamp"`
	Data      map[string]any `json:"data"`
}

// Subscriber is a callback invoked when an event fires.
type Subscriber func(ctx context.Context, payload Payload)

// Hook is a source of events. Implementations detect events
// and call registry.Emit() to notify subscribers.
type Hook interface {
	Type() EventType
	Start(ctx context.Context) error
	Stop() error
}
```

```go
// backend/hooks/registry.go
package hooks

import (
	"context"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Registry manages hooks and fans out events to subscribers.
type Registry struct {
	mu          sync.RWMutex
	subscribers map[EventType][]Subscriber
	hooks       []Hook
	ctx         context.Context
	cancel      context.CancelFunc
}

// NewRegistry creates a new hook registry.
func NewRegistry() *Registry {
	return &Registry{
		subscribers: make(map[EventType][]Subscriber),
	}
}

// Register adds a hook to the registry.
func (r *Registry) Register(hook Hook) {
	r.mu.Lock()
	r.hooks = append(r.hooks, hook)
	r.mu.Unlock()
}

// Subscribe registers a callback for an event type.
func (r *Registry) Subscribe(eventType EventType, sub Subscriber) {
	r.mu.Lock()
	r.subscribers[eventType] = append(r.subscribers[eventType], sub)
	r.mu.Unlock()
}

// Emit dispatches a payload to all subscribers of its event type.
func (r *Registry) Emit(payload Payload) {
	r.mu.RLock()
	subs := r.subscribers[payload.EventType]
	r.mu.RUnlock()

	ctx := context.Background()
	if r.ctx != nil {
		ctx = r.ctx
	}

	for _, sub := range subs {
		sub := sub
		go sub(ctx, payload)
	}
}

// Start starts all registered hooks.
func (r *Registry) Start(ctx context.Context) error {
	r.ctx, r.cancel = context.WithCancel(ctx)
	for _, h := range r.hooks {
		if err := h.Start(r.ctx); err != nil {
			log.Error().Err(err).Str("hook", string(h.Type())).Msg("failed to start hook")
			return err
		}
		log.Info().Str("hook", string(h.Type())).Msg("hook started")
	}
	return nil
}

// Stop stops all registered hooks.
func (r *Registry) Stop() error {
	if r.cancel != nil {
		r.cancel()
	}
	for _, h := range r.hooks {
		if err := h.Stop(); err != nil {
			log.Error().Err(err).Str("hook", string(h.Type())).Msg("failed to stop hook")
		}
	}
	return nil
}
```

**Step 4: Run tests**

Run: `cd backend && go test ./hooks/ -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/hooks/
git commit -m "feat: add hooks module with event registry and core types"
```

---

### Task 3: CronHook implementation

**Files:**
- Create: `backend/hooks/cron_hook.go`
- Create: `backend/hooks/cron_hook_test.go`

**Step 1: Write the test**

```go
// backend/hooks/cron_hook_test.go
package hooks

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestCronHookEmitsOnSchedule(t *testing.T) {
	r := NewRegistry()

	var mu sync.Mutex
	var received []Payload

	r.Subscribe(EventCronTick, func(ctx context.Context, p Payload) {
		mu.Lock()
		received = append(received, p)
		mu.Unlock()
	})

	cron := NewCronHook(r)
	r.Register(cron)

	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer r.Stop()

	// Schedule every second
	if err := cron.AddSchedule("test-job", "* * * * * *"); err != nil {
		t.Fatal(err)
	}

	// Wait for at least one tick
	time.Sleep(1500 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) == 0 {
		t.Fatal("expected at least one cron.tick event")
	}
	if received[0].Data["name"] != "test-job" {
		t.Fatalf("unexpected name: %v", received[0].Data["name"])
	}
}

func TestCronHookRemoveSchedule(t *testing.T) {
	r := NewRegistry()

	var mu sync.Mutex
	var count int

	r.Subscribe(EventCronTick, func(ctx context.Context, p Payload) {
		mu.Lock()
		count++
		mu.Unlock()
	})

	cron := NewCronHook(r)
	r.Register(cron)

	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer r.Stop()

	if err := cron.AddSchedule("remove-me", "* * * * * *"); err != nil {
		t.Fatal(err)
	}

	time.Sleep(1500 * time.Millisecond)

	cron.RemoveSchedule("remove-me")

	mu.Lock()
	countBefore := count
	mu.Unlock()

	time.Sleep(1500 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if count != countBefore {
		t.Fatalf("schedule should have stopped, but count went from %d to %d", countBefore, count)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test ./hooks/ -run TestCronHook -v`
Expected: FAIL

**Step 3: Implement CronHook**

```go
// backend/hooks/cron_hook.go
package hooks

import (
	"context"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// CronHook manages named cron schedules and emits cron.tick events.
type CronHook struct {
	registry  *Registry
	scheduler *cron.Cron
	mu        sync.Mutex
	entries   map[string]cron.EntryID // name → entry ID
}

// NewCronHook creates a CronHook. Uses second-precision cron for flexibility.
func NewCronHook(registry *Registry) *CronHook {
	return &CronHook{
		registry:  registry,
		scheduler: cron.New(cron.WithSeconds()),
		entries:   make(map[string]cron.EntryID),
	}
}

func (h *CronHook) Type() EventType { return EventCronTick }

func (h *CronHook) Start(ctx context.Context) error {
	h.scheduler.Start()
	return nil
}

func (h *CronHook) Stop() error {
	stopCtx := h.scheduler.Stop()
	<-stopCtx.Done()
	return nil
}

// AddSchedule registers a named cron schedule. If a schedule with the same
// name exists, it is replaced.
func (h *CronHook) AddSchedule(name string, expr string) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Remove existing if present
	if id, ok := h.entries[name]; ok {
		h.scheduler.Remove(id)
		delete(h.entries, name)
	}

	id, err := h.scheduler.AddFunc(expr, func() {
		h.registry.Emit(Payload{
			EventType: EventCronTick,
			Timestamp: time.Now(),
			Data: map[string]any{
				"name":     name,
				"schedule": expr,
			},
		})
		log.Debug().Str("name", name).Str("schedule", expr).Msg("cron.tick emitted")
	})
	if err != nil {
		return err
	}

	h.entries[name] = id
	log.Info().Str("name", name).Str("schedule", expr).Msg("cron schedule added")
	return nil
}

// RemoveSchedule removes a named cron schedule.
func (h *CronHook) RemoveSchedule(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if id, ok := h.entries[name]; ok {
		h.scheduler.Remove(id)
		delete(h.entries, name)
		log.Info().Str("name", name).Msg("cron schedule removed")
	}
}
```

**Step 4: Run tests**

Run: `cd backend && go test ./hooks/ -run TestCronHook -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/hooks/cron_hook.go backend/hooks/cron_hook_test.go
git commit -m "feat: add CronHook with dynamic schedule management"
```

---

### Task 4: FSHook implementation

The FSHook bridges the existing `fs.Service` file change events into the hooks system. Rather than running its own fsnotify watcher (which would duplicate `fs.Service`), the FSHook provides an `EmitFileEvent` method that the server wires up as a handler on `fs.Service`.

**Files:**
- Create: `backend/hooks/fs_hook.go`
- Create: `backend/hooks/fs_hook_test.go`

**Step 1: Write the test**

```go
// backend/hooks/fs_hook_test.go
package hooks

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestFSHookEmitFileCreated(t *testing.T) {
	r := NewRegistry()

	var mu sync.Mutex
	var received []Payload

	r.Subscribe(EventFileCreated, func(ctx context.Context, p Payload) {
		mu.Lock()
		received = append(received, p)
		mu.Unlock()
	})

	fsh := NewFSHook(r)
	r.Register(fsh)

	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer r.Stop()

	fsh.EmitFileEvent(EventFileCreated, map[string]any{
		"path":      "inbox/receipt.pdf",
		"name":      "receipt.pdf",
		"folder":    "inbox",
		"size":      int64(1024),
		"mime_type": "application/pdf",
	})

	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 1 {
		t.Fatalf("expected 1 event, got %d", len(received))
	}
	if received[0].Data["path"] != "inbox/receipt.pdf" {
		t.Fatalf("unexpected path: %v", received[0].Data["path"])
	}
}

func TestFSHookEmitFileMoved(t *testing.T) {
	r := NewRegistry()

	var received []Payload
	var mu sync.Mutex

	r.Subscribe(EventFileMoved, func(ctx context.Context, p Payload) {
		mu.Lock()
		received = append(received, p)
		mu.Unlock()
	})

	fsh := NewFSHook(r)
	r.Register(fsh)
	r.Start(context.Background())
	defer r.Stop()

	fsh.EmitFileEvent(EventFileMoved, map[string]any{
		"from_path": "inbox/doc.pdf",
		"to_path":   "documents/doc.pdf",
		"name":      "doc.pdf",
	})

	time.Sleep(10 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 1 {
		t.Fatalf("expected 1 event, got %d", len(received))
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test ./hooks/ -run TestFSHook -v`
Expected: FAIL

**Step 3: Implement FSHook**

```go
// backend/hooks/fs_hook.go
package hooks

import (
	"context"
	"time"
)

// FSHook bridges file system events into the hooks registry.
// It does not run its own watcher — instead, the server wires
// fs.Service change events to call EmitFileEvent.
type FSHook struct {
	registry *Registry
}

// NewFSHook creates an FSHook.
func NewFSHook(registry *Registry) *FSHook {
	return &FSHook{registry: registry}
}

func (h *FSHook) Type() EventType { return EventFileCreated }

func (h *FSHook) Start(ctx context.Context) error { return nil }
func (h *FSHook) Stop() error                     { return nil }

// EmitFileEvent emits a file event with the given data.
// Called by the server when fs.Service detects a file change.
func (h *FSHook) EmitFileEvent(eventType EventType, data map[string]any) {
	h.registry.Emit(Payload{
		EventType: eventType,
		Timestamp: time.Now(),
		Data:      data,
	})
}
```

**Step 4: Run tests**

Run: `cd backend && go test ./hooks/ -run TestFSHook -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/hooks/fs_hook.go backend/hooks/fs_hook_test.go
git commit -m "feat: add FSHook for bridging fs.Service events to hooks registry"
```

---

### Task 5: Agent Runner — markdown parser

**Files:**
- Create: `backend/agentrunner/parser.go`
- Create: `backend/agentrunner/parser_test.go`

**Step 1: Write the test**

```go
// backend/agentrunner/parser_test.go
package agentrunner

import (
	"testing"
)

func TestParseAgentDef(t *testing.T) {
	content := `---
name: Organize Inbox
agent: claude_code
trigger: file.created
enabled: true
---

You are an inbox organizer.

When a new file arrives in the inbox, analyze it.
`

	def, err := ParseAgentDef("organize-inbox.md", []byte(content))
	if err != nil {
		t.Fatal(err)
	}
	if def.Name != "Organize Inbox" {
		t.Fatalf("unexpected name: %q", def.Name)
	}
	if def.Agent != "claude_code" {
		t.Fatalf("unexpected agent: %q", def.Agent)
	}
	if def.Trigger != "file.created" {
		t.Fatalf("unexpected trigger: %q", def.Trigger)
	}
	if !def.Enabled {
		t.Fatal("expected enabled=true")
	}
	if def.Prompt == "" {
		t.Fatal("expected non-empty prompt")
	}
	if def.Prompt != "You are an inbox organizer.\n\nWhen a new file arrives in the inbox, analyze it.\n" {
		t.Fatalf("unexpected prompt: %q", def.Prompt)
	}
}

func TestParseAgentDefCron(t *testing.T) {
	content := `---
name: Daily Backup
agent: claude_code
trigger: cron
schedule: "0 2 * * *"
---

SSH into macmini and run backup.
`

	def, err := ParseAgentDef("daily-backup.md", []byte(content))
	if err != nil {
		t.Fatal(err)
	}
	if def.Trigger != "cron" {
		t.Fatalf("unexpected trigger: %q", def.Trigger)
	}
	if def.Schedule != "0 2 * * *" {
		t.Fatalf("unexpected schedule: %q", def.Schedule)
	}
}

func TestParseAgentDefDefaultEnabled(t *testing.T) {
	content := `---
name: Test
agent: claude_code
trigger: file.created
---

Do something.
`

	def, err := ParseAgentDef("test.md", []byte(content))
	if err != nil {
		t.Fatal(err)
	}
	if !def.Enabled {
		t.Fatal("expected enabled=true by default")
	}
}

func TestParseAgentDefDisabled(t *testing.T) {
	content := `---
name: Disabled Agent
agent: claude_code
trigger: cron
schedule: "0 0 * * *"
enabled: false
---

Disabled.
`

	def, err := ParseAgentDef("disabled.md", []byte(content))
	if err != nil {
		t.Fatal(err)
	}
	if def.Enabled {
		t.Fatal("expected enabled=false")
	}
}

func TestParseAgentDefMissingRequired(t *testing.T) {
	content := `---
agent: claude_code
trigger: file.created
---

Missing name.
`

	_, err := ParseAgentDef("bad.md", []byte(content))
	if err == nil {
		t.Fatal("expected error for missing name")
	}
}

func TestParseAgentDefCronMissingSchedule(t *testing.T) {
	content := `---
name: Bad Cron
agent: claude_code
trigger: cron
---

No schedule.
`

	_, err := ParseAgentDef("bad-cron.md", []byte(content))
	if err == nil {
		t.Fatal("expected error for cron trigger without schedule")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test ./agentrunner/ -v`
Expected: FAIL

**Step 3: Implement parser**

```go
// backend/agentrunner/parser.go
package agentrunner

import (
	"bytes"
	"fmt"

	"gopkg.in/yaml.v3"
)

// AgentDef is a parsed agent markdown definition.
type AgentDef struct {
	Name     string `yaml:"name"`
	Agent    string `yaml:"agent"`
	Trigger  string `yaml:"trigger"`
	Schedule string `yaml:"schedule,omitempty"`
	Enabled  *bool  `yaml:"enabled,omitempty"`
	Prompt   string `yaml:"-"` // markdown body below frontmatter
	File     string `yaml:"-"` // source filename
}

// IsEnabled returns whether this agent is enabled (default true).
func (d *AgentDef) IsEnabled() bool {
	if d.Enabled == nil {
		return true
	}
	return *d.Enabled
}

// ParseAgentDef parses a markdown file with YAML frontmatter into an AgentDef.
func ParseAgentDef(filename string, data []byte) (*AgentDef, error) {
	// Split frontmatter from body
	parts := bytes.SplitN(data, []byte("---"), 3)
	if len(parts) < 3 {
		return nil, fmt.Errorf("%s: missing YAML frontmatter (expected --- delimiters)", filename)
	}

	var def AgentDef
	if err := yaml.Unmarshal(parts[1], &def); err != nil {
		return nil, fmt.Errorf("%s: invalid frontmatter: %w", filename, err)
	}

	def.File = filename
	def.Prompt = string(bytes.TrimLeft(parts[2], "\n"))

	// Use the Enabled field for IsEnabled but also set the exported bool
	// for simpler access in tests
	enabled := def.IsEnabled()
	def.Enabled = &enabled

	// Validate required fields
	if def.Name == "" {
		return nil, fmt.Errorf("%s: missing required field: name", filename)
	}
	if def.Agent == "" {
		return nil, fmt.Errorf("%s: missing required field: agent", filename)
	}
	if def.Trigger == "" {
		return nil, fmt.Errorf("%s: missing required field: trigger", filename)
	}
	if def.Trigger == "cron" && def.Schedule == "" {
		return nil, fmt.Errorf("%s: cron trigger requires schedule field", filename)
	}

	return &def, nil
}
```

Note: check if `gopkg.in/yaml.v3` is already in go.mod. If not, run `go get gopkg.in/yaml.v3`.

**Step 4: Run tests**

Run: `cd backend && go test ./agentrunner/ -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/agentrunner/
git commit -m "feat: add agent definition markdown parser with frontmatter support"
```

---

### Task 6: Agent Runner — core service

**Files:**
- Create: `backend/agentrunner/runner.go`
- Create: `backend/agentrunner/runner_test.go`

**Step 1: Write the test**

```go
// backend/agentrunner/runner_test.go
package agentrunner

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/xiaoyuanzhu-com/my-life-db/hooks"
)

func TestRunnerLoadsAgentDefs(t *testing.T) {
	dir := t.TempDir()

	// Write a test agent file
	content := []byte(`---
name: Test Agent
agent: claude_code
trigger: file.created
---

Test prompt.
`)
	if err := os.WriteFile(filepath.Join(dir, "test-agent.md"), content, 0644); err != nil {
		t.Fatal(err)
	}

	registry := hooks.NewRegistry()
	runner := New(Config{
		AgentsDir: dir,
		Registry:  registry,
	})

	defs, err := runner.LoadDefs()
	if err != nil {
		t.Fatal(err)
	}

	if len(defs) != 1 {
		t.Fatalf("expected 1 def, got %d", len(defs))
	}
	if defs[0].Name != "Test Agent" {
		t.Fatalf("unexpected name: %q", defs[0].Name)
	}
}

func TestRunnerSkipsDisabledAgents(t *testing.T) {
	dir := t.TempDir()

	content := []byte(`---
name: Disabled
agent: claude_code
trigger: file.created
enabled: false
---

Disabled agent.
`)
	if err := os.WriteFile(filepath.Join(dir, "disabled.md"), content, 0644); err != nil {
		t.Fatal(err)
	}

	registry := hooks.NewRegistry()
	runner := New(Config{
		AgentsDir: dir,
		Registry:  registry,
	})

	defs, err := runner.LoadDefs()
	if err != nil {
		t.Fatal(err)
	}

	// LoadDefs returns all defs; the runner filters on registration
	if len(defs) != 1 {
		t.Fatalf("expected 1 def, got %d", len(defs))
	}
	if *defs[0].Enabled {
		t.Fatal("expected enabled=false")
	}
}

func TestRunnerSkipsNonMarkdownFiles(t *testing.T) {
	dir := t.TempDir()

	os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("not an agent"), 0644)
	os.WriteFile(filepath.Join(dir, ".hidden.md"), []byte("---\nname: Hidden\nagent: x\ntrigger: y\n---\nhidden"), 0644)

	registry := hooks.NewRegistry()
	runner := New(Config{
		AgentsDir: dir,
		Registry:  registry,
	})

	defs, err := runner.LoadDefs()
	if err != nil {
		t.Fatal(err)
	}

	if len(defs) != 0 {
		t.Fatalf("expected 0 defs (non-md and hidden should be skipped), got %d", len(defs))
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd backend && go test ./agentrunner/ -run TestRunner -v`
Expected: FAIL

**Step 3: Implement the runner**

```go
// backend/agentrunner/runner.go
package agentrunner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/hooks"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Config configures the agent runner.
type Config struct {
	AgentsDir   string           // path to agents/ folder
	Registry    *hooks.Registry  // hooks registry to subscribe to
	CronHook    *hooks.CronHook  // for registering cron schedules
	AgentClient *agentsdk.Client // for spawning ACP sessions
	WorkingDir  string           // working directory for agent sessions
	// OnSessionCreated is called when the runner creates a new ACP session.
	// The server uses this to persist the session in the DB and wire up
	// frame broadcasting. Parameters: sessionID, agentDef, triggerPayload.
	OnSessionCreated func(sessionID string, def *AgentDef, payload hooks.Payload)
}

// Runner loads agent definitions and triggers ACP sessions in response to hooks.
type Runner struct {
	cfg  Config
	mu   sync.RWMutex
	defs []*AgentDef // currently loaded definitions
}

// New creates an agent runner.
func New(cfg Config) *Runner {
	return &Runner{cfg: cfg}
}

// LoadDefs scans the agents directory for *.md files and parses them.
func (r *Runner) LoadDefs() ([]*AgentDef, error) {
	entries, err := os.ReadDir(r.cfg.AgentsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read agents dir: %w", err)
	}

	var defs []*AgentDef
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".md") || strings.HasPrefix(name, ".") {
			continue
		}

		data, err := os.ReadFile(filepath.Join(r.cfg.AgentsDir, name))
		if err != nil {
			log.Error().Err(err).Str("file", name).Msg("failed to read agent file")
			continue
		}

		def, err := ParseAgentDef(name, data)
		if err != nil {
			log.Error().Err(err).Str("file", name).Msg("failed to parse agent file")
			continue
		}

		defs = append(defs, def)
	}

	return defs, nil
}

// Start loads agent definitions, registers triggers, and begins listening.
func (r *Runner) Start(ctx context.Context) error {
	defs, err := r.LoadDefs()
	if err != nil {
		return err
	}

	r.mu.Lock()
	r.defs = defs
	r.mu.Unlock()

	enabledCount := 0
	for _, def := range defs {
		if !def.IsEnabled() {
			log.Info().Str("name", def.Name).Msg("agent disabled, skipping")
			continue
		}
		enabledCount++

		if err := r.registerTrigger(def); err != nil {
			log.Error().Err(err).Str("name", def.Name).Msg("failed to register trigger")
			continue
		}

		log.Info().
			Str("name", def.Name).
			Str("trigger", def.Trigger).
			Str("file", def.File).
			Msg("agent registered")
	}

	log.Info().Int("total", len(defs)).Int("enabled", enabledCount).Msg("agent runner started")
	return nil
}

// registerTrigger subscribes to the appropriate hook for an agent definition.
func (r *Runner) registerTrigger(def *AgentDef) error {
	switch def.Trigger {
	case "cron":
		if r.cfg.CronHook == nil {
			return fmt.Errorf("cron hook not available")
		}
		// Register the cron schedule
		if err := r.cfg.CronHook.AddSchedule(def.Name, def.Schedule); err != nil {
			return fmt.Errorf("add cron schedule: %w", err)
		}
		// Subscribe to cron ticks for this agent
		r.cfg.Registry.Subscribe(hooks.EventCronTick, func(ctx context.Context, p hooks.Payload) {
			name, _ := p.Data["name"].(string)
			if name == def.Name {
				r.execute(ctx, def, p)
			}
		})

	default:
		// Subscribe to the event type directly (e.g., file.created, file.moved)
		eventType := hooks.EventType(def.Trigger)
		r.cfg.Registry.Subscribe(eventType, func(ctx context.Context, p hooks.Payload) {
			r.execute(ctx, def, p)
		})
	}

	return nil
}

// execute spawns an ACP session for an agent definition.
func (r *Runner) execute(ctx context.Context, def *AgentDef, payload hooks.Payload) {
	if r.cfg.AgentClient == nil {
		log.Warn().Str("name", def.Name).Msg("agent client not configured, skipping execution")
		return
	}

	log.Info().
		Str("name", def.Name).
		Str("trigger", def.Trigger).
		Str("event", string(payload.EventType)).
		Msg("triggering auto-run agent")

	// Build prompt with trigger context
	prompt := r.buildPrompt(def, payload)

	// Create ACP session
	sess, err := r.cfg.AgentClient.CreateSession(ctx, agentsdk.SessionConfig{
		Agent:      agentsdk.AgentType(def.Agent),
		WorkingDir: r.cfg.WorkingDir,
		Mode:       "bypassPermissions",
	})
	if err != nil {
		log.Error().Err(err).Str("name", def.Name).Msg("failed to create auto-run session")
		return
	}

	// Notify server to persist session + wire frame broadcasting
	if r.cfg.OnSessionCreated != nil {
		r.cfg.OnSessionCreated(sess.ID(), def, payload)
	}

	// Send prompt (non-blocking — frames flow through onFrame handler)
	go func() {
		frames, err := sess.Send(ctx, prompt)
		if err != nil {
			log.Error().Err(err).Str("name", def.Name).Str("sessionId", sess.ID()).Msg("failed to send prompt to auto-run agent")
			return
		}
		// Drain frames to let the session complete
		for range frames {
		}
		log.Info().Str("name", def.Name).Str("sessionId", sess.ID()).Msg("auto-run agent completed")
	}()
}

// buildPrompt combines the agent's prompt with trigger context.
func (r *Runner) buildPrompt(def *AgentDef, payload hooks.Payload) string {
	var b strings.Builder

	// Trigger context header
	b.WriteString("[Trigger Context]\n")
	b.WriteString(fmt.Sprintf("Event: %s\n", payload.EventType))
	b.WriteString(fmt.Sprintf("Time: %s\n", payload.Timestamp.Format("2006-01-02T15:04:05Z07:00")))
	for k, v := range payload.Data {
		b.WriteString(fmt.Sprintf("%s: %v\n", strings.Title(strings.ReplaceAll(k, "_", " ")), v))
	}
	b.WriteString("\n---\n\n")

	// Agent prompt
	b.WriteString(def.Prompt)

	return b.String()
}

// Stop cleans up the runner.
func (r *Runner) Stop() error {
	// Cron schedules are cleaned up when the CronHook stops.
	// Active sessions are cleaned up when the AgentClient shuts down.
	return nil
}
```

**Step 4: Run tests**

Run: `cd backend && go test ./agentrunner/ -v`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/agentrunner/
git commit -m "feat: add agent runner service with trigger registration and ACP execution"
```

---

### Task 7: DB migration — add source field to agent_sessions

**Files:**
- Create: `backend/db/migration_020_agent_session_source.go`
- Modify: `backend/db/migrations.go` (add to migration list)
- Modify: `backend/db/agent_sessions.go` (update struct + queries)

**Step 1: Write the migration**

```go
// backend/db/migration_020_agent_session_source.go
package db

func migration020AgentSessionSource(d *DB) error {
	_, err := d.GetDB().Exec(`
		ALTER TABLE agent_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
		ALTER TABLE agent_sessions ADD COLUMN agent_file TEXT NOT NULL DEFAULT '';
	`)
	return err
}
```

Note: `source` is "user" (default, on-demand) or "auto" (triggered by agent runner). `agent_file` is the filename of the agent definition (e.g., "organize-inbox.md").

**Step 2: Register migration in migrations.go**

Add `migration020AgentSessionSource` to the migrations slice in `backend/db/migrations.go`.

**Step 3: Update AgentSessionRecord struct**

Add `Source` and `AgentFile` fields to the struct in `backend/db/agent_sessions.go`:

```go
Source   string `json:"source"`    // "user" or "auto"
AgentFile string `json:"agentFile"` // agent definition filename (for auto sessions)
```

**Step 4: Update CreateAgentSession**

Add `source` and `agent_file` parameters. Update the INSERT query to include them.

**Step 5: Update ListAgentSessions query**

Ensure the SELECT includes the new columns and they're scanned into the struct.

**Step 6: Test on fresh database**

Run: `cd backend && rm -rf .my-life-db/ && go run .`
Expected: Server starts without errors, migration applies cleanly.

**Step 7: Commit**

```bash
git add backend/db/migration_020_agent_session_source.go backend/db/migrations.go backend/db/agent_sessions.go
git commit -m "feat: add source and agent_file columns to agent_sessions table"
```

---

### Task 8: Wire hooks + agent runner into server

**Files:**
- Modify: `backend/server/server.go` (add hooks registry, FSHook, CronHook, agent runner)

**Step 1: Add fields to Server struct**

```go
hookRegistry *hooks.Registry
cronHook     *hooks.CronHook
fsHook       *hooks.FSHook
agentRunner  *agentrunner.Runner
```

**Step 2: Initialize in `New()`**

After agent client initialization, before `connectServices()`:

```go
// Hooks registry
s.hookRegistry = hooks.NewRegistry()
s.cronHook = hooks.NewCronHook(s.hookRegistry)
s.fsHook = hooks.NewFSHook(s.hookRegistry)
s.hookRegistry.Register(s.cronHook)
s.hookRegistry.Register(s.fsHook)

// Agent runner
agentsDir := filepath.Join(cfg.UserDataDir, "agents")
s.agentRunner = agentrunner.New(agentrunner.Config{
    AgentsDir:   agentsDir,
    Registry:    s.hookRegistry,
    CronHook:    s.cronHook,
    AgentClient: s.agentClient,
    WorkingDir:  cfg.UserDataDir,
    OnSessionCreated: func(sessionID string, def *agentrunner.AgentDef, payload hooks.Payload) {
        // Persist to DB
        db.CreateAgentSession(sessionID, def.Agent, cfg.UserDataDir, def.Name, "auto", def.File)
        // Wire frame broadcasting (same pattern as agent_api.go CreateAgentSession)
        sessionState := agentsdk.GetOrCreateSessionState(sessionID)
        if sess := agentsdk.GetAcpSession(sessionID); sess != nil {
            sess.SetOnFrame(func(data []byte) {
                sessionState.AppendAndBroadcast(data)
            })
        }
    },
})
```

**Step 3: Wire FSHook into fs.Service change handler**

In `connectServices()`, add FSHook emission alongside the existing digest worker trigger. When `fs.Service` detects a file change, also emit to the hooks registry:

```go
// Inside the fs.Service file change handler:
if event.IsNew {
    s.fsHook.EmitFileEvent(hooks.EventFileCreated, map[string]any{
        "path":   event.FilePath,
        "name":   filepath.Base(event.FilePath),
        "folder": filepath.Dir(event.FilePath),
    })
} else if event.ContentChanged {
    s.fsHook.EmitFileEvent(hooks.EventFileChanged, map[string]any{
        "path": event.FilePath,
        "name": filepath.Base(event.FilePath),
        "size": int64(0), // size not available from FileChangeEvent
    })
}
```

Note: File move and delete events will need to be wired from the fs.Service move detector and delete operations respectively. Check `fs/service.go` for where moves and deletes are handled and emit the corresponding hook events there.

**Step 4: Start hooks + runner in `Start()`**

```go
// Start hooks registry (starts all registered hooks including CronHook)
if err := s.hookRegistry.Start(s.shutdownCtx); err != nil {
    log.Error().Err(err).Msg("failed to start hooks registry")
}

// Start agent runner (loads defs, registers triggers)
if err := s.agentRunner.Start(s.shutdownCtx); err != nil {
    log.Error().Err(err).Msg("failed to start agent runner")
}
```

**Step 5: Stop in `Shutdown()`**

```go
s.agentRunner.Stop()
s.hookRegistry.Stop()
```

**Step 6: Test — verify server starts cleanly**

Run: `cd backend && go build .`
Expected: Compiles without errors.

Run: `cd backend && go run .`
Expected: Logs show "hook started" for cron and FS hooks, "agent runner started" with 0 agents (no agents/ dir yet).

**Step 7: Commit**

```bash
git add backend/server/server.go
git commit -m "feat: wire hooks registry and agent runner into server lifecycle"
```

---

### Task 9: Frontend — "auto" badge on agent sessions

**Files:**
- Modify: `frontend/app/routes/agent.tsx` (add source field to Session interface, render badge)

**Step 1: Add source to Session interface**

```typescript
interface Session {
  // ... existing fields ...
  source?: 'user' | 'auto'
  agentFile?: string
}
```

**Step 2: Add badge rendering**

In the session list item component, add a small badge when `session.source === 'auto'`:

```tsx
{session.source === 'auto' && (
  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
    auto
  </span>
)}
```

**Step 3: Verify the list API returns the new fields**

Check `backend/api/agent_api.go` — the `GetAgentSessions` handler should already return the new fields since they're part of `AgentSessionRecord` with json tags.

**Step 4: Build frontend**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: No type errors, build succeeds.

**Step 5: Commit**

```bash
git add frontend/app/routes/agent.tsx
git commit -m "feat: show 'auto' badge on auto-triggered agent sessions"
```

---

### Task 10: End-to-end test — create an agent and verify trigger

**Step 1: Create the agents directory**

```bash
mkdir -p $USER_DATA_DIR/agents
```

**Step 2: Write a test agent**

Create `$USER_DATA_DIR/agents/test-echo.md`:

```markdown
---
name: Test Echo
agent: claude_code
trigger: file.created
---

A new file was detected. Simply respond with:
"I see the file: [filename]. This is a test of the auto-run agent system."

Do not take any other action.
```

**Step 3: Start the server and drop a file into the data directory**

Run the server, then create a test file. Watch the logs for:
- "agent registered" for "Test Echo"
- "triggering auto-run agent" when the file is created
- A new session appearing on the agent page with the "auto" badge

**Step 4: Verify the session**

Open `https://my.xiaoyuanzhu.com/agent` and confirm:
- The session appears in the list
- It has the "auto" badge
- The conversation shows the trigger context and the agent's response

**Step 5: Clean up**

Remove the test agent file. Verify the agent is no longer triggered on subsequent file changes.

---

### Task 11: Agent runner — hot reload (watch agents/ folder)

**Files:**
- Modify: `backend/agentrunner/runner.go` (add file watching)

**Step 1: Add fsnotify watcher on agents/ directory**

In `Start()`, after loading initial defs, set up a goroutine that watches the agents directory for changes. On any change (create, modify, delete .md file), re-run `LoadDefs()` and diff against current state:

- New file → parse + register trigger
- Modified file → re-parse + update trigger (remove old, register new)
- Deleted file → remove trigger (remove cron schedule if applicable)

**Step 2: Test hot reload**

With server running:
1. Create a new agent .md file → verify it's picked up and registered (check logs)
2. Edit the file (change trigger) → verify old trigger removed, new one registered
3. Delete the file → verify trigger removed

**Step 3: Commit**

```bash
git add backend/agentrunner/runner.go
git commit -m "feat: add hot reload for agent definitions via fsnotify"
```

---

### Summary of Implementation Order

| Task | What | Depends On |
|------|------|-----------|
| 1 | Add robfig/cron dependency | — |
| 2 | Hooks module: types + registry | — |
| 3 | CronHook | 1, 2 |
| 4 | FSHook | 2 |
| 5 | Agent runner: markdown parser | — |
| 6 | Agent runner: core service | 2, 3, 4, 5 |
| 7 | DB migration: source field | — |
| 8 | Server wiring | 2, 3, 4, 6, 7 |
| 9 | Frontend: auto badge | 7 |
| 10 | E2E test | 8, 9 |
| 11 | Hot reload | 6 |

Tasks 1-5 and 7 are independent and can be parallelized. Tasks 6, 8, 9, 10, 11 are sequential.
