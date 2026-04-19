package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/server"
)

// configOption mirrors the ACP ConfigOption structure for JSON serialization.
type configOption struct {
	ID           string               `json:"id"`
	Category     string               `json:"category"`
	Name         string               `json:"name"`
	Description  string               `json:"description,omitempty"`
	CurrentValue string               `json:"currentValue"`
	Type         string               `json:"type"`
	Options      []configOptionChoice `json:"options"`
}

type configOptionChoice struct {
	Value       string `json:"value"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// Default configOptions per agent type. These match what each agent reports
// via config_option_update on a fresh session.
var defaultConfigOptions = map[string][]configOption{
	"claude_code": {
		{
			ID: "model", Category: "model", Name: "Model", Type: "select",
			Description:  "AI model to use",
			CurrentValue: "default",
			Options: []configOptionChoice{
				{Value: "default", Name: "Default (recommended)", Description: "Use the default model (currently Sonnet 4.6) · $3/$15 per Mtok"},
				{Value: "sonnet[1m]", Name: "Sonnet (1M context)", Description: "Sonnet 4.6 for long sessions · $3/$15 per Mtok"},
				{Value: "opus[1m]", Name: "Opus (1M context)", Description: "Opus 4.6 with 1M context [NEW] · Most capable for complex work"},
				{Value: "haiku", Name: "Haiku", Description: "Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok"},
			},
		},
		{
			ID: "mode", Category: "mode", Name: "Mode", Type: "select",
			Description:  "Session permission mode",
			CurrentValue: "bypassPermissions",
			Options: []configOptionChoice{
				{Value: "default", Name: "Default", Description: "Standard behavior, prompts for dangerous operations"},
				{Value: "acceptEdits", Name: "Accept Edits", Description: "Auto-accept file edit operations"},
				{Value: "plan", Name: "Plan Mode", Description: "Planning mode, no actual tool execution"},
				{Value: "dontAsk", Name: "Don't Ask", Description: "Don't prompt for permissions, deny if not pre-approved"},
				{Value: "bypassPermissions", Name: "Bypass Permissions", Description: "Bypass all permission checks"},
			},
		},
	},
	"codex": {
		{
			ID: "model", Category: "model", Name: "Model", Type: "select",
			Description:  "Choose which model Codex should use",
			CurrentValue: "gpt-5.4",
			Options: []configOptionChoice{
				{Value: "gpt-5.3-codex", Name: "gpt-5.3-codex", Description: "Latest frontier agentic coding model."},
				{Value: "gpt-5.4", Name: "gpt-5.4", Description: "Latest frontier agentic coding model."},
				{Value: "gpt-5.2-codex", Name: "gpt-5.2-codex", Description: "Frontier agentic coding model."},
				{Value: "gpt-5.1-codex-max", Name: "gpt-5.1-codex-max", Description: "Codex-optimized flagship for deep and fast reasoning."},
				{Value: "gpt-5.2", Name: "gpt-5.2", Description: "Latest frontier model with improvements across knowledge, reasoning and coding"},
				{Value: "gpt-5.1-codex-mini", Name: "gpt-5.1-codex-mini", Description: "Optimized for codex. Cheaper, faster, but less capable."},
			},
		},
		{
			ID: "reasoning_effort", Category: "thought_level", Name: "Reasoning Effort", Type: "select",
			Description:  "Choose how much reasoning effort the model should use",
			CurrentValue: "high",
			Options: []configOptionChoice{
				{Value: "low", Name: "Low", Description: "Fast responses with lighter reasoning"},
				{Value: "medium", Name: "Medium", Description: "Balances speed and reasoning depth for everyday tasks"},
				{Value: "high", Name: "High", Description: "Greater reasoning depth for complex problems"},
				{Value: "xhigh", Name: "Xhigh", Description: "Extra high reasoning depth for complex problems"},
			},
		},
		{
			ID: "mode", Category: "mode", Name: "Approval Preset", Type: "select",
			Description:  "Choose an approval and sandboxing preset for your session",
			CurrentValue: "full-access",
			Options: []configOptionChoice{
				{Value: "read-only", Name: "Read Only", Description: "Codex can read files in the current workspace. Approval is required to edit files or access the internet."},
				{Value: "auto", Name: "Default", Description: "Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files."},
				{Value: "full-access", Name: "Full Access", Description: "Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using."},
			},
		},
	},
	"qwen": {
		{
			ID: "model", Category: "model", Name: "Model", Type: "select",
			Description:  "Qwen model to use",
			CurrentValue: "qwen3-coder-plus",
			Options: []configOptionChoice{
				{Value: "qwen3-coder-plus", Name: "Qwen3 Coder Plus", Description: "Frontier Qwen3 coding model"},
			},
		},
		{
			ID: "mode", Category: "mode", Name: "Approval Mode", Type: "select",
			Description:  "Tool approval behavior (qwen ACP session/set_mode)",
			CurrentValue: "default",
			Options: []configOptionChoice{
				{Value: "plan", Name: "Plan", Description: "Analyze only, do not modify files or execute commands"},
				{Value: "default", Name: "Default", Description: "Require approval for file edits or shell commands"},
				{Value: "auto-edit", Name: "Auto Edit", Description: "Automatically approve file edits"},
				{Value: "yolo", Name: "YOLO", Description: "Automatically approve all tools"},
			},
		},
	},
	"gemini": {
		{
			ID: "model", Category: "model", Name: "Model", Type: "select",
			Description:  "Gemini model to use",
			CurrentValue: "gemini-3-pro",
			Options: []configOptionChoice{
				{Value: "gemini-3-pro", Name: "Gemini 3 Pro", Description: "Frontier Gemini model with 1M context"},
			},
		},
		{
			ID: "mode", Category: "mode", Name: "Approval Mode", Type: "select",
			Description:  "Tool approval behavior (gemini ACP session/set_mode)",
			CurrentValue: "default",
			Options: []configOptionChoice{
				{Value: "default", Name: "Default", Description: "Prompts for approval"},
				{Value: "autoEdit", Name: "Auto Edit", Description: "Auto-approves edit tools"},
				{Value: "yolo", Name: "YOLO", Description: "Auto-approves all tools"},
				{Value: "plan", Name: "Plan", Description: "Read-only mode"},
			},
		},
	},
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
}

// buildAgentConfigOptions returns the session-level configOptions for a single
// agent type, applying AGENT_MODELS rewrite rules: when the gateway has models
// tagged for this agent the model dropdown is replaced; when no gateway models
// match but AGENT_MODELS is otherwise set, the model option is dropped.
// Returns nil for unknown agent types.
func buildAgentConfigOptions(agentType string, allModels []server.AgentModelInfo) []configOption {
	defaults, ok := defaultConfigOptions[agentType]
	if !ok {
		return nil
	}
	opts := make([]configOption, len(defaults))
	copy(opts, defaults)

	if len(allModels) == 0 {
		return opts
	}
	agentModels := server.FilterModelsForAgent(allModels, agentType)
	if len(agentModels) == 0 {
		filtered := opts[:0]
		for _, opt := range opts {
			if opt.Category != "model" {
				filtered = append(filtered, opt)
			}
		}
		return filtered
	}
	replacementOptions := make([]configOptionChoice, len(agentModels))
	for i, m := range agentModels {
		replacementOptions[i] = configOptionChoice{
			Value: m.Value, Name: m.Name, Description: m.Description,
		}
	}
	for i, opt := range opts {
		if opt.Category == "model" {
			opts[i].Options = replacementOptions
			opts[i].CurrentValue = agentModels[0].Value
		}
	}
	return opts
}

// GetAgentConfig returns agent configuration for the frontend.
// Includes per-agent-type default configOptions. When AGENT_MODELS is
// configured, replaces the model options for each agent type.
func (h *Handlers) GetAgentConfig(c *gin.Context) {
	cfg := h.server.Cfg()

	result := make(map[string][]configOption, len(defaultConfigOptions))
	for agentType := range defaultConfigOptions {
		result[agentType] = buildAgentConfigOptions(agentType, cfg.AgentLLM.Models)
	}

	c.JSON(http.StatusOK, gin.H{
		"defaultConfigOptions": result,
	})
}
