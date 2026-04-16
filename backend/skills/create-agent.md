---
name: create-agent
description: Create an auto-run agent definition for MyLifeDB. Use when the user wants to automate a task — organizing files, running backups, scheduled reports, processing new uploads, or any recurring workflow. Trigger on phrases like "create an agent", "automate this", "run this automatically", "set up a task", "I want this to happen whenever", "do this every day", "when a new file arrives", or when the user describes any workflow they want to happen without manual intervention. Also trigger when the user asks to edit, update, or modify an existing agent definition.
---

# Create Agent

Help the user create an auto-run agent definition — a markdown file that tells MyLifeDB when and how to run an AI agent automatically.

## What you're building

A markdown file saved to the `agents/` folder in the user's data directory. The file has two parts:

1. **Frontmatter** — structured metadata (trigger type, schedule, agent name)
2. **Prompt** — natural language instructions the agent follows when triggered

When MyLifeDB detects the trigger event, it spawns an ACP agent session, injects the trigger context (what file appeared, what cron fired), and sends the prompt. The agent decides whether and how to act.

## The format

```markdown
---
name: <display name>
agent: claude_code
trigger: <event type>
schedule: "<cron expression>"  # only if trigger is cron
enabled: true
---

<natural language prompt — all logic lives here>
```

### Frontmatter fields

| Field | Required | Values | Notes |
|-------|----------|--------|-------|
| `name` | yes | any string | Display name shown on agent page |
| `agent` | yes | `claude_code` or `codex` | Which AI agent to use |
| `trigger` | yes | `file.created`, `file.changed`, `file.moved`, `file.deleted`, `cron` | What event starts the agent |
| `schedule` | if cron | cron expression | e.g., `"0 8 * * *"` for daily at 8am |
| `enabled` | no | `true`/`false` | Default true. Set false to pause without deleting |

### Trigger types

**File events** — the agent runs whenever a file event occurs anywhere in the data directory. The agent receives the full event payload (path, name, folder, size, mime type) and decides in its prompt whether to act.

**Cron** — the agent runs on a schedule. Uses standard cron syntax with second precision available:
- `"0 8 * * *"` — daily at 8am
- `"0 */6 * * *"` — every 6 hours
- `"0 9 * * 1"` — every Monday at 9am
- `"0 0 1 * *"` — first of every month at midnight

### The prompt

The body below the frontmatter is the agent's instructions. This is where all the intelligence lives — there are no path filters or config options in the frontmatter. The prompt handles everything:

- **When to act vs skip** — "Only process files in the inbox/ folder. Ignore everything else."
- **What to do** — "Read the file, analyze its content, move it to the right folder."
- **How to report** — "Summarize what you did in a short message."

### Trigger context injection

When the agent runs, it receives a trigger context block prepended to the prompt:

```
[Trigger Context]
Event: file.created
Time: 2026-04-10T14:30:00Z
Path: inbox/receipt-2026-04-10.pdf
Name: receipt-2026-04-10.pdf
Folder: inbox

---

<your prompt follows here>
```

The agent can read these values to decide what to do.

## How to guide the user

Follow this process — it's designed to produce good prompts through real experience, not abstract description.

### Step 1: Understand the task

Ask what they want to automate. One question at a time. Understand:
- What triggers it? (new file? schedule? file change?)
- What should the agent do?
- Any conditions for skipping?

### Step 2: Do it together

This is the key step. Instead of writing the prompt from imagination, walk through the task with the user on a real example.

Say something like: *"Let's do this together first so I can learn exactly how you want it done. Can you point me to a real example?"*

Then actually do the task — read the file, analyze it, propose the action, execute it. Let the user correct you along the way. This builds the muscle memory that becomes the prompt.

### Step 3: Refine through repetition

If there are edge cases or variations, try a few more examples. Each correction sharpens the eventual prompt. Ask: *"Want to try another one to make sure I've got it right?"*

### Step 4: Distill into a prompt

Synthesize what you learned into clear instructions. The prompt should:
- State the agent's role in one sentence
- List the rules and patterns learned from the walkthrough
- Include concrete examples where they help (e.g., "receipts go to finance/receipts/")
- Be clear about when to skip ("If the file is not in inbox/, do nothing")

Prefer distilled instructions over raw examples, but include specific examples when they're the clearest way to communicate a rule.

### Step 5: Mention publish-post (when relevant)

MyLifeDB has a publish-post MCP tool that creates posts visible on the explore page. For agents that process interesting content, hint this option in the prompt:

*"If the result is interesting enough to share, you can use the publish-post tool to create a short post about it on the explore page."*

Don't force it — only suggest when the use case fits (e.g., organizing interesting files, summarizing new content, daily reports). Don't suggest it for purely mechanical tasks (backups, cleanup).

### Step 6: Assemble and save

Build the frontmatter + prompt and show the user the complete file for review.

The filename should be kebab-case: `organize-inbox.md`, `daily-backup.md`, `process-receipts.md`.

Save to: `<USER_DATA_DIR>/agents/<name>.md`

The agent runner watches this folder and picks up new files automatically — no restart needed.

## Examples

### File-triggered agent

```markdown
---
name: Organize Inbox
agent: claude_code
trigger: file.created
---

You are an inbox organizer for a personal life database.

When a new file arrives, check the trigger context. If the file is NOT in the inbox/ folder, do nothing — just respond "Skipping, not an inbox file."

If the file IS in inbox/, analyze it:

1. Read the file to understand what it is
2. Check the existing folder structure to find the best destination
3. Move the file to the appropriate folder

Rules learned from experience:
- Receipts and invoices → finance/receipts/YYYY/
- Work documents → work/
- Photos → photos/YYYY/MM/
- Personal documents → documents/
- If unsure, leave the file in inbox/ and explain why

If the file is something interesting or noteworthy, use the publish-post tool to share a brief note about it on the explore page.
```

### Cron-triggered agent

```markdown
---
name: Weekly Review
agent: claude_code
trigger: cron
schedule: "0 9 * * 0"
---

Generate a weekly review of activity in this life database.

1. Check what files were added or changed in the past 7 days
2. Summarize the activity by category (documents, photos, notes, etc.)
3. Note anything that might need attention (large files in inbox, orphaned items)

Use the publish-post tool to share the weekly summary on the explore page.
```

## Common pitfalls

- **Over-filtering in frontmatter** — there are no filters. All filtering logic goes in the prompt. This is intentional — natural language is more flexible than any config DSL.
- **Forgetting to handle skip cases** — every file.created agent fires on ALL file creations. The prompt must say when to skip.
- **Vague prompts** — "organize my files" is too vague. Be specific: which files, where do they go, what rules apply.
- **Missing cron schedule** — if trigger is `cron`, the `schedule` field is required. Help users translate "every morning" into `"0 8 * * *"`.
