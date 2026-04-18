# Add Gemini CLI, Qwen Code, and opencode as ACP Agents

**Date:** 2026-04-18
**Status:** Design approved, ready for implementation plan

## Summary

Add three new ACP agents — **Gemini CLI**, **Qwen Code**, and **opencode** — alongside the existing Claude Code and Codex. All three route LLM calls through the project's existing LiteLLM gateway (`AGENT_BASE_URL` / `AGENT_API_KEY`).

The implementation is inline: each new agent is registered through the same 5 touchpoints the existing agents use. No registry refactor, no new protocol code — the `backend/agentsdk/` ACP plumbing already works for any ACP-compatible binary.

## Goals

- Expand model coverage (Gemini 3, Qwen3) and agent diversity (opencode's alt-client architecture)
- Keep LiteLLM as the single billing/observability point for all agents
- Match the install/integration style of the existing agents — no new configuration patterns

## Non-goals

- Config-driven agent registry (rejected in favor of inline)
- User-extensible agent list (rejected — scope creep)
- Adding every ACP agent on the official list (explicit: mature + capable only)
- Pool pre-warming for new agents (defer until measured latency demands it)

## Agents being added

| Agent | Binary | Args | Auth (via LiteLLM) |
|-------|--------|------|---------------------|
| Gemini CLI | `gemini` | `--experimental-acp` | `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY` |
| Qwen Code | `qwen` | `--acp` | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` |
| opencode | `opencode` | `acp` | config file at `~/.config/opencode/opencode.json` pointing at LiteLLM |

All three have stable ACP support per the official [Agent Client Protocol agents list](https://agentclientprotocol.com/overview/agents) and have documented LiteLLM integration paths.

## Architecture

No protocol-layer changes. The existing `backend/agentsdk/acpsession.go` spawn/handshake flow is agent-agnostic — it spawns any ACP binary over stdio JSON-RPC.

### Backend changes

**1. `backend/agentsdk/types.go`** — add three constants to the `AgentType` enum:

```go
const (
    AgentClaudeCode AgentType = "claude_code"
    AgentCodex      AgentType = "codex"
    AgentGemini     AgentType = "gemini"
    AgentQwen       AgentType = "qwen"
    AgentOpencode   AgentType = "opencode"
)
```

**2. `backend/server/server.go`** (around lines 165–194) — add three `AgentConfig` registrations and pass them to `NewClient`. Env maps per agent:

```go
geminiEnv := map[string]string{
    "GOOGLE_GEMINI_BASE_URL": cfg.AgentLLM.BaseURL,
    "GEMINI_API_KEY":         cfg.AgentLLM.APIKey,
}
qwenEnv := map[string]string{
    "OPENAI_BASE_URL": cfg.AgentLLM.BaseURL,
    "OPENAI_API_KEY":  cfg.AgentLLM.APIKey,
}
opencodeEnv := map[string]string{
    // opencode reads its provider from the file at ~/.config/opencode/opencode.json
    // which is provisioned once during Mac mini setup (see "Installation" below).
}

geminiAgent   := agentsdk.AgentConfig{Type: agentsdk.AgentGemini,   Name: "Gemini",   Command: "gemini",   Args: []string{"--experimental-acp"}, Env: geminiEnv}
qwenAgent     := agentsdk.AgentConfig{Type: agentsdk.AgentQwen,     Name: "Qwen",     Command: "qwen",     Args: []string{"--acp"},               Env: qwenEnv}
opencodeAgent := agentsdk.AgentConfig{Type: agentsdk.AgentOpencode, Name: "opencode", Command: "opencode", Args: []string{"acp"},                 Env: opencodeEnv}

s.agentClient = agentsdk.NewClient(defaults, ccAgent, codexAgent, geminiAgent, qwenAgent, opencodeAgent)
// Pool warming stays Claude-Code-only.
```

**3. `backend/api/agent_manager.go`** — extend:

- The `agentTypeString` conversion (lines ~52–57)
- The per-agent env override switch (lines ~284–298) — sets `GEMINI_MODEL` / `OPENAI_MODEL` / opencode's config when a non-default model is selected

**4. `backend/api/agent_config.go`** — add three entries to `defaultConfigOptions` with per-agent model choices and mode options. Follows the same structure as the existing Claude Code / Codex entries.

### Model list

Models are declared once in the `AGENT_MODELS` JSON env var. Per-agent visibility is controlled by the `agents` field on each `AgentModelInfo`. Example:

```json
[
  { "id": "gemini-3-pro",           "name": "Gemini 3 Pro",      "agents": ["gemini"] },
  { "id": "qwen3-coder-plus",       "name": "Qwen3 Coder Plus",  "agents": ["qwen"] },
  { "id": "claude-sonnet-4-6",      "name": "Claude Sonnet 4.6", "agents": ["claude_code", "opencode"] }
]
```

opencode is intentionally multi-model — it doesn't have a "native" model family, so it gets a curated selection routed through LiteLLM.

### Frontend changes

**`frontend/app/components/agent/agent-type-selector.tsx`**:

1. Extend the `AgentType` union:
   ```ts
   type AgentType = 'claude_code' | 'codex' | 'gemini' | 'qwen' | 'opencode';
   ```

2. Add three entries to the `AGENT_TYPES` array (value, label, description, icon SVG). Icons: official marks from each project.

3. Add three entries to `DEFAULT_MODES` — `"default"` for Gemini and Qwen; opencode has named modes (build / plan) that map to its CLI flags.

Config dropdowns (model, mode) auto-populate from `/api/agent/config`, so no additional frontend work.

## Data flow

No changes. Session creation flows the existing path:

```
UI agent-type-selector → POST /api/agent/session {agent_type: "gemini"}
  → AgentManager.CreateSession → agentsdk.Client.CreateSession
  → exec.CommandContext("gemini", "--experimental-acp", ...) with env
  → ACP initialize + session/new handshake
  → acpSession wrapped; prompts stream over the existing WebSocket fan-out
```

## Installation

One-time setup on the Mac mini (macOS):

```bash
npm install -g @google/gemini-cli
npm install -g @qwen-code/qwen-code
npm install -g opencode-ai  # or: brew install sst/tap/opencode
```

**opencode config provisioning** (one-time, per Mac mini):

Write `~/.config/opencode/opencode.json` pointing its provider at the LiteLLM gateway:

```json
{
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

This is a manual step documented in `resources.md`; not generated by MyLifeDB at runtime. If users want to override models, they edit the file.

Update `my-life-db/data/resources.md` to list the three new CLIs under installed tools.

## Error handling

Inherits the existing ACP session error paths. Specific failure modes worth noting:

- **Binary not on PATH** → `exec.CommandContext` returns ENOENT; current error propagation surfaces a clear error to the UI. No change needed.
- **Gemini's `--experimental-acp` flag renamed** → add a comment in `server.go` referencing [Qwen Code issue #1350](https://github.com/QwenLM/qwen-code/issues/1350) (same pattern) for version-bump checks.
- **LiteLLM missing a requested model** → surfaces as a provider error in the session; no code change, just update `AGENT_MODELS`.
- **Unknown ACP field in `SessionUpdate`** → already handled as unknown-field passthrough; logged but non-fatal.

## Testing

**No automated tests.** The existing ACP integration has no unit tests — the agents are external subprocesses, and mocking the ACP protocol would be significant scope creep for questionable value.

**Manual smoke test per agent** (gate for merging each rollout step):

1. Install binary on Mac mini, verify `<binary> --version`
2. Restart MyLifeDB backend, confirm agent appears in `/api/agent/info`
3. Create a session through the UI, send "say hello", confirm response streams back
4. Send "list files in this directory", confirm ACP tool-call round-trip works
5. Prompt a file write, confirm the permission dialog fires

## Rollout order

Add one agent at a time, verify end-to-end before the next. Order chosen to surface agent-specific quirks early:

1. **Qwen Code first** — closest to existing Codex pattern (OpenAI-compatible env vars)
2. **Gemini CLI second** — different env-var namespace but well-documented LiteLLM path
3. **opencode third** — file-based config is the outlier; validated core pattern first

## Documentation updates

- `my-life-db-docs/src/content/docs/tech-design/acp.md` — add Gemini / Qwen / opencode to the agents table, document LiteLLM env-var mapping per agent
- `my-life-db/data/resources.md` — list the three new CLIs under installed tools

No new docs files.

## Risks

- **opencode config format drift** → pin version in install docs; revisit quarterly
- **ACP flag renames** (Gemini `--experimental-acp` → `--acp`) → comment the reference in `server.go`; easy fix
- **Model list divergence** — LiteLLM and upstream agents disagree on available models → accept: MyLifeDB's `AGENT_MODELS` is the source of truth; users get clear errors if a requested model isn't served

## Out of scope / future

- Pool pre-warming for new agents (defer until measured latency demands it)
- User-editable custom ACP agent registration (possible future work if demand appears)
- Adding more ACP agents (Kimi CLI, Goose, OpenHands, GitHub Copilot) — not mature enough or LiteLLM fit not verified today

## References

- [Agent Client Protocol](https://agentclientprotocol.com/) — protocol spec
- [Gemini CLI ACP mode](https://geminicli.com/docs/cli/acp-mode/)
- [Qwen Code: graduate `--acp` flag](https://github.com/QwenLM/qwen-code/issues/1350)
- [opencode ACP support](https://opencode.ai/docs/acp/)
- [LiteLLM + Gemini CLI](https://docs.litellm.ai/docs/tutorials/litellm_gemini_cli)
- [LiteLLM + opencode](https://docs.litellm.ai/docs/tutorials/opencode_integration)
- Existing ACP architecture doc: `my-life-db-docs/src/content/docs/tech-design/acp.md`
