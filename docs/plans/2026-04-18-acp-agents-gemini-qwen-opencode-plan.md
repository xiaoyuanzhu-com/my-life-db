# Add Gemini CLI, Qwen Code, opencode as ACP Agents — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add three new ACP agents (Gemini CLI, Qwen Code, opencode) to MyLifeDB, all routed through the existing LiteLLM gateway.

**Architecture:** Inline registration through 5 backend touchpoints + 1 frontend file per agent. No protocol-layer changes — `backend/agentsdk/acpsession.go` works for any ACP binary spawned over stdio JSON-RPC.

**Tech Stack:** Go 1.25 (backend), React 19 + TypeScript (frontend), `coder/acp-go-sdk`, LiteLLM as the LLM gateway.

**Reference design:** `docs/plans/2026-04-18-acp-agents-gemini-qwen-opencode-design.md`

**Rollout order:** Qwen Code → Gemini CLI → opencode. Each agent ships its own commit and is verified end-to-end before the next.

---

## Task 0: Install agent binaries on the Mac mini

**Files:** None — host setup only.

This is a prerequisite, not a code task. Each binary must exist on the deployment host's `PATH` before the corresponding code change is testable.

**Step 1: SSH to the Mac mini**

```bash
ssh macmini
```

**Step 2: Install all three CLIs**

```bash
npm install -g @qwen-code/qwen-code
npm install -g @google/gemini-cli
npm install -g opencode-ai
```

**Step 3: Verify each binary runs**

```bash
qwen --version
gemini --version
opencode --version
```

Expected: each prints a version string. If any errors, stop and resolve before continuing.

**Step 4: Provision opencode config**

Write `~/.config/opencode/opencode.json` on the Mac mini with the LiteLLM provider (substitute the real LiteLLM URL and key):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM",
      "options": {
        "baseURL": "<AGENT_BASE_URL>",
        "apiKey": "<AGENT_API_KEY>"
      },
      "models": {
        "claude-sonnet-4-6": { "name": "Claude Sonnet 4.6" },
        "gemini-3-pro": { "name": "Gemini 3 Pro" }
      }
    }
  }
}
```

**Step 5: Update `data/resources.md`**

Append the three new CLIs under the installed-tools section with the install command used. Per the project root CLAUDE.md rule: after installing tools on the Mac mini, always update `resources.md`.

**Step 6: Commit `resources.md`**

```bash
cd /home/xiaoyuanzhu/my-life-db/data
git add resources.md
git commit -m "docs: add gemini, qwen, opencode CLIs to mac mini tools"
```

---

## Task 1: Add `AgentType` constants for the three new agents

**Files:**
- Modify: `backend/agentsdk/types.go:18-21`

**Step 1: Edit the constant block**

Replace the existing block with:

```go
const (
    AgentClaudeCode AgentType = "claude_code"
    AgentCodex      AgentType = "codex"
    AgentGemini     AgentType = "gemini"
    AgentQwen       AgentType = "qwen"
    AgentOpencode   AgentType = "opencode"
)
```

**Step 2: Verify the package still compiles**

```bash
cd backend && go build ./...
```

Expected: no errors. The new constants aren't referenced yet — that's fine.

**Step 3: Commit**

```bash
git add backend/agentsdk/types.go
git commit -m "feat(agentsdk): add gemini, qwen, opencode agent type constants"
```

---

## Task 2: Convert `agentTypeString` and string-to-enum to switches

**Files:**
- Modify: `backend/api/agent_manager.go:50-57` (`agentTypeString`)
- Modify: `backend/api/agent_manager.go:264-271` (the string→enum block inside `CreateSession`)

The current 2-agent if/else doesn't scale. Both directions become switches now so the new agents drop in cleanly later.

**Step 1: Replace `agentTypeString`**

```go
// agentTypeString converts the SDK enum to the string used in AGENT_MODELS
// and DB records.
func agentTypeString(t agentsdk.AgentType) string {
    switch t {
    case agentsdk.AgentCodex:
        return "codex"
    case agentsdk.AgentGemini:
        return "gemini"
    case agentsdk.AgentQwen:
        return "qwen"
    case agentsdk.AgentOpencode:
        return "opencode"
    default:
        return "claude_code"
    }
}
```

**Step 2: Replace the string→enum lookup inside `CreateSession`**

Find:

```go
agentType := agentsdk.AgentClaudeCode
if agentTypeStr == "codex" {
    agentType = agentsdk.AgentCodex
}
```

Replace with:

```go
var agentType agentsdk.AgentType
switch agentTypeStr {
case "codex":
    agentType = agentsdk.AgentCodex
case "gemini":
    agentType = agentsdk.AgentGemini
case "qwen":
    agentType = agentsdk.AgentQwen
case "opencode":
    agentType = agentsdk.AgentOpencode
default:
    agentType = agentsdk.AgentClaudeCode
}
```

**Step 3: Verify build**

```bash
cd backend && go build ./...
```

Expected: no errors.

**Step 4: Commit**

```bash
git add backend/api/agent_manager.go
git commit -m "refactor(agent): switch-statement enum/string conversion for upcoming agents"
```

---

## Task 3: Register Qwen Code in `server.go`

**Files:**
- Modify: `backend/server/server.go:165-194`

**Step 1: Add the Qwen `AgentConfig` and pass it to `NewClient`**

After the `codexAgent` declaration (around line 176), add:

```go
qwenEnv := map[string]string{
    "OPENAI_BASE_URL": cfg.AgentLLM.BaseURL,
    "OPENAI_API_KEY":  cfg.AgentLLM.APIKey,
}
qwenAgent := agentsdk.AgentConfig{
    Type:    agentsdk.AgentQwen,
    Name:    "Qwen",
    Command: "qwen",
    Args:    []string{"--acp"},
    Env:     qwenEnv,
}
```

Update the `NewClient` call to include it:

```go
s.agentClient = agentsdk.NewClient(agentsdk.SessionConfig{
    SystemPrompt: buildAgentSystemPrompt(cfg.UserDataDir),
    McpServers:   mcpServers,
}, ccAgent, codexAgent, qwenAgent)
```

Pool warming stays Claude-Code-only — do not change the `StartPool` line.

**Step 2: Verify build**

```bash
cd backend && go build ./...
```

Expected: no errors.

**Step 3: Commit**

```bash
git add backend/server/server.go
git commit -m "feat(server): register qwen agent (--acp) with litellm env"
```

---

## Task 4: Wire Qwen model env override

**Files:**
- Modify: `backend/api/agent_manager.go:281-300`

**Step 1: Add a `case` for Qwen in the env switch**

Inside the `switch agentType` block, add:

```go
case agentsdk.AgentQwen:
    sessionEnv["OPENAI_MODEL"] = params.DefaultModel
```

This sets the model when the user picks something other than the default in the UI.

**Step 2: Verify build**

```bash
cd backend && go build ./...
```

**Step 3: Commit**

```bash
git add backend/api/agent_manager.go
git commit -m "feat(agent): set OPENAI_MODEL when qwen session uses non-default model"
```

---

## Task 5: Add Qwen `defaultConfigOptions`

**Files:**
- Modify: `backend/api/agent_config.go:29-91`

**Step 1: Add a `"qwen"` entry inside the `defaultConfigOptions` map**

After the `"codex"` block (around line 90), before the closing `}` of the map, add:

```go
"qwen": {
    {
        ID: "model", Category: "model", Name: "Model", Type: "select",
        Description:  "Qwen model to use",
        CurrentValue: "qwen3-coder-plus",
        Options: []configOptionChoice{
            {Value: "qwen3-coder-plus", Name: "Qwen3 Coder Plus", Description: "Frontier Qwen3 coding model"},
        },
    },
},
```

The model list will be replaced at runtime when `AGENT_MODELS` is configured (see `GetAgentConfig` lines 109–128). The native default is a fallback for setups without LiteLLM.

**Step 2: Verify build**

```bash
cd backend && go build ./...
```

**Step 3: Commit**

```bash
git add backend/api/agent_config.go
git commit -m "feat(agent): default config options for qwen agent"
```

---

## Task 6: Add Qwen to the frontend selector

**Files:**
- Modify: `frontend/app/components/agent/agent-type-selector.tsx`

**Step 1: Add a `QwenIcon` component**

Above the `AgentType` declaration (around line 22), add a Qwen logo SVG. Use the official Qwen monochrome mark — fetch from the qwen-code repo or use a simple stylized "Q" if no SVG is convenient. Example placeholder:

```tsx
function QwenIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18L19.82 8 12 11.82 4.18 8 12 4.18zM4 9.41l7 3.5v7.27l-7-3.5V9.41zm9 10.77v-7.27l7-3.5v7.27l-7 3.5z"/>
    </svg>
  )
}
```

**Step 2: Extend the `AgentType` union**

Replace line 22:

```tsx
export type AgentType = 'claude_code' | 'codex' | 'qwen'
```

**Step 3: Add an entry to `DEFAULT_MODES`**

Inside the `DEFAULT_MODES` object (around lines 25–34), add:

```tsx
qwen: [],
```

**Step 4: Add an entry to `AGENT_TYPES`**

Inside the `AGENT_TYPES` array (lines 44–57), append:

```tsx
{
  value: 'qwen',
  label: 'Qwen',
  description: 'Alibaba Qwen Code via ACP',
  icon: <QwenIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
},
```

**Step 5: Type-check and lint**

```bash
cd frontend && npm run typecheck && npm run lint
```

Expected: no errors.

**Step 6: Commit**

```bash
git add frontend/app/components/agent/agent-type-selector.tsx
git commit -m "feat(frontend): add qwen to agent type selector"
```

---

## Task 7: Smoke-test Qwen end-to-end

**Files:** None — manual verification.

**Step 1: Build and start backend**

```bash
cd backend && go build . && ./my-life-db
```

Expected: server starts; logs show `agent client initialized`.

**Step 2: Build frontend**

```bash
cd frontend && npm run build
```

**Step 3: Open the UI**

In the agent selector dropdown, confirm "Qwen" appears with the icon.

**Step 4: Create a Qwen session**

Pick Qwen in the selector, start a new session. Send: `say hello`.

Expected: a reply streams back. If the model dropdown shows 0 options or the request fails:
- Check backend logs for the spawn error (likely `qwen: not found` → install issue)
- Check that `AGENT_BASE_URL` and `AGENT_API_KEY` are set in `.env`
- Verify a Qwen-tagged model is in `AGENT_MODELS` with `"agents": ["qwen"]`

**Step 5: Tool-call test**

Send: `list files in this directory`.

Expected: Qwen calls a directory-listing tool and returns results.

**Step 6: Permission test**

Send: `create a file called test.txt with the text "hi"`.

Expected: a permission dialog fires in the UI; approving it lets the write proceed.

**Step 7: Push the Qwen batch**

If all three smoke tests pass:

```bash
git fetch origin && git rebase origin/main
git push origin acp-agents-plan:main
```

Then sync main and clean up the worktree per the project CLAUDE.md workflow.

If any smoke test fails: do not push. Diagnose, fix, commit, repeat.

---

## Task 8: Register Gemini CLI in `server.go`

**Files:**
- Modify: `backend/server/server.go`

**Step 1: Start a fresh worktree**

Per project CLAUDE.md, each push closes one worktree lifecycle. Start a new one for the Gemini batch:

```bash
cd /home/xiaoyuanzhu/my-life-db/data/projects/MyLifeDB/my-life-db
git fetch origin
git worktree add -b acp-gemini .worktrees/acp-gemini origin/main
cd .worktrees/acp-gemini
```

**Step 2: Add the Gemini `AgentConfig`**

After the `qwenAgent` declaration, add:

```go
geminiEnv := map[string]string{
    "GOOGLE_GEMINI_BASE_URL": cfg.AgentLLM.BaseURL,
    "GEMINI_API_KEY":         cfg.AgentLLM.APIKey,
}
geminiAgent := agentsdk.AgentConfig{
    Type:    agentsdk.AgentGemini,
    Name:    "Gemini",
    // NOTE: gemini-cli still uses --experimental-acp as of 2026-04. Watch
    // upstream for a graduation to --acp (see github.com/google-gemini/gemini-cli).
    Command: "gemini",
    Args:    []string{"--experimental-acp"},
    Env:     geminiEnv,
}
```

Update `NewClient`:

```go
s.agentClient = agentsdk.NewClient(agentsdk.SessionConfig{
    SystemPrompt: buildAgentSystemPrompt(cfg.UserDataDir),
    McpServers:   mcpServers,
}, ccAgent, codexAgent, qwenAgent, geminiAgent)
```

**Step 3: Verify build**

```bash
cd backend && go build ./...
```

**Step 4: Commit**

```bash
git add backend/server/server.go
git commit -m "feat(server): register gemini agent (--experimental-acp) with litellm env"
```

---

## Task 9: Wire Gemini model env override + config options

**Files:**
- Modify: `backend/api/agent_manager.go`
- Modify: `backend/api/agent_config.go`

**Step 1: Add Gemini case to env switch**

In `backend/api/agent_manager.go`, inside the `switch agentType` block:

```go
case agentsdk.AgentGemini:
    sessionEnv["GEMINI_MODEL"] = params.DefaultModel
```

**Step 2: Add Gemini default config options**

In `backend/api/agent_config.go`, after the `"qwen"` entry:

```go
"gemini": {
    {
        ID: "model", Category: "model", Name: "Model", Type: "select",
        Description:  "Gemini model to use",
        CurrentValue: "gemini-3-pro",
        Options: []configOptionChoice{
            {Value: "gemini-3-pro", Name: "Gemini 3 Pro", Description: "Frontier Gemini model with 1M context"},
        },
    },
},
```

**Step 3: Verify build**

```bash
cd backend && go build ./...
```

**Step 4: Commit**

```bash
git add backend/api/agent_manager.go backend/api/agent_config.go
git commit -m "feat(agent): gemini model env override and default config options"
```

---

## Task 10: Add Gemini to the frontend selector

**Files:**
- Modify: `frontend/app/components/agent/agent-type-selector.tsx`

**Step 1: Add a `GeminiIcon` component**

```tsx
function GeminiIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"/>
    </svg>
  )
}
```

(Diamond-spark shape matches Google's Gemini mark closely; substitute the official SVG if available.)

**Step 2: Extend `AgentType` union**

```tsx
export type AgentType = 'claude_code' | 'codex' | 'qwen' | 'gemini'
```

**Step 3: Add `gemini: []` to `DEFAULT_MODES`**

**Step 4: Add to `AGENT_TYPES`**

```tsx
{
  value: 'gemini',
  label: 'Gemini',
  description: 'Google Gemini CLI via ACP',
  icon: <GeminiIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
},
```

**Step 5: Verify**

```bash
cd frontend && npm run typecheck && npm run lint
```

**Step 6: Commit**

```bash
git add frontend/app/components/agent/agent-type-selector.tsx
git commit -m "feat(frontend): add gemini to agent type selector"
```

---

## Task 11: Smoke-test Gemini end-to-end

Same procedure as Task 7, substituting Gemini:

1. Restart backend, build frontend
2. Confirm "Gemini" appears in selector
3. Send `say hello` — expect streamed reply
4. Send `list files in this directory` — expect tool-call round-trip
5. Send `create a file called test.txt` — expect permission dialog
6. If all pass: push and clean up the worktree
7. If any fail: diagnose (likely `gemini: not found` or `--experimental-acp` rejected — check `gemini --help` to confirm the flag name on the installed version)

---

## Task 12: Register opencode in `server.go`

**Files:**
- Modify: `backend/server/server.go`

**Step 1: Fresh worktree for the opencode batch**

```bash
cd /home/xiaoyuanzhu/my-life-db/data/projects/MyLifeDB/my-life-db
git fetch origin
git worktree add -b acp-opencode .worktrees/acp-opencode origin/main
cd .worktrees/acp-opencode
```

**Step 2: Add the opencode `AgentConfig`**

After the `geminiAgent` declaration:

```go
// opencode reads its provider config from ~/.config/opencode/opencode.json,
// provisioned manually on the host. No env vars needed.
opencodeAgent := agentsdk.AgentConfig{
    Type:    agentsdk.AgentOpencode,
    Name:    "opencode",
    Command: "opencode",
    Args:    []string{"acp"},
}
```

Update `NewClient`:

```go
s.agentClient = agentsdk.NewClient(agentsdk.SessionConfig{
    SystemPrompt: buildAgentSystemPrompt(cfg.UserDataDir),
    McpServers:   mcpServers,
}, ccAgent, codexAgent, qwenAgent, geminiAgent, opencodeAgent)
```

**Step 3: Verify build**

```bash
cd backend && go build ./...
```

**Step 4: Commit**

```bash
git add backend/server/server.go
git commit -m "feat(server): register opencode agent (acp subcommand)"
```

---

## Task 13: opencode config options + frontend

**Files:**
- Modify: `backend/api/agent_config.go`
- Modify: `frontend/app/components/agent/agent-type-selector.tsx`

**Step 1: Add opencode to `defaultConfigOptions`**

opencode's model selection lives in its config file, but the UI still shows a model dropdown that gets replaced at runtime by `AGENT_MODELS`. Add a minimal stub:

```go
"opencode": {
    {
        ID: "model", Category: "model", Name: "Model", Type: "select",
        Description:  "Model to use (routed through opencode's LiteLLM provider)",
        CurrentValue: "claude-sonnet-4-6",
        Options: []configOptionChoice{
            {Value: "claude-sonnet-4-6", Name: "Claude Sonnet 4.6", Description: "Balanced default"},
        },
    },
},
```

**Step 2: NO env override needed**

opencode picks its model from its own config file. Skipping the env switch in `agent_manager.go` is intentional — the design notes opencode is the file-based outlier.

**Step 3: Add `OpencodeIcon` and the selector entry**

In `agent-type-selector.tsx`:

```tsx
function OpencodeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M3 4h18v2H3V4zm0 4h18v12H3V8zm2 2v8h14v-8H5z"/>
    </svg>
  )
}
```

Extend `AgentType`:

```tsx
export type AgentType = 'claude_code' | 'codex' | 'qwen' | 'gemini' | 'opencode'
```

Add `opencode: []` to `DEFAULT_MODES`.

Add to `AGENT_TYPES`:

```tsx
{
  value: 'opencode',
  label: 'opencode',
  description: 'sst/opencode TUI agent via ACP',
  icon: <OpencodeIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />,
},
```

**Step 4: Verify both backend and frontend**

```bash
cd backend && go build ./...
cd ../frontend && npm run typecheck && npm run lint
```

**Step 5: Commit**

```bash
git add backend/api/agent_config.go frontend/app/components/agent/agent-type-selector.tsx
git commit -m "feat(agent): opencode default config options and frontend selector"
```

---

## Task 14: Smoke-test opencode end-to-end

Same procedure as Task 7. Extra checks specific to opencode:

- If the session fails to spawn: confirm `~/.config/opencode/opencode.json` exists on the Mac mini and is valid JSON (`opencode auth list` to verify it sees the litellm provider)
- If a model request 404s: opencode is calling LiteLLM with a model name not in its config file — add the model to `~/.config/opencode/opencode.json` `models` block

If all pass: push and clean up.

---

## Task 15: Documentation updates

**Files:**
- Modify: `../my-life-db-docs/src/content/docs/tech-design/acp.md`

(separate repo: `my-life-db-docs/`)

**Step 1: Start a worktree in the docs repo**

```bash
cd /home/xiaoyuanzhu/my-life-db/data/projects/MyLifeDB/my-life-db-docs
git fetch origin
git worktree add -b docs-acp-agents .worktrees/docs-acp-agents origin/main
cd .worktrees/docs-acp-agents
```

**Step 2: Update the agents table in `acp.md`**

Find the existing agents table (lists Claude Code and Codex). Add three rows:

| Agent | Binary | Args | LiteLLM env mapping |
|-------|--------|------|---------------------|
| Gemini CLI | `gemini` | `--experimental-acp` | `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY` |
| Qwen Code | `qwen` | `--acp` | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` |
| opencode | `opencode` | `acp` | config file at `~/.config/opencode/opencode.json` |

**Step 3: Cross-link the design doc**

Add a "See also" line referencing `my-life-db/docs/plans/2026-04-18-acp-agents-gemini-qwen-opencode-design.md`.

**Step 4: Commit and push docs**

```bash
git add src/content/docs/tech-design/acp.md
git commit -m "docs: document gemini, qwen, opencode ACP agents"
git fetch origin && git rebase origin/main
git push origin docs-acp-agents:main
cd /home/xiaoyuanzhu/my-life-db/data/projects/MyLifeDB/my-life-db-docs
git pull --rebase origin main
git worktree remove .worktrees/docs-acp-agents
git branch -d docs-acp-agents
```

---

## Done

Verification checklist (all should be true after the plan completes):

- [ ] `qwen`, `gemini`, `opencode` installed and version-verified on Mac mini
- [ ] `~/.config/opencode/opencode.json` provisioned on Mac mini, points at LiteLLM
- [ ] `data/resources.md` lists the three new CLIs
- [ ] All three new agents appear in the UI selector
- [ ] All three pass the 3-step smoke test (chat / tool-call / permission)
- [ ] `acp.md` updated with the new agents table
- [ ] No regressions: existing Claude Code and Codex sessions still work

If any smoke test fails partway through, the partial work for working agents stays merged — the failing agent's work either gets fixed in place or reverted via `git revert` of its specific commits.
