// Package apps defines the import-catalog registry types and loader.
package apps

// App is the public registry entry for a supported external app.
//
// ImportPrompt is the legacy single-prompt path kept for apps not yet migrated
// to the structured Import schema; new apps should use AppDetail.Import.
type App struct {
	ID           string `yaml:"id" json:"id"`
	Name         string `yaml:"name" json:"name"`
	Category     string `yaml:"category" json:"category"`
	Website      string `yaml:"website,omitempty" json:"website,omitempty"`
	Description  string `yaml:"description,omitempty" json:"description,omitempty"`
	Icon         string `yaml:"icon,omitempty" json:"icon,omitempty"`
	ImportPrompt string `yaml:"import_prompt,omitempty" json:"importPrompt,omitempty"`
}

// AppDetail extends App with import guidance — either the legacy markdown
// `Doc`, or the structured `Import` block. Migrated apps use Import; the
// frontend falls back to Doc otherwise.
type AppDetail struct {
	App
	Doc    string      `yaml:"-" json:"doc,omitempty"`
	Import *ImportSpec `yaml:"-" json:"import,omitempty"`
}

// ImportSpec groups the two import paths surfaced in the dialog UI.
type ImportSpec struct {
	OneOff         *ImportSection `yaml:"one_off,omitempty" json:"oneOff,omitempty"`
	ContinuousSync *ImportSection `yaml:"continuous_sync,omitempty" json:"continuousSync,omitempty"`
}

// ImportSection describes one import path (one-off or continuous).
//
// When Feasible is false, Reason is shown. When Feasible is true, Options is
// populated. Per-section prose lives in each option's Description.
type ImportSection struct {
	Feasible bool           `yaml:"feasible" json:"feasible"`
	Reason   string         `yaml:"reason,omitempty" json:"reason,omitempty"`
	Options  []ImportOption `yaml:"options,omitempty" json:"options,omitempty"`
}

// ImportOption is one selectable path within a section. Each option has its
// own Start-Import seed prompt that opens an agent session.
type ImportOption struct {
	ID          string `yaml:"id" json:"id"`
	Name        string `yaml:"name" json:"name"`
	URL         string `yaml:"url,omitempty" json:"url,omitempty"`
	Description string `yaml:"description" json:"description"`
	SeedPrompt  string `yaml:"seed_prompt" json:"seedPrompt"`
}
