package server

import (
	"encoding/json"
	"fmt"
	"strings"
)

// codexCatalogForModels extends Codex's bundled model metadata with gateway
// models. codex-acp validates model changes against this catalog, while the
// application's model dropdown is driven by AGENT_MODELS.
func codexCatalogForModels(models []AgentModelInfo) ([]byte, error) {
	codexModels := FilterModelsForAgent(models, "codex")
	if len(codexModels) == 0 {
		return codexModelCatalog, nil
	}

	var catalog struct {
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(codexModelCatalog, &catalog); err != nil {
		return nil, fmt.Errorf("parse Codex model catalog: %w", err)
	}
	known := make(map[string]int, len(catalog.Models))
	baseSlugs := make([]string, 0, len(catalog.Models))
	for i, raw := range catalog.Models {
		var entry struct {
			Slug string `json:"slug"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			return nil, fmt.Errorf("parse Codex model entry: %w", err)
		}
		known[entry.Slug] = i
		baseSlugs = append(baseSlugs, entry.Slug)
	}

	for _, model := range codexModels {
		if model.Value == "" {
			return nil, fmt.Errorf("Codex model in AGENT_MODELS has an empty value")
		}
		if i, ok := known[model.Value]; ok {
			// Built-in entries can be hidden from models/list, even when the
			// gateway explicitly offers them for interactive selection.
			var entry map[string]json.RawMessage
			if err := json.Unmarshal(catalog.Models[i], &entry); err != nil {
				return nil, fmt.Errorf("parse Codex model %q: %w", model.Value, err)
			}
			entry["visibility"] = json.RawMessage(`"list"`)
			if err := setCodexDefaultEffort(entry, model.Effort, model.Value); err != nil {
				return nil, err
			}
			updated, err := json.Marshal(entry)
			if err != nil {
				return nil, fmt.Errorf("marshal Codex model %q: %w", model.Value, err)
			}
			catalog.Models[i] = updated
			continue
		}

		// Copy the closest bundled model's capabilities. An unfamiliar
		// family uses the general-purpose entry as an estimated baseline;
		// AGENT_MODELS does not declare context size or supported efforts.
		template := "gpt-5.4"
		if lastDash := strings.LastIndexByte(model.Value, '-'); strings.HasPrefix(model.Value, "gpt-") && lastDash >= 0 {
			family := model.Value[lastDash:]
			for _, slug := range baseSlugs {
				if family != "-latest" && strings.HasPrefix(slug, "gpt-") && strings.HasSuffix(slug, family) {
					template = slug
					break
				}
			}
		}
		var entry map[string]json.RawMessage
		if err := json.Unmarshal(catalog.Models[known[template]], &entry); err != nil {
			return nil, fmt.Errorf("parse Codex template %q: %w", template, err)
		}
		name := model.Name
		if name == "" {
			name = model.Value
		}
		for key, value := range map[string]string{
			"slug": model.Value, "display_name": name,
			"description": model.Description, "visibility": "list",
		} {
			encoded, _ := json.Marshal(value)
			entry[key] = encoded
		}
		if err := setCodexDefaultEffort(entry, model.Effort, model.Value); err != nil {
			return nil, err
		}
		generated, err := json.Marshal(entry)
		if err != nil {
			return nil, fmt.Errorf("marshal Codex model %q: %w", model.Value, err)
		}
		known[model.Value] = len(catalog.Models)
		catalog.Models = append(catalog.Models, generated)
	}
	return json.Marshal(catalog)
}

func setCodexDefaultEffort(entry map[string]json.RawMessage, effort, modelID string) error {
	if effort == "" {
		return nil
	}
	var levels []struct {
		Effort string `json:"effort"`
	}
	if err := json.Unmarshal(entry["supported_reasoning_levels"], &levels); err != nil {
		return fmt.Errorf("parse Codex reasoning levels for %q: %w", modelID, err)
	}
	for _, level := range levels {
		if level.Effort == effort {
			entry["default_reasoning_level"], _ = json.Marshal(effort)
			return nil
		}
	}
	return fmt.Errorf("Codex model %q: effort %q is not supported by its catalog metadata", modelID, effort)
}
