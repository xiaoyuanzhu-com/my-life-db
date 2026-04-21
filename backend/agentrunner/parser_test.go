package agentrunner

import (
	"testing"
)

func TestParseCompleteFileCreatedAgent(t *testing.T) {
	input := `---
name: Organize Inbox
agent: claude_code
trigger: file.created
path: "inbox/**"
enabled: true
---

You are an inbox organizer. When a new file arrives in the inbox,
categorize it and move it to the appropriate folder.
`
	// Folder name wins over the YAML "name:" field.
	def, err := ParseAgentDef([]byte(input), "organize-inbox", "organize-inbox.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// def.Name must be the folder-derived name, not the YAML value.
	if def.Name != "organize-inbox" {
		t.Errorf("Name = %q, want %q", def.Name, "organize-inbox")
	}
	if def.Agent != "claude_code" {
		t.Errorf("Agent = %q, want %q", def.Agent, "claude_code")
	}
	if def.Trigger != "file.created" {
		t.Errorf("Trigger = %q, want %q", def.Trigger, "file.created")
	}
	if def.Enabled == nil || !*def.Enabled {
		t.Errorf("Enabled = %v, want true", def.Enabled)
	}
	if def.File != "organize-inbox.md" {
		t.Errorf("File = %q, want %q", def.File, "organize-inbox.md")
	}

	wantPrompt := "You are an inbox organizer. When a new file arrives in the inbox,\ncategorize it and move it to the appropriate folder."
	if def.Prompt != wantPrompt {
		t.Errorf("Prompt = %q, want %q", def.Prompt, wantPrompt)
	}
}

func TestParseCronAgent(t *testing.T) {
	input := `---
name: Daily Summary
agent: claude_code
trigger: cron
schedule: "0 9 * * *"
---

Generate a daily summary of all changes.
`
	def, err := ParseAgentDef([]byte(input), "daily-summary", "daily-summary.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if def.Trigger != "cron" {
		t.Errorf("Trigger = %q, want %q", def.Trigger, "cron")
	}
	if def.Schedule != "0 9 * * *" {
		t.Errorf("Schedule = %q, want %q", def.Schedule, "0 9 * * *")
	}
}

func TestDefaultEnabledTrue(t *testing.T) {
	input := `---
agent: claude_code
trigger: file.created
path: "**"
---

Some prompt.
`
	def, err := ParseAgentDef([]byte(input), "test-agent", "test.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if def.Enabled == nil {
		t.Fatal("Enabled is nil, want non-nil true")
	}
	if !*def.Enabled {
		t.Errorf("Enabled = false, want true")
	}
}

func TestEnabledFalse(t *testing.T) {
	input := `---
agent: claude_code
trigger: file.created
path: "**"
enabled: false
---

Some prompt.
`
	def, err := ParseAgentDef([]byte(input), "disabled-agent", "disabled.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if def.Enabled == nil {
		t.Fatal("Enabled is nil, want non-nil false")
	}
	if *def.Enabled {
		t.Errorf("Enabled = true, want false")
	}
}

// TestFolderNameWinsOverYAMLName verifies that the name argument always
// overrides any "name:" field present in the YAML frontmatter.
func TestFolderNameWinsOverYAMLName(t *testing.T) {
	input := `---
name: Some Other Name
agent: claude_code
trigger: cron
schedule: "0 9 * * *"
---

Some prompt.
`
	def, err := ParseAgentDef([]byte(input), "folder-name", "folder-name.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if def.Name != "folder-name" {
		t.Errorf("Name = %q, want %q (folder name must win)", def.Name, "folder-name")
	}
}

func TestErrorOnCronWithoutSchedule(t *testing.T) {
	input := `---
agent: claude_code
trigger: cron
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "bad-cron", "bad-cron.md")
	if err == nil {
		t.Fatal("expected error for cron without schedule, got nil")
	}
}

func TestParseFileAgentWithPath(t *testing.T) {
	input := `---
agent: claude_code
trigger: file.created
path: "inbox/**"
---

Process the new file.
`
	def, err := ParseAgentDef([]byte(input), "inbox-watcher", "inbox-watcher.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if def.Path != "inbox/**" {
		t.Errorf("Path = %q, want %q", def.Path, "inbox/**")
	}
}

func TestErrorOnFileCreatedWithoutPath(t *testing.T) {
	input := `---
agent: claude_code
trigger: file.created
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "no-path-agent", "no-path.md")
	if err == nil {
		t.Fatal("expected error for file.created without path, got nil")
	}
}

func TestErrorOnFileChangedWithoutPath(t *testing.T) {
	input := `---
agent: claude_code
trigger: file.changed
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "no-path-agent", "no-path.md")
	if err == nil {
		t.Fatal("expected error for file.changed without path, got nil")
	}
}

func TestErrorOnFileMovedWithoutPath(t *testing.T) {
	input := `---
agent: claude_code
trigger: file.moved
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "no-path-agent", "no-path.md")
	if err == nil {
		t.Fatal("expected error for file.moved without path, got nil")
	}
}

func TestErrorOnFileDeletedWithoutPath(t *testing.T) {
	input := `---
agent: claude_code
trigger: file.deleted
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "no-path-agent", "no-path.md")
	if err == nil {
		t.Fatal("expected error for file.deleted without path, got nil")
	}
}

func TestAgentFieldOptionalDefaultsToClaudeCode(t *testing.T) {
	input := `---
trigger: cron
schedule: "0 9 * * *"
---

Some prompt.
`
	def, err := ParseAgentDef([]byte(input), "no-agent-field", "no-agent-field.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if def.Agent != DefaultAgent {
		t.Errorf("Agent = %q, want default %q", def.Agent, DefaultAgent)
	}
	if def.Model != "" {
		t.Errorf("Model = %q, want empty (AgentManager fills per-agent default)", def.Model)
	}
}

func TestModelFieldPassesThrough(t *testing.T) {
	input := `---
agent: claude_code
model: claude-opus-4-7
trigger: cron
schedule: "0 9 * * *"
---

Some prompt.
`
	def, err := ParseAgentDef([]byte(input), "with-model", "with-model.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if def.Model != "claude-opus-4-7" {
		t.Errorf("Model = %q, want %q", def.Model, "claude-opus-4-7")
	}
}

func TestCronAgentIgnoresPath(t *testing.T) {
	input := `---
agent: claude_code
trigger: cron
schedule: "0 9 * * *"
---

Generate a daily summary.
`
	def, err := ParseAgentDef([]byte(input), "daily-summary", "daily-summary.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if def.Path != "" {
		t.Errorf("Path = %q, want empty for cron trigger", def.Path)
	}
}
