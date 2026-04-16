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
	},
}

// GetAgentConfig returns agent configuration for the frontend.
// Includes per-agent-type default configOptions. When AGENT_MODELS is
// configured, replaces the model options for each agent type.
func (h *Handlers) GetAgentConfig(c *gin.Context) {
	cfg := h.server.Cfg()

	// Build response: deep-copy defaults so we don't mutate the package-level var
	result := make(map[string][]configOption, len(defaultConfigOptions))
	for agentType, opts := range defaultConfigOptions {
		copied := make([]configOption, len(opts))
		copy(copied, opts)
		result[agentType] = copied
	}

	// When AGENT_MODELS is configured, replace the model config option
	// per agent type, filtering models by their "agents" compatibility field.
	if len(cfg.AgentLLM.Models) > 0 {
		for agentType, opts := range result {
			agentModels := server.FilterModelsForAgent(cfg.AgentLLM.Models, agentType)
			if len(agentModels) == 0 {
				continue // no gateway models support this agent; keep native defaults
			}
			replacementOptions := make([]configOptionChoice, len(agentModels))
			for i, m := range agentModels {
				replacementOptions[i] = configOptionChoice{
					Value: m.Value, Name: m.Name, Description: m.Description,
				}
			}
			for i, opt := range opts {
				if opt.Category == "model" {
					result[agentType][i].Options = replacementOptions
					result[agentType][i].CurrentValue = agentModels[0].Value
				}
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"defaultConfigOptions": result,
	})
}
