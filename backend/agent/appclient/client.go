package appclient

import (
	"context"
	"time"

	"github.com/xiaoyuanzhu-com/my-life-db/agent"
)

// AppClient defines how the agent interacts with MyLifeDB
// This interface could be implemented via direct calls (LocalClient)
// or via HTTP (RemoteClient) for service deployment
type AppClient interface {
	// ──────────────────────────────────────────────────────────────
	// SEARCH & RETRIEVAL
	// ──────────────────────────────────────────────────────────────

	// Search for files using keyword + semantic search
	Search(ctx context.Context, req SearchRequest) (*SearchResult, error)

	// Get file metadata and digests
	GetFile(ctx context.Context, path string) (*FileWithDigests, error)

	// List recently added files
	ListRecentFiles(ctx context.Context, limit int, mimeTypePrefix string) ([]FileSummary, error)

	// ──────────────────────────────────────────────────────────────
	// ORGANIZATION
	// ──────────────────────────────────────────────────────────────

	// Get folder tree structure
	GetFolderTree(ctx context.Context, depth int) (*FolderNode, error)

	// Read user's organization guideline
	ReadGuideline(ctx context.Context) (string, error)

	// Move a file (updates DB + search indices)
	MoveFile(ctx context.Context, from, to string) error

	// ──────────────────────────────────────────────────────────────
	// INTENTIONS & SUGGESTIONS (Agent-specific state)
	// ──────────────────────────────────────────────────────────────

	// Create or update a file intention
	SaveFileIntention(ctx context.Context, intention *agent.FileIntention) error

	// Get file intention
	GetFileIntention(ctx context.Context, filePath string) (*agent.FileIntention, error)

	// Create a pending organization suggestion
	CreateSuggestion(ctx context.Context, s *agent.Suggestion) (string, error)

	// Get pending suggestion for a conversation
	GetPendingSuggestion(ctx context.Context, convID string) (*agent.Suggestion, error)

	// Execute/reject a suggestion
	ResolveSuggestion(ctx context.Context, suggestionID, action string) error
}

// SearchRequest matches the existing /api/search parameters
type SearchRequest struct {
	Query  string
	Type   string // mime type filter
	Folder string // path filter
	Limit  int
}

// SearchResult represents search results
type SearchResult struct {
	Results []SearchResultItem `json:"results"`
	Total   int                `json:"total"`
}

// SearchResultItem represents a single search result
type SearchResultItem struct {
	Path      string  `json:"path"`
	Name      string  `json:"name"`
	MimeType  string  `json:"mime_type"`
	Score     float64 `json:"score"`
	Highlight string  `json:"highlight,omitempty"`
}

// FileWithDigests includes file + all digest content
type FileWithDigests struct {
	Path      string                     `json:"path"`
	Name      string                     `json:"name"`
	MimeType  string                     `json:"mime_type"`
	Size      int64                      `json:"size"`
	CreatedAt time.Time                  `json:"created_at"`
	Digests   map[string]DigestContent   `json:"digests"` // key = digester name
}

// DigestContent represents processed content from a digester
type DigestContent struct {
	Status  string `json:"status"`
	Content string `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
}

// FileSummary is a lightweight file representation
type FileSummary struct {
	Path      string    `json:"path"`
	Name      string    `json:"name"`
	MimeType  string    `json:"mime_type"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"created_at"`
}

// FolderNode represents a folder tree node
type FolderNode struct {
	Name     string        `json:"name"`
	Path     string        `json:"path"`
	IsFolder bool          `json:"is_folder"`
	Children []*FolderNode `json:"children,omitempty"`
}
