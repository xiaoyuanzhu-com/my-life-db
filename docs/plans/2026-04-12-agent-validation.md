# Agent Validation MCP Tool + Standard Cron Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `validateAgent` MCP tool so agent-creating skills get immediate feedback on definition errors, and fix the CronHook to use standard 5-field cron.

**Architecture:** Three independent changes — (1) fix CronHook to use standard cron, (2) add `validateAgent` to the agent-apps MCP server using the existing `ParseAgentDef` parser + cron validation, (3) update the create-agent skill to call the tool before writing files.

**Tech Stack:** Go (backend), robfig/cron/v3, existing agentrunner parser, MCP JSON-RPC 2.0

---

### Task 1: Fix CronHook to use standard 5-field cron

**Files:**
- Modify: `backend/hooks/cron_hook.go:21-27`
- Modify: `backend/agentrunner/runner_test.go:16,68-69,177-178,184`

**Step 1: Update CronHook to drop WithSeconds()**

In `backend/hooks/cron_hook.go`, change line 24 from:

```go
scheduler: cron.New(cron.WithSeconds()),
```

to:

```go
scheduler: cron.New(),
```

Also update the comment on line 20 from "second-precision scheduling" to "standard 5-field cron scheduling":

```go
// NewCronHook creates a CronHook with standard 5-field cron scheduling.
```

**Step 2: Update runner tests to use 5-field cron expressions**

In `backend/agentrunner/runner_test.go`:

Line 16 — change `"0 0 * * * *"` to `"0 * * * *"`:
```go
schedule: "0 * * * *"
```

Line 68-69 — update the assertion:
```go
if def.Schedule != "0 * * * *" {
    t.Errorf("Schedule = %q, want %q", def.Schedule, "0 * * * *")
}
```

Lines 177-178 — change `"0 0 9 * * *"` to `"0 9 * * *"`:
```go
Schedule: "0 9 * * *",
```

Line 184 — update the payload data:
```go
"schedule": "0 9 * * *",
```

Line 193-200 — update the expected prompt string to use `"0 9 * * *"`.

**Step 3: Run tests to verify**

Run: `cd backend && go test ./hooks/ ./agentrunner/ -v`
Expected: All pass. The cron parser now accepts standard 5-field expressions.

**Step 4: Commit**

```bash
git add backend/hooks/cron_hook.go backend/agentrunner/runner_test.go
git commit -m "fix: use standard 5-field cron in CronHook

WithSeconds() required 6-field expressions, but agent definitions
use standard 5-field cron. This caused cron agents to silently
fail to register."
```

---

### Task 2: Add ValidateAgentDef to agentapps service

**Files:**
- Modify: `backend/agentapps/service.go` (add ValidateAgentDef method)
- Create: `backend/agentapps/service_test.go`

**Step 1: Write the failing tests**

Create `backend/agentapps/service_test.go`:

```go
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
	if len(result.Errors) == 0 {
		t.Fatal("expected errors, got none")
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
```

**Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./agentapps/ -v`
Expected: FAIL — `ValidateAgentDef` does not exist yet.

**Step 3: Implement ValidateAgentDef**

Add to `backend/agentapps/service.go`:

```go
import (
	"github.com/robfig/cron/v3"
	"github.com/xiaoyuanzhu-com/my-life-db/agentrunner"
)
```

```go
// ValidationResult holds the result of validating an agent definition.
type ValidationResult struct {
	Valid  bool              `json:"valid"`
	Errors []string          `json:"errors,omitempty"`
	Parsed *ValidationParsed `json:"parsed,omitempty"`
}

// ValidationParsed holds the parsed fields from a valid agent definition.
type ValidationParsed struct {
	Name     string `json:"name"`
	Agent    string `json:"agent"`
	Trigger  string `json:"trigger"`
	Schedule string `json:"schedule,omitempty"`
	Enabled  bool   `json:"enabled"`
}

var validAgents = map[string]bool{
	"claude_code": true,
	"codex":       true,
}

var validTriggers = map[string]bool{
	"cron":         true,
	"file.created": true,
	"file.changed": true,
	"file.moved":   true,
	"file.deleted": true,
}

// ValidateAgentDef validates the full markdown content of an agent definition.
// It reuses agentrunner.ParseAgentDef for structural parsing and adds
// semantic validation (valid agent types, trigger types, cron expression parsing).
func ValidateAgentDef(content string) ValidationResult {
	def, err := agentrunner.ParseAgentDef([]byte(content), "validate")
	if err != nil {
		return ValidationResult{Valid: false, Errors: []string{err.Error()}}
	}

	var errs []string

	if !validAgents[def.Agent] {
		errs = append(errs, fmt.Sprintf("unknown agent type %q, must be one of: claude_code, codex", def.Agent))
	}

	if !validTriggers[def.Trigger] {
		errs = append(errs, fmt.Sprintf("unknown trigger type %q, must be one of: cron, file.created, file.changed, file.moved, file.deleted", def.Trigger))
	}

	if def.Trigger == "cron" && def.Schedule != "" {
		parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
		if _, err := parser.Parse(def.Schedule); err != nil {
			errs = append(errs, fmt.Sprintf("invalid cron schedule %q: %v", def.Schedule, err))
		}
	}

	if def.Prompt == "" {
		errs = append(errs, "prompt body is empty — add instructions below the frontmatter")
	}

	if len(errs) > 0 {
		return ValidationResult{Valid: false, Errors: errs}
	}

	return ValidationResult{
		Valid: true,
		Parsed: &ValidationParsed{
			Name:     def.Name,
			Agent:    def.Agent,
			Trigger:  def.Trigger,
			Schedule: def.Schedule,
			Enabled:  def.Enabled != nil && *def.Enabled,
		},
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./agentapps/ -v`
Expected: All pass.

**Step 5: Commit**

```bash
git add backend/agentapps/service.go backend/agentapps/service_test.go
git commit -m "feat: add ValidateAgentDef for structural agent validation

Reuses agentrunner.ParseAgentDef for parsing, adds semantic checks
for agent type, trigger type, cron expression, and non-empty prompt."
```

---

### Task 3: Wire validateAgent into the MCP server

**Files:**
- Modify: `backend/agentapps/mcp.go:119-199` (add tool definition + handler)

**Step 1: Add validateAgent to the tools list**

In `backend/agentapps/mcp.go`, add to the `tools` slice in `handleToolsList` (after the deleteFile entry, before the closing `]`):

```go
{
    "name":        "validateAgent",
    "description": "Validate an agent definition before saving it. Pass the full markdown content (frontmatter + prompt) and get back validation results with specific, actionable error messages. Always call this before writing to the agents/ directory.",
    "inputSchema": map[string]any{
        "type":     "object",
        "required": []string{"content"},
        "properties": map[string]any{
            "content": map[string]any{
                "type":        "string",
                "description": "Full markdown content of the agent definition (YAML frontmatter between --- delimiters + prompt body)",
            },
        },
    },
},
```

**Step 2: Add the tool call handler**

Add the case to the switch in `handleToolsCall`:

```go
case "validateAgent":
    return m.callValidateAgent(req.ID, params.Arguments)
```

Add the handler method:

```go
func (m *MCPServer) callValidateAgent(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	content, _ := args["content"].(string)
	if content == "" {
		return m.toolError(id, "content is required")
	}

	result := ValidateAgentDef(content)
	data, _ := json.Marshal(result)
	return m.toolResult(id, string(data))
}
```

**Step 3: Run all backend tests**

Run: `cd backend && go test ./agentapps/ ./agentrunner/ ./hooks/ -v`
Expected: All pass.

**Step 4: Commit**

```bash
git add backend/agentapps/mcp.go
git commit -m "feat: wire validateAgent MCP tool into agent-apps server

Agents and skills can now call validateAgent to check definitions
before writing them, getting immediate actionable error feedback."
```

---

### Task 4: Update create-agent skill

**Files:**
- Modify: `/home/xiaoyuanzhu/.claude/skills/create-agent/SKILL.md`

**Step 1: Add validation step to the skill**

In the skill file, update **Step 6: Assemble and save** to include a validation call. Replace the existing Step 6 with:

```markdown
### Step 6: Validate

Before saving, call the `validateAgent` MCP tool with the full markdown content:

```
Call tool: validateAgent
Arguments: { "content": "<the full markdown content>" }
```

If the response has `"valid": false`, read the `errors` array and fix the issues. Common fixes:
- Invalid cron schedule → check it's standard 5-field: `minute hour day-of-month month day-of-week`
- Unknown trigger type → must be one of: `cron`, `file.created`, `file.changed`, `file.moved`, `file.deleted`
- Unknown agent type → must be `claude_code` or `codex`
- Empty prompt → add instructions below the frontmatter

Retry validation after each fix until `"valid": true`.

### Step 7: Save

Save the validated content to: `<USER_DATA_DIR>/agents/<name>.md`

The filename should be kebab-case: `organize-inbox.md`, `daily-backup.md`, `process-receipts.md`.

The agent runner watches this folder and picks up new files automatically — no restart needed.
```

Also update the **Frontmatter fields** table to clarify the cron format:

```markdown
| `schedule` | if cron | standard 5-field cron | `minute hour dom month dow`, e.g. `"0 8 * * *"` for daily at 8am |
```

**Step 2: Commit**

```bash
git add /home/xiaoyuanzhu/.claude/skills/create-agent/SKILL.md
git commit -m "docs: update create-agent skill to validate before saving

Adds a validateAgent MCP tool call step before writing agent files,
and clarifies cron format is standard 5-field."
```

---

### Task 5: Fix the existing backup agent definition

**Files:**
- Modify: `/home/xiaoyuanzhu/my-life-db/data/agents/backup-xiaoyuanzhu-apps.md:5`

**Step 1: Verify the schedule is already correct**

The existing schedule `"0 3 * * *"` is valid 5-field cron (daily at 3:00 AM). No change needed to the schedule itself.

However, once the CronHook fix is deployed, this agent will start working. Confirm the definition is correct by reviewing it one more time.

**Step 2: No commit needed — file is already correct**

The fix is in the CronHook (Task 1), not in the agent definition.

---

### Task 6: Run full test suite and verify

**Step 1: Run all backend tests**

Run: `cd backend && go test ./... -v`
Expected: All pass.

**Step 2: Verify the build compiles**

Run: `cd backend && go build .`
Expected: Clean build, no errors.
