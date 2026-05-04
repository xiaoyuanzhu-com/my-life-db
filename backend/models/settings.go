package models

// UserSettings represents the full application settings structure
// This matches the TypeScript UserSettings interface from frontend/app/lib/config/settings.ts
type UserSettings struct {
	Preferences  Preferences               `json:"preferences"`
	Extraction   Extraction                `json:"extraction"`
	Enrichment   map[string]map[string]any `json:"enrichment,omitempty"`
	Storage      Storage                   `json:"storage"`
	Integrations Integrations              `json:"integrations"`
}

// Integrations groups owner-controlled toggles for the non-OAuth ingestion
// surfaces (HTTP webhook, WebDAV, S3-compatible). Each surface is off by
// default; when off the corresponding routes are not registered. Toggling
// requires a server restart in v1 — Phase 4 will hot-reload.
type Integrations struct {
	Surfaces IntegrationSurfaces `json:"surfaces"`
}

// IntegrationSurfaces is the per-protocol on/off table. Mirrors the
// "Integration surfaces" subsection in Settings → General.
type IntegrationSurfaces struct {
	Webhook bool `json:"webhook"`
	WebDAV  bool `json:"webdav"`
	S3      bool `json:"s3"`
}

type Preferences struct {
	Theme       string `json:"theme"`
	DefaultView string `json:"defaultView"`
	LogLevel    string `json:"logLevel,omitempty"`
	// UI language (BCP-47): nil = system default, "en" or "zh-Hans" otherwise.
	// Pointer so partial PUTs can distinguish "field omitted" (keep) from
	// "explicitly cleared back to system default" (sent as JSON `""`).
	Language *string `json:"language,omitempty"`
}

type Extraction struct {
	AutoEnrich            bool    `json:"autoEnrich"`
	IncludeEntities       bool    `json:"includeEntities"`
	IncludeSentiment      bool    `json:"includeSentiment"`
	IncludeActionItems    bool    `json:"includeActionItems"`
	IncludeRelatedEntries bool    `json:"includeRelatedEntries"`
	MinConfidence         float64 `json:"minConfidence"`
}

type Storage struct {
	DataPath    string `json:"dataPath"`
	BackupPath  string `json:"backupPath,omitempty"`
	AutoBackup  bool   `json:"autoBackup"`
	MaxFileSize int    `json:"maxFileSize"`
}
