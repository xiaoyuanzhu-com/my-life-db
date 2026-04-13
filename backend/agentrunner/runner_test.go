package agentrunner

import (
	"os"
	"path/filepath"
	"testing"
	"time"

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
