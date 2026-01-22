package models

// SessionIndex represents the sessions-index.json file
type SessionIndex struct {
	Version int                 `json:"version"`
	Entries []SessionIndexEntry `json:"entries"`
}

// SessionIndexEntry represents a single session in the index
type SessionIndexEntry struct {
	SessionID    string `json:"sessionId"`
	FullPath     string `json:"fullPath"`
	FileMtime    int64  `json:"fileMtime"`
	FirstPrompt  string `json:"firstPrompt"`
	Summary      string `json:"summary,omitempty"`      // Claude-generated 5-10 word title
	CustomTitle  string `json:"customTitle,omitempty"`  // User-set custom title (via /title command)
	MessageCount int    `json:"messageCount"`
	Created      string `json:"created"`
	Modified     string `json:"modified"`
	GitBranch    string `json:"gitBranch"`
	ProjectPath  string `json:"projectPath"`
	IsSidechain  bool   `json:"isSidechain"`
}
