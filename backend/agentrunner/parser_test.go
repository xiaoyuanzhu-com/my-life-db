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
	def, err := ParseAgentDef([]byte(input), "organize-inbox.md")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if def.Name != "Organize Inbox" {
		t.Errorf("Name = %q, want %q", def.Name, "Organize Inbox")
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
	def, err := ParseAgentDef([]byte(input), "daily-summary.md")
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
name: Test Agent
agent: claude_code
trigger: file.created
path: "**"
---

Some prompt.
`
	def, err := ParseAgentDef([]byte(input), "test.md")
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
name: Disabled Agent
agent: claude_code
trigger: file.created
path: "**"
enabled: false
---

Some prompt.
`
	def, err := ParseAgentDef([]byte(input), "disabled.md")
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

func TestErrorOnMissingName(t *testing.T) {
	input := `---
agent: claude_code
trigger: file.created
path: "**"
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "bad.md")
	if err == nil {
		t.Fatal("expected error for missing name, got nil")
	}
}

func TestErrorOnCronWithoutSchedule(t *testing.T) {
	input := `---
name: Bad Cron
agent: claude_code
trigger: cron
---

Some prompt.
`
	_, err := ParseAgentDef([]byte(input), "bad-cron.md")
	if err == nil {
		t.Fatal("expected error for cron without schedule, got nil")
	}
}

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
