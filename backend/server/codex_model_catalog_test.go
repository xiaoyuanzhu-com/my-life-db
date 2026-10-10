package server

import (
	"encoding/json"
	"testing"
)

func TestCodexCatalogIncludesCurrentAndLegacySol(t *testing.T) {
	var catalog struct {
		Models []struct {
			Slug   string `json:"slug"`
			Levels []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	if err := json.Unmarshal(codexModelCatalog, &catalog); err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, model := range catalog.Models {
		if found[model.Slug] {
			t.Fatalf("duplicate model %q", model.Slug)
		}
		found[model.Slug] = true
		if model.Slug == "gpt-6-sol" {
			high := false
			for _, level := range model.Levels {
				high = high || level.Effort == "high"
			}
			if !high {
				t.Fatal("Sol must support high reasoning")
			}
		}
	}
	for _, slug := range []string{"gpt-6-sol", "gpt-5.6-sol"} {
		if !found[slug] {
			t.Fatalf("missing %s", slug)
		}
	}
}

func TestCodexCatalogFollowsAgentModels(t *testing.T) {
	models := []AgentModelInfo{
		{Value: "gpt-6.1-sol", Name: "Sol 6.1", Description: "Gateway Sol", Effort: "high", Agents: []string{"codex"}},
		{Value: "custom-model", Name: "Custom", Agents: []string{"codex"}},
		{Value: "gpt-5.4", Effort: "high", Agents: []string{"codex"}},
		{Value: "claude-only", Agents: []string{"claude_code"}},
	}
	data, err := codexCatalogForModels(models)
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Models []struct {
			Slug        string `json:"slug"`
			Name        string `json:"display_name"`
			Description string `json:"description"`
			Visibility  string `json:"visibility"`
			Default     string `json:"default_reasoning_level"`
			Context     int    `json:"context_window"`
			Levels      []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	found := make(map[string]int)
	for _, model := range catalog.Models {
		found[model.Slug]++
		switch model.Slug {
		case "gpt-6.1-sol":
			if model.Name != "Sol 6.1" || model.Description != "Gateway Sol" || model.Default != "high" || len(model.Levels) == 0 || model.Context != 272000 || model.Visibility != "list" {
				t.Fatalf("new Sol metadata: %+v", model)
			}
		case "custom-model":
			if model.Name != "Custom" || model.Context == 0 || model.Visibility != "list" {
				t.Fatalf("custom model metadata: %+v", model)
			}
		case "gpt-5.4":
			if model.Visibility != "list" || model.Default != "high" {
				t.Fatalf("configured built-in model is hidden: %+v", model)
			}
		}
	}
	for _, slug := range []string{"gpt-6.1-sol", "custom-model", "gpt-5.4"} {
		if found[slug] != 1 {
			t.Fatalf("found %d %s entries, want one", found[slug], slug)
		}
	}
	if found["claude-only"] != 0 {
		t.Fatal("Codex catalog includes model restricted to another agent")
	}

	data, err = codexCatalogForModels([]AgentModelInfo{{Value: "claude-only", Agents: []string{"claude_code"}}})
	if err != nil || string(data) != string(codexModelCatalog) {
		t.Fatalf("Codex catalog changed without Codex models: %v", err)
	}
	if _, err := codexCatalogForModels([]AgentModelInfo{{Value: "custom-sol", Effort: "invalid", Agents: []string{"codex"}}}); err == nil {
		t.Fatal("expected unsupported default effort to be rejected")
	}
}
