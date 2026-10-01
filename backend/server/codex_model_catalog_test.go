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
