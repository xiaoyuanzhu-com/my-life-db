package agentrunner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/agentsdk"
	"github.com/xiaoyuanzhu-com/my-life-db/hooks"
)

const testAgentMD = `---
agent: claude_code
trigger: cron
schedule: "0 * * * *"
---

You are a test agent. Do something useful.
`

const disabledAgentMD = `---
agent: claude_code
trigger: file.created
path: "**"
enabled: false
---

This agent is disabled.
`

const fileAgentMD = `---
agent: claude_code
trigger: file.created
path: "inbox/**"
---

Process the new file.
`

// writeAgentDir writes content to <dir>/<name>/<name>.md, creating the
// subdirectory as needed.
func writeAgentDir(t *testing.T, dir, name string, content []byte) {
	t.Helper()
	agentDir := filepath.Join(dir, name)
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", agentDir, err)
	}
	if err := os.WriteFile(filepath.Join(agentDir, name+".md"), content, 0o644); err != nil {
		t.Fatalf("write %s/%s.md: %v", name, name, err)
	}
}

func TestRunnerLoadsAgentDefs(t *testing.T) {
	dir := t.TempDir()
	writeAgentDir(t, dir, "test-agent", []byte(testAgentMD))

	r := New(Config{AgentsDir: dir})
	if err := r.LoadDefs(); err != nil {
		t.Fatalf("LoadDefs() error: %v", err)
	}

	defs := r.Defs()
	if len(defs) != 1 {
		t.Fatalf("expected 1 def, got %d", len(defs))
	}

	def := defs[0]
	if def.Name != "test-agent" {
		t.Errorf("Name = %q, want %q", def.Name, "test-agent")
	}
	if def.Agent != "claude_code" {
		t.Errorf("Agent = %q, want %q", def.Agent, "claude_code")
	}
	if def.Trigger != "cron" {
		t.Errorf("Trigger = %q, want %q", def.Trigger, "cron")
	}
	if def.Schedule != "0 * * * *" {
		t.Errorf("Schedule = %q, want %q", def.Schedule, "0 * * * *")
	}
	if def.Enabled == nil || !*def.Enabled {
		t.Error("expected Enabled to be true")
	}
	if def.Prompt != "You are a test agent. Do something useful." {
		t.Errorf("Prompt = %q, want %q", def.Prompt, "You are a test agent. Do something useful.")
	}
	if def.File != "test-agent.md" {
		t.Errorf("File = %q, want %q", def.File, "test-agent.md")
	}
}

func TestRunnerSkipsDisabledAgents(t *testing.T) {
	dir := t.TempDir()
	writeAgentDir(t, dir, "disabled-agent", []byte(disabledAgentMD))

	r := New(Config{AgentsDir: dir})
	if err := r.LoadDefs(); err != nil {
		t.Fatalf("LoadDefs() error: %v", err)
	}

	defs := r.Defs()
	// LoadDefs returns all defs including disabled ones — filtering happens at registration time.
	if len(defs) != 1 {
		t.Fatalf("expected 1 def (disabled included), got %d", len(defs))
	}
	if defs[0].Enabled == nil || *defs[0].Enabled {
		t.Error("expected Enabled to be false")
	}
}

func TestRunnerSkipsNonMarkdownFiles(t *testing.T) {
	dir := t.TempDir()

	// Valid agent subdirectory
	writeAgentDir(t, dir, "valid-agent", []byte(testAgentMD))

	// Flat .md file at root — must be ignored
	if err := os.WriteFile(filepath.Join(dir, "flat.md"), []byte(testAgentMD), 0o644); err != nil {
		t.Fatal(err)
	}
	// Non-.md file at root — must be ignored
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte(testAgentMD), 0o644); err != nil {
		t.Fatal(err)
	}
	// Hidden directory — must be ignored
	hiddenDir := filepath.Join(dir, ".hidden")
	if err := os.MkdirAll(hiddenDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hiddenDir, ".hidden.md"), []byte(testAgentMD), 0o644); err != nil {
		t.Fatal(err)
	}

	r := New(Config{AgentsDir: dir})
	if err := r.LoadDefs(); err != nil {
		t.Fatalf("LoadDefs() error: %v", err)
	}

	defs := r.Defs()
	if len(defs) != 1 {
		t.Fatalf("expected 1 def, got %d", len(defs))
	}
	if defs[0].Name != "valid-agent" {
		t.Errorf("expected valid-agent, got %q", defs[0].Name)
	}
}

func TestBuildPrompt(t *testing.T) {
	def := &AgentDef{
		Name:    "file-watcher",
		Agent:   "claude_code",
		Trigger: "file.created",
		Prompt:  "Process the new file.",
	}

	payload := hooks.Payload{
		EventType: hooks.EventFileCreated,
		Timestamp: time.Date(2026, 4, 10, 14, 30, 0, 0, time.UTC),
		Data: map[string]any{
			"path":   "inbox/receipt.pdf",
			"name":   "receipt.pdf",
			"folder": "inbox",
		},
	}

	r := New(Config{})
	prompt := r.buildPrompt(def, payload)

	// Check that trigger context is present
	expected := `[Trigger Context]
Event: file.created
Time: 2026-04-10T14:30:00Z
Path: inbox/receipt.pdf
Name: receipt.pdf
Folder: inbox

---

Process the new file.`

	if prompt != expected {
		t.Errorf("buildPrompt mismatch.\nGot:\n%s\n\nWant:\n%s", prompt, expected)
	}
}

func TestBuildPromptCron(t *testing.T) {
	def := &AgentDef{
		Name:     "daily-summary",
		Agent:    "claude_code",
		Trigger:  "cron",
		Schedule: "0 9 * * *",
		Prompt:   "Generate a daily summary.",
	}

	payload := hooks.Payload{
		EventType: hooks.EventCronTick,
		Timestamp: time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC),
		Data: map[string]any{
			"name":     "daily-summary",
			"schedule": "0 9 * * *",
		},
	}

	r := New(Config{})
	prompt := r.buildPrompt(def, payload)

	expected := `[Trigger Context]
Event: cron.tick
Time: 2026-04-10T09:00:00Z
Schedule: 0 9 * * *

---

Generate a daily summary.`

	if prompt != expected {
		t.Errorf("buildPrompt mismatch.\nGot:\n%s\n\nWant:\n%s", prompt, expected)
	}
}

func TestExecuteMatchingAgentsPathFilter(t *testing.T) {
	dir := t.TempDir()

	agentDef := `---
agent: claude_code
trigger: file.created
path: "inbox/**"
---

Process the new file.
`
	writeAgentDir(t, dir, "inbox-watcher", []byte(agentDef))

	var mu sync.Mutex
	var executed []string
	registry := hooks.NewRegistry()
	r := New(Config{
		AgentsDir: dir,
		Registry:  registry,
		CreateSession: func(ctx context.Context, params SessionParams) (agentsdk.Session, <-chan struct{}, error) {
			mu.Lock()
			executed = append(executed, params.Title)
			mu.Unlock()
			return nil, nil, fmt.Errorf("test: skip session")
		},
	})

	if err := r.LoadDefs(); err != nil {
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

	// Give execute goroutines a moment to run (they're fire-and-forget)
	time.Sleep(100 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(executed) != 1 {
		t.Fatalf("expected 1 execution, got %d: %v", len(executed), executed)
	}
	if executed[0] != "inbox-watcher" {
		t.Errorf("expected inbox-watcher, got %q", executed[0])
	}
}

func TestWatcherReloadsOnNewAgentFolder(t *testing.T) {
	dir := t.TempDir()
	r := &Runner{cfg: Config{AgentsDir: dir}}
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
	content := []byte("---\nagent: claude_code\ntrigger: cron\nschedule: \"0 3 * * *\"\n---\nHello.\n")
	if err := os.WriteFile(filepath.Join(agentDir, "new-agent.md"), content, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Wait up to 3s for reload (500ms debounce + slack)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		defs := r.Defs()
		if len(defs) == 1 && defs[0].Name == "new-agent" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("watcher did not pick up new agent within deadline; defs=%+v", r.Defs())
}

func TestWatcherReloadsOnAgentFileEdit(t *testing.T) {
	dir := t.TempDir()
	agentDir := filepath.Join(dir, "edit-me")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	original := []byte("---\nagent: claude_code\ntrigger: cron\nschedule: \"0 3 * * *\"\n---\noriginal\n")
	mdPath := filepath.Join(agentDir, "edit-me.md")
	if err := os.WriteFile(mdPath, original, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	r := &Runner{cfg: Config{AgentsDir: dir}}
	if err := r.LoadDefs(); err != nil {
		t.Fatalf("load: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.watchAgentsDir(ctx)

	time.Sleep(100 * time.Millisecond)

	updated := []byte("---\nagent: claude_code\ntrigger: cron\nschedule: \"0 4 * * *\"\n---\nupdated\n")
	if err := os.WriteFile(mdPath, updated, 0o644); err != nil {
		t.Fatalf("update: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		defs := r.Defs()
		if len(defs) == 1 && defs[0].Schedule == "0 4 * * *" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("watcher did not pick up file edit within deadline")
}

func TestLoadDefsFolderPerAgent(t *testing.T) {
	dir := t.TempDir()

	// Valid agent in its own folder
	content := []byte(`---
agent: claude_code
trigger: cron
schedule: "0 3 * * *"
---
Hello from my-agent.
`)
	writeAgentDir(t, dir, "my-agent", content)

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
