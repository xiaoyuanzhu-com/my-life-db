package agentapps

import (
	"strings"
	"testing"
)

func TestValidateAgentDef_ValidCron(t *testing.T) {
	content := `---
name: Daily Backup
agent: claude_code
trigger: cron
schedule: "0 3 * * *"
---

Back up all data to the NAS.
`
	result := ValidateAgentDef(content)
	if !result.Valid {
		t.Fatalf("expected valid, got errors: %v", result.Errors)
	}
	if result.Parsed.Name != "Daily Backup" {
		t.Errorf("Name = %q, want %q", result.Parsed.Name, "Daily Backup")
	}
	if result.Parsed.Schedule != "0 3 * * *" {
		t.Errorf("Schedule = %q, want %q", result.Parsed.Schedule, "0 3 * * *")
	}
	if !result.Parsed.Enabled {
		t.Error("expected Enabled true")
	}
}

func TestValidateAgentDef_ValidFileCreated(t *testing.T) {
	content := `---
name: Inbox Organizer
agent: claude_code
trigger: file.created
---

Organize inbox files.
`
	result := ValidateAgentDef(content)
	if !result.Valid {
		t.Fatalf("expected valid, got errors: %v", result.Errors)
	}
	if result.Parsed.Trigger != "file.created" {
		t.Errorf("Trigger = %q, want %q", result.Parsed.Trigger, "file.created")
	}
}

func TestValidateAgentDef_ValidCodex(t *testing.T) {
	content := `---
name: Codex Agent
agent: codex
trigger: file.changed
---

Process changed files.
`
	result := ValidateAgentDef(content)
	if !result.Valid {
		t.Fatalf("expected valid, got errors: %v", result.Errors)
	}
}

func TestValidateAgentDef_MissingName(t *testing.T) {
	content := `---
agent: claude_code
trigger: cron
schedule: "0 3 * * *"
---

Some prompt.
`
	result := ValidateAgentDef(content)
	if result.Valid {
		t.Fatal("expected invalid, got valid")
	}
}

func TestValidateAgentDef_InvalidTrigger(t *testing.T) {
	content := `---
name: Bad Agent
agent: claude_code
trigger: on_demand
---

Some prompt.
`
	result := ValidateAgentDef(content)
	if result.Valid {
		t.Fatal("expected invalid, got valid")
	}
	found := false
	for _, e := range result.Errors {
		if strings.Contains(e, "trigger") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected trigger error, got: %v", result.Errors)
	}
}

func TestValidateAgentDef_InvalidAgent(t *testing.T) {
	content := `---
name: Bad Agent
agent: gpt4
trigger: file.created
---

Some prompt.
`
	result := ValidateAgentDef(content)
	if result.Valid {
		t.Fatal("expected invalid, got valid")
	}
	found := false
	for _, e := range result.Errors {
		if strings.Contains(e, "agent") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected agent error, got: %v", result.Errors)
	}
}

func TestValidateAgentDef_CronMissingSchedule(t *testing.T) {
	content := `---
name: Bad Cron
agent: claude_code
trigger: cron
---

Some prompt.
`
	result := ValidateAgentDef(content)
	if result.Valid {
		t.Fatal("expected invalid, got valid")
	}
}

func TestValidateAgentDef_InvalidCronExpression(t *testing.T) {
	content := `---
name: Bad Schedule
agent: claude_code
trigger: cron
schedule: "not a cron"
---

Some prompt.
`
	result := ValidateAgentDef(content)
	if result.Valid {
		t.Fatal("expected invalid, got valid")
	}
	found := false
	for _, e := range result.Errors {
		if strings.Contains(e, "schedule") || strings.Contains(e, "cron") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected cron parse error, got: %v", result.Errors)
	}
}

func TestValidateAgentDef_EmptyPrompt(t *testing.T) {
	content := `---
name: No Prompt
agent: claude_code
trigger: file.created
---
`
	result := ValidateAgentDef(content)
	if result.Valid {
		t.Fatal("expected invalid, got valid")
	}
}

func TestValidateAgentDef_MissingFrontmatter(t *testing.T) {
	content := `Just some text without frontmatter.`
	result := ValidateAgentDef(content)
	if result.Valid {
		t.Fatal("expected invalid, got valid")
	}
}

func TestValidateAgentDef_SixFieldCronRejected(t *testing.T) {
	content := `---
name: Six Field
agent: claude_code
trigger: cron
schedule: "0 0 3 * * *"
---

Some prompt.
`
	result := ValidateAgentDef(content)
	if result.Valid {
		t.Fatal("expected invalid for 6-field cron, got valid")
	}
}

func TestValidateAgentDef_DisabledAgent(t *testing.T) {
	content := `---
name: Paused Agent
agent: claude_code
trigger: file.created
enabled: false
---

Some prompt.
`
	result := ValidateAgentDef(content)
	if !result.Valid {
		t.Fatalf("expected valid, got errors: %v", result.Errors)
	}
	if result.Parsed.Enabled {
		t.Error("expected Enabled false")
	}
}
