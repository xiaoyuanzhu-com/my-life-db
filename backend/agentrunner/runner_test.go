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
name: test-agent
agent: claude_code
trigger: cron
schedule: "0 * * * *"
---

You are a test agent. Do something useful.
`

const disabledAgentMD = `---
name: disabled-agent
agent: claude_code
trigger: file.created
path: "**"
enabled: false
---

This agent is disabled.
`

const fileAgentMD = `---
name: file-watcher
agent: claude_code
trigger: file.created
path: "inbox/**"
---

Process the new file.
`

func TestRunnerLoadsAgentDefs(t *testing.T) {
	dir := t.TempDir()

	if err := os.WriteFile(filepath.Join(dir, "test-agent.md"), []byte(testAgentMD), 0644); err != nil {
		t.Fatal(err)
	}

	r := New(Config{AgentsDir: dir})
	defs, err := r.LoadDefs()
	if err != nil {
		t.Fatalf("LoadDefs() error: %v", err)
	}

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

	if err := os.WriteFile(filepath.Join(dir, "disabled.md"), []byte(disabledAgentMD), 0644); err != nil {
		t.Fatal(err)
	}

	r := New(Config{AgentsDir: dir})
	defs, err := r.LoadDefs()
	if err != nil {
		t.Fatalf("LoadDefs() error: %v", err)
	}

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

	// Valid .md file
	if err := os.WriteFile(filepath.Join(dir, "valid.md"), []byte(testAgentMD), 0644); err != nil {
		t.Fatal(err)
	}
	// .txt file — should be skipped
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte(testAgentMD), 0644); err != nil {
		t.Fatal(err)
	}
	// Hidden .md file — should be skipped
	if err := os.WriteFile(filepath.Join(dir, ".hidden.md"), []byte(testAgentMD), 0644); err != nil {
		t.Fatal(err)
	}

	r := New(Config{AgentsDir: dir})
	defs, err := r.LoadDefs()
	if err != nil {
		t.Fatalf("LoadDefs() error: %v", err)
	}

	if len(defs) != 1 {
		t.Fatalf("expected 1 def, got %d", len(defs))
	}
	if defs[0].Name != "test-agent" {
		t.Errorf("expected test-agent, got %q", defs[0].Name)
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
