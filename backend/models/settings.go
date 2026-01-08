package models

// UserSettings represents the full application settings structure
// This matches the TypeScript UserSettings interface from frontend/app/lib/config/settings.ts
type UserSettings struct {
	Preferences Preferences               `json:"preferences"`
	Vendors     *Vendors                  `json:"vendors,omitempty"`
	Digesters   map[string]bool           `json:"digesters,omitempty"`
	Extraction  Extraction                `json:"extraction"`
	Enrichment  map[string]map[string]any `json:"enrichment,omitempty"`
	Storage     Storage                   `json:"storage"`
}

type Preferences struct {
	Theme         string   `json:"theme"`
	DefaultView   string   `json:"defaultView"`
	WeeklyDigest  bool     `json:"weeklyDigest"`
	DigestDay     int      `json:"digestDay"`
	LogLevel      string   `json:"logLevel,omitempty"`
	UserEmail     string   `json:"userEmail,omitempty"`
	Languages     []string `json:"languages,omitempty"`
}

type Vendors struct {
	OpenAI      *OpenAI      `json:"openai,omitempty"`
	HomelabAI   *HomelabAI   `json:"homelabAi,omitempty"`
	Meilisearch *Meilisearch `json:"meilisearch,omitempty"`
	Qdrant      *Qdrant      `json:"qdrant,omitempty"`
}

type OpenAI struct {
	BaseURL string `json:"baseUrl,omitempty"`
	APIKey  string `json:"apiKey,omitempty"`
	Model   string `json:"model,omitempty"`
}

type HomelabAI struct {
	BaseURL      string `json:"baseUrl,omitempty"`
	ChromeCdpURL string `json:"chromeCdpUrl,omitempty"`
}

type Meilisearch struct {
	Host string `json:"host,omitempty"`
}

type Qdrant struct {
	Host string `json:"host,omitempty"`
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
