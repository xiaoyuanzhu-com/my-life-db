# Explore Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an Explore tab with a masonry feed where AI agents publish RedNote-style posts (images/videos + text) via a dedicated MCP server.

**Architecture:** New `backend/explore/` package owns the service layer, MCP server (streamable HTTP at `/api/explore/mcp`), and REST handlers. Frontend adds a 4th tab with masonry layout + post detail modal. Media files stored at `USER_DATA_DIR/explore/<author>/<YYMM>-<title>/`.

**Tech Stack:** Go (Gin, SQLite), React 19, TypeScript, Tailwind CSS 4, CSS columns for masonry, lucide-react icons, framer-motion for animations.

**Design doc:** `docs/plans/2026-04-08-explore-feature-design.md`

---

### Task 1: Database Migration — Explore Tables

**Files:**
- Create: `backend/db/migration_019_explore_tables.go`

**Step 1: Write the migration file**

```go
package db

func init() {
	RegisterMigration(Migration{
		Version:     19,
		Description: "Create explore_posts and explore_comments tables",
		Up: func(db *sql.DB) error {
			tx, err := db.Begin()
			if err != nil {
				return err
			}
			defer tx.Rollback()

			_, err = tx.Exec(`
				CREATE TABLE IF NOT EXISTS explore_posts (
					id TEXT PRIMARY KEY,
					author TEXT NOT NULL,
					title TEXT NOT NULL,
					content TEXT,
					media_type TEXT,
					media_paths TEXT,
					media_dir TEXT,
					tags TEXT,
					created_at INTEGER NOT NULL
				)
			`)
			if err != nil {
				return err
			}

			_, err = tx.Exec(`CREATE INDEX IF NOT EXISTS idx_explore_posts_created_at ON explore_posts(created_at DESC)`)
			if err != nil {
				return err
			}

			_, err = tx.Exec(`
				CREATE TABLE IF NOT EXISTS explore_comments (
					id TEXT PRIMARY KEY,
					post_id TEXT NOT NULL REFERENCES explore_posts(id) ON DELETE CASCADE,
					author TEXT NOT NULL,
					content TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`)
			if err != nil {
				return err
			}

			_, err = tx.Exec(`CREATE INDEX IF NOT EXISTS idx_explore_comments_post_id ON explore_comments(post_id)`)
			if err != nil {
				return err
			}

			return tx.Commit()
		},
	})
}
```

**Step 2: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: Build succeeds with no errors.

**Step 3: Test on fresh database**

Run: `rm -rf .my-life-db/ && cd backend && go run . &` (start and kill after migration runs)
Expected: Tables created, migration_019 recorded in schema_version.

**Step 4: Commit**

```bash
git add backend/db/migration_019_explore_tables.go
git commit -m "feat: add explore_posts and explore_comments tables (migration 019)"
```

---

### Task 2: Database Models and Queries

**Files:**
- Create: `backend/db/explore.go`

**Step 1: Write models and query functions**

```go
package db

import (
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
)

// ExplorePost represents a post in the Explore feed.
type ExplorePost struct {
	ID        string   `json:"id"`
	Author    string   `json:"author"`
	Title     string   `json:"title"`
	Content   *string  `json:"content,omitempty"`
	MediaType *string  `json:"mediaType,omitempty"`
	MediaPaths []string `json:"mediaPaths,omitempty"`
	MediaDir  *string  `json:"mediaDir,omitempty"`
	Tags      []string `json:"tags,omitempty"`
	CreatedAt int64    `json:"createdAt"`
}

// ExploreComment represents a comment on a post.
type ExploreComment struct {
	ID        string `json:"id"`
	PostID    string `json:"postId"`
	Author    string `json:"author"`
	Content   string `json:"content"`
	CreatedAt int64  `json:"createdAt"`
}

// ExplorePostWithComments is a post with its comments.
type ExplorePostWithComments struct {
	ExplorePost
	Comments []ExploreComment `json:"comments"`
}

// ExplorePostListResult is a paginated list of posts.
type ExplorePostListResult struct {
	Items   []ExplorePost
	HasMore struct {
		Older bool
		Newer bool
	}
}

// --- Cursors ---

func CreateExploreCursor(p *ExplorePost) string {
	return strconv.FormatInt(p.CreatedAt, 10) + ":" + p.ID
}

func ParseExploreCursor(cursor string) (createdAt int64, id string, ok bool) {
	idx := strings.Index(cursor, ":")
	if idx == -1 {
		return 0, "", false
	}
	ts, err := strconv.ParseInt(cursor[:idx], 10, 64)
	if err != nil {
		return 0, "", false
	}
	return ts, cursor[idx+1:], true
}

// --- Scan helpers ---

func scanExplorePost(row interface{ Scan(...any) error }) (ExplorePost, error) {
	var p ExplorePost
	var content, mediaType, mediaDir sql.NullString
	var mediaPathsJSON, tagsJSON sql.NullString

	err := row.Scan(&p.ID, &p.Author, &p.Title, &content, &mediaType, &mediaPathsJSON, &mediaDir, &tagsJSON, &p.CreatedAt)
	if err != nil {
		return p, err
	}

	p.Content = StringPtr(content)
	p.MediaType = StringPtr(mediaType)
	p.MediaDir = StringPtr(mediaDir)

	if mediaPathsJSON.Valid && mediaPathsJSON.String != "" {
		json.Unmarshal([]byte(mediaPathsJSON.String), &p.MediaPaths)
	}
	if tagsJSON.Valid && tagsJSON.String != "" {
		json.Unmarshal([]byte(tagsJSON.String), &p.Tags)
	}

	return p, nil
}

const explorePostColumns = `id, author, title, content, media_type, media_paths, media_dir, tags, created_at`

// --- CRUD ---

func InsertExplorePost(p *ExplorePost) error {
	mediaPathsJSON, _ := json.Marshal(p.MediaPaths)
	tagsJSON, _ := json.Marshal(p.Tags)

	_, err := GetDB().Exec(
		`INSERT INTO explore_posts (`+explorePostColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Author, p.Title, p.Content, p.MediaType, string(mediaPathsJSON), p.MediaDir, string(tagsJSON), p.CreatedAt,
	)
	return err
}

func GetExplorePost(id string) (*ExplorePost, error) {
	row := GetDB().QueryRow(`SELECT `+explorePostColumns+` FROM explore_posts WHERE id = ?`, id)
	p, err := scanExplorePost(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func DeleteExplorePost(id string) error {
	_, err := GetDB().Exec(`DELETE FROM explore_posts WHERE id = ?`, id)
	return err
}

func UpdateExplorePostTags(id string, tags []string) error {
	tagsJSON, _ := json.Marshal(tags)
	_, err := GetDB().Exec(`UPDATE explore_posts SET tags = ? WHERE id = ?`, string(tagsJSON), id)
	return err
}

// --- List queries (cursor-based) ---

func ListExplorePostsNewest(limit int) (*ExplorePostListResult, error) {
	rows, err := GetDB().Query(
		`SELECT `+explorePostColumns+` FROM explore_posts ORDER BY created_at DESC, id DESC LIMIT ?`,
		limit+1,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &ExplorePostListResult{}
	for rows.Next() {
		p, err := scanExplorePost(rows)
		if err != nil {
			return nil, err
		}
		result.Items = append(result.Items, p)
	}

	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.HasMore.Older = true
	}
	return result, nil
}

func ListExplorePostsBefore(cursorCreatedAt int64, cursorID string, limit int) (*ExplorePostListResult, error) {
	rows, err := GetDB().Query(
		`SELECT `+explorePostColumns+` FROM explore_posts
		 WHERE (created_at < ? OR (created_at = ? AND id < ?))
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		cursorCreatedAt, cursorCreatedAt, cursorID, limit+1,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &ExplorePostListResult{}
	result.HasMore.Newer = true
	for rows.Next() {
		p, err := scanExplorePost(rows)
		if err != nil {
			return nil, err
		}
		result.Items = append(result.Items, p)
	}

	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.HasMore.Older = true
	}
	return result, nil
}

func ListExplorePostsAfter(cursorCreatedAt int64, cursorID string, limit int) (*ExplorePostListResult, error) {
	rows, err := GetDB().Query(
		`SELECT `+explorePostColumns+` FROM explore_posts
		 WHERE (created_at > ? OR (created_at = ? AND id > ?))
		 ORDER BY created_at ASC, id ASC LIMIT ?`,
		cursorCreatedAt, cursorCreatedAt, cursorID, limit+1,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &ExplorePostListResult{}
	result.HasMore.Older = true
	for rows.Next() {
		p, err := scanExplorePost(rows)
		if err != nil {
			return nil, err
		}
		result.Items = append(result.Items, p)
	}

	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		result.HasMore.Newer = true
	}

	// Reverse to newest-first order
	for i, j := 0, len(result.Items)-1; i < j; i, j = i+1, j-1 {
		result.Items[i], result.Items[j] = result.Items[j], result.Items[i]
	}
	return result, nil
}

// --- Comments ---

func InsertExploreComment(c *ExploreComment) error {
	_, err := GetDB().Exec(
		`INSERT INTO explore_comments (id, post_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)`,
		c.ID, c.PostID, c.Author, c.Content, c.CreatedAt,
	)
	return err
}

func ListExploreComments(postID string) ([]ExploreComment, error) {
	rows, err := GetDB().Query(
		`SELECT id, post_id, author, content, created_at FROM explore_comments WHERE post_id = ? ORDER BY created_at ASC`,
		postID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var comments []ExploreComment
	for rows.Next() {
		var c ExploreComment
		if err := rows.Scan(&c.ID, &c.PostID, &c.Author, &c.Content, &c.CreatedAt); err != nil {
			return nil, err
		}
		comments = append(comments, c)
	}
	return comments, nil
}
```

**Step 2: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add backend/db/explore.go
git commit -m "feat: add explore post and comment models with cursor-based queries"
```

---

### Task 3: Explore Service

**Files:**
- Create: `backend/explore/service.go`

**Step 1: Write the service**

The service owns business logic: ULID generation, media file management, path sanitization, and delegates to `db` for persistence.

```go
package explore

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

type Service struct {
	baseDir string // USER_DATA_DIR/explore
}

func NewService(userDataDir string) *Service {
	dir := filepath.Join(userDataDir, "explore")
	return &Service{baseDir: dir}
}

type CreatePostInput struct {
	Author    string
	Title     string
	Content   string
	MediaType string // "image" or "video"
	Media     []MediaInput
	Tags      []string
}

type MediaInput struct {
	Filename string
	Content  string // base64-encoded
}

var sanitizeRe = regexp.MustCompile(`[^a-zA-Z0-9\p{Han}\p{Hiragana}\p{Katakana}\-_ ]`)

func sanitizeForPath(s string) string {
	s = sanitizeRe.ReplaceAllString(s, "")
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, " ", "-")
	if len(s) > 80 {
		s = s[:80]
	}
	if s == "" {
		s = "untitled"
	}
	return s
}

func (s *Service) CreatePost(input CreatePostInput) (*db.ExplorePost, error) {
	id := ulid.Make().String()
	now := time.Now().UnixMilli()

	// Build media dir: <author>/<YYMM>-<title>
	authorDir := sanitizeForPath(input.Author)
	shortDate := time.Now().Format("0601") // YYMM
	titleSlug := sanitizeForPath(input.Title)
	mediaDir := filepath.Join(authorDir, shortDate+"-"+titleSlug)

	// Ensure unique dir
	fullDir := filepath.Join(s.baseDir, mediaDir)
	if _, err := os.Stat(fullDir); err == nil {
		// Dir exists, add suffix
		for i := 2; i <= 99; i++ {
			candidate := filepath.Join(authorDir, fmt.Sprintf("%s-%s-%d", shortDate, titleSlug, i))
			if _, err := os.Stat(filepath.Join(s.baseDir, candidate)); os.IsNotExist(err) {
				mediaDir = candidate
				fullDir = filepath.Join(s.baseDir, mediaDir)
				break
			}
		}
	}

	// Write media files
	var mediaPaths []string
	if len(input.Media) > 0 {
		if err := os.MkdirAll(fullDir, 0755); err != nil {
			return nil, fmt.Errorf("create media dir: %w", err)
		}

		for _, m := range input.Media {
			data, err := base64.StdEncoding.DecodeString(m.Content)
			if err != nil {
				return nil, fmt.Errorf("decode media %s: %w", m.Filename, err)
			}
			filePath := filepath.Join(fullDir, m.Filename)
			if err := os.WriteFile(filePath, data, 0644); err != nil {
				return nil, fmt.Errorf("write media %s: %w", m.Filename, err)
			}
			mediaPaths = append(mediaPaths, filepath.Join("explore", mediaDir, m.Filename))
		}
	}

	var contentPtr *string
	if input.Content != "" {
		contentPtr = &input.Content
	}
	var mediaTypePtr *string
	if input.MediaType != "" {
		mediaTypePtr = &input.MediaType
	}
	var mediaDirPtr *string
	if mediaDir != "" {
		mediaDirPtr = &mediaDir
	}

	post := &db.ExplorePost{
		ID:         id,
		Author:     input.Author,
		Title:      input.Title,
		Content:    contentPtr,
		MediaType:  mediaTypePtr,
		MediaPaths: mediaPaths,
		MediaDir:   mediaDirPtr,
		Tags:       input.Tags,
		CreatedAt:  now,
	}

	if err := db.InsertExplorePost(post); err != nil {
		// Clean up media dir on failure
		if len(input.Media) > 0 {
			os.RemoveAll(fullDir)
		}
		return nil, fmt.Errorf("insert post: %w", err)
	}

	log.Info().Str("id", id).Str("author", input.Author).Str("title", input.Title).Msg("explore post created")
	return post, nil
}

func (s *Service) DeletePost(id string) error {
	post, err := db.GetExplorePost(id)
	if err != nil {
		return err
	}
	if post == nil {
		return fmt.Errorf("post not found: %s", id)
	}

	// Delete from DB (cascade deletes comments)
	if err := db.DeleteExplorePost(id); err != nil {
		return err
	}

	// Remove media dir
	if post.MediaDir != nil && *post.MediaDir != "" {
		fullDir := filepath.Join(s.baseDir, *post.MediaDir)
		os.RemoveAll(fullDir)
	}

	log.Info().Str("id", id).Msg("explore post deleted")
	return nil
}

func (s *Service) AddComment(postID, author, content string) (*db.ExploreComment, error) {
	post, err := db.GetExplorePost(postID)
	if err != nil {
		return nil, err
	}
	if post == nil {
		return nil, fmt.Errorf("post not found: %s", postID)
	}

	comment := &db.ExploreComment{
		ID:        ulid.Make().String(),
		PostID:    postID,
		Author:    author,
		Content:   content,
		CreatedAt: time.Now().UnixMilli(),
	}

	if err := db.InsertExploreComment(comment); err != nil {
		return nil, err
	}
	return comment, nil
}

func (s *Service) AddTags(postID string, newTags []string) error {
	post, err := db.GetExplorePost(postID)
	if err != nil {
		return err
	}
	if post == nil {
		return fmt.Errorf("post not found: %s", postID)
	}

	// Merge tags, skip dupes
	existing := make(map[string]bool)
	for _, t := range post.Tags {
		existing[strings.ToLower(t)] = true
	}
	merged := append([]string{}, post.Tags...)
	for _, t := range newTags {
		lower := strings.ToLower(strings.TrimSpace(t))
		if lower != "" && !existing[lower] {
			merged = append(merged, lower)
			existing[lower] = true
		}
	}

	return db.UpdateExplorePostTags(postID, merged)
}
```

**Step 2: Check if `oklog/ulid` is already a dependency**

Run: `cd backend && grep ulid go.mod`
If not found: `go get github.com/oklog/ulid/v2`

**Step 3: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add backend/explore/
git commit -m "feat: add explore service with post creation, deletion, comments, and tags"
```

---

### Task 4: REST API Handlers

**Files:**
- Create: `backend/api/explore.go`
- Modify: `backend/api/routes.go` (add explore routes)
- Modify: `backend/server/server.go` (add explore service + accessor)

**Step 1: Add explore service to Server**

In `backend/server/server.go`, add to Server struct:
```go
explore     *explore.Service
```

In `New()`, after agent apps initialization:
```go
s.explore = explore.NewService(cfg.UserDataDir)
```

Add accessor:
```go
func (s *Server) Explore() *explore.Service { return s.explore }
```

**Step 2: Write REST handlers**

```go
package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// GET /api/explore/posts
func (h *Handlers) GetExplorePosts(c *gin.Context) {
	limitStr := c.Query("limit")
	before := c.Query("before")
	after := c.Query("after")

	limit := 30
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	var result *db.ExplorePostListResult
	var err error

	if before != "" {
		ts, id, ok := db.ParseExploreCursor(before)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid before cursor"})
			return
		}
		result, err = db.ListExplorePostsBefore(ts, id, limit)
	} else if after != "" {
		ts, id, ok := db.ParseExploreCursor(after)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid after cursor"})
			return
		}
		result, err = db.ListExplorePostsAfter(ts, id, limit)
	} else {
		result, err = db.ListExplorePostsNewest(limit)
	}

	if err != nil {
		log.Error().Err(err).Msg("list explore posts failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list posts"})
		return
	}

	type Response struct {
		Items   []db.ExplorePost `json:"items"`
		Cursors struct {
			First *string `json:"first"`
			Last  *string `json:"last"`
		} `json:"cursors"`
		HasMore struct {
			Older bool `json:"older"`
			Newer bool `json:"newer"`
		} `json:"hasMore"`
	}

	resp := Response{}
	resp.Items = result.Items
	if resp.Items == nil {
		resp.Items = []db.ExplorePost{}
	}
	resp.HasMore.Older = result.HasMore.Older
	resp.HasMore.Newer = result.HasMore.Newer

	if len(result.Items) > 0 {
		first := db.CreateExploreCursor(&result.Items[0])
		last := db.CreateExploreCursor(&result.Items[len(result.Items)-1])
		resp.Cursors.First = &first
		resp.Cursors.Last = &last
	}

	c.JSON(http.StatusOK, resp)
}

// GET /api/explore/posts/:id
func (h *Handlers) GetExplorePost(c *gin.Context) {
	id := c.Param("id")

	post, err := db.GetExplorePost(id)
	if err != nil {
		log.Error().Err(err).Msg("get explore post failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get post"})
		return
	}
	if post == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Post not found"})
		return
	}

	comments, err := db.ListExploreComments(id)
	if err != nil {
		log.Error().Err(err).Msg("list explore comments failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list comments"})
		return
	}
	if comments == nil {
		comments = []db.ExploreComment{}
	}

	c.JSON(http.StatusOK, db.ExplorePostWithComments{
		ExplorePost: *post,
		Comments:    comments,
	})
}

// GET /api/explore/posts/:id/comments
func (h *Handlers) GetExploreComments(c *gin.Context) {
	postID := c.Param("id")

	comments, err := db.ListExploreComments(postID)
	if err != nil {
		log.Error().Err(err).Msg("list explore comments failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list comments"})
		return
	}
	if comments == nil {
		comments = []db.ExploreComment{}
	}

	c.JSON(http.StatusOK, gin.H{"comments": comments})
}

// DELETE /api/explore/posts/:id
func (h *Handlers) DeleteExplorePost(c *gin.Context) {
	id := c.Param("id")

	if err := h.server.Explore().DeletePost(id); err != nil {
		log.Error().Err(err).Msg("delete explore post failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete post"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
```

**Step 3: Register routes in `routes.go`**

Add to the protected `api` group (after agent-apps routes):

```go
// Explore routes
api.GET("/explore/posts", h.GetExplorePosts)
api.GET("/explore/posts/:id", h.GetExplorePost)
api.GET("/explore/posts/:id/comments", h.GetExploreComments)
api.DELETE("/explore/posts/:id", h.DeleteExplorePost)
```

**Step 4: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add backend/api/explore.go backend/api/routes.go backend/server/server.go
git commit -m "feat: add explore REST API endpoints with cursor-based pagination"
```

---

### Task 5: MCP Server (Streamable HTTP)

**Files:**
- Create: `backend/explore/mcp.go`
- Modify: `backend/api/routes.go` (register MCP endpoint)

**Step 1: Write the MCP server**

This implements MCP over streamable HTTP (SSE for server→client, POST for client→server) at `/api/explore/mcp`.

```go
package explore

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// --- JSON-RPC types ---

type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// MCPHandler handles MCP requests over HTTP.
type MCPHandler struct {
	service *Service
}

func NewMCPHandler(service *Service) *MCPHandler {
	return &MCPHandler{service: service}
}

// HandleMCP is the Gin handler for POST /api/explore/mcp
func (m *MCPHandler) HandleMCP(c *gin.Context) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read body"})
		return
	}

	var req jsonrpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON-RPC request"})
		return
	}

	resp := m.handleRequest(req)
	if resp == nil {
		c.Status(http.StatusAccepted)
		return
	}

	c.JSON(http.StatusOK, resp)
}

func (m *MCPHandler) handleRequest(req jsonrpcRequest) *jsonrpcResponse {
	switch req.Method {
	case "initialize":
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities":   map[string]any{"tools": map[string]any{}},
				"serverInfo": map[string]any{
					"name":    "mylifedb-explore",
					"version": "1.0.0",
				},
			},
		}
	case "notifications/initialized":
		return nil
	case "tools/list":
		return m.handleToolsList(req)
	case "tools/call":
		return m.handleToolsCall(req)
	case "ping":
		return &jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}}
	default:
		if req.ID == nil {
			return nil
		}
		return &jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32601, Message: "method not found: " + req.Method},
		}
	}
}

func (m *MCPHandler) handleToolsList(req jsonrpcRequest) *jsonrpcResponse {
	tools := []map[string]any{
		{
			"name":        "createPost",
			"description": "Create a new post in the Explore feed with optional media (images or video) and tags.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"author", "title"},
				"properties": map[string]any{
					"author":    map[string]any{"type": "string", "description": "Author name for this post"},
					"title":     map[string]any{"type": "string", "description": "Post title"},
					"content":   map[string]any{"type": "string", "description": "Post body text (markdown)"},
					"mediaType": map[string]any{"type": "string", "enum": []string{"image", "video"}, "description": "Type of media attached"},
					"media": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type":     "object",
							"required": []string{"filename", "content"},
							"properties": map[string]any{
								"filename": map[string]any{"type": "string"},
								"content":  map[string]any{"type": "string", "description": "Base64-encoded file content"},
							},
						},
						"description": "Media files to attach (multiple images or single video)",
					},
					"tags": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Tags for the post"},
				},
			},
		},
		{
			"name":        "deletePost",
			"description": "Delete a post and its media from the Explore feed.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"post_id"},
				"properties": map[string]any{
					"post_id": map[string]any{"type": "string", "description": "ID of the post to delete"},
				},
			},
		},
		{
			"name":        "listPosts",
			"description": "List posts in the Explore feed with cursor-based pagination.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"cursor": map[string]any{"type": "string", "description": "Pagination cursor (from previous response)"},
					"limit":  map[string]any{"type": "integer", "description": "Number of posts to return (default 30, max 100)"},
				},
			},
		},
		{
			"name":        "addComment",
			"description": "Add a comment to an existing post.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"post_id", "author", "content"},
				"properties": map[string]any{
					"post_id": map[string]any{"type": "string", "description": "ID of the post to comment on"},
					"author":  map[string]any{"type": "string", "description": "Comment author name"},
					"content": map[string]any{"type": "string", "description": "Comment text"},
				},
			},
		},
		{
			"name":        "addTags",
			"description": "Add tags to an existing post (idempotent, skips duplicates).",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"post_id", "tags"},
				"properties": map[string]any{
					"post_id": map[string]any{"type": "string", "description": "ID of the post"},
					"tags":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Tags to add"},
				},
			},
		},
	}

	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  map[string]any{"tools": tools},
	}
}

func (m *MCPHandler) handleToolsCall(req jsonrpcRequest) *jsonrpcResponse {
	var params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return &jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32602, Message: "invalid params"}}
	}

	switch params.Name {
	case "createPost":
		return m.callCreatePost(req.ID, params.Arguments)
	case "deletePost":
		return m.callDeletePost(req.ID, params.Arguments)
	case "listPosts":
		return m.callListPosts(req.ID, params.Arguments)
	case "addComment":
		return m.callAddComment(req.ID, params.Arguments)
	case "addTags":
		return m.callAddTags(req.ID, params.Arguments)
	default:
		return &jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32602, Message: "unknown tool: " + params.Name}}
	}
}

func (m *MCPHandler) callCreatePost(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	author, _ := args["author"].(string)
	title, _ := args["title"].(string)
	content, _ := args["content"].(string)
	mediaType, _ := args["mediaType"].(string)

	if author == "" || title == "" {
		return m.toolError(id, "author and title are required")
	}

	var media []MediaInput
	if mediaArr, ok := args["media"].([]any); ok {
		for _, item := range mediaArr {
			if obj, ok := item.(map[string]any); ok {
				filename, _ := obj["filename"].(string)
				contentB64, _ := obj["content"].(string)
				if filename != "" && contentB64 != "" {
					media = append(media, MediaInput{Filename: filename, Content: contentB64})
				}
			}
		}
	}

	var tags []string
	if tagArr, ok := args["tags"].([]any); ok {
		for _, t := range tagArr {
			if s, ok := t.(string); ok && strings.TrimSpace(s) != "" {
				tags = append(tags, strings.ToLower(strings.TrimSpace(s)))
			}
		}
	}

	post, err := m.service.CreatePost(CreatePostInput{
		Author:    author,
		Title:     title,
		Content:   content,
		MediaType: mediaType,
		Media:     media,
		Tags:      tags,
	})
	if err != nil {
		log.Error().Err(err).Msg("MCP createPost failed")
		return m.toolError(id, err.Error())
	}

	data, _ := json.Marshal(post)
	return m.toolResult(id, fmt.Sprintf("Post created successfully.\n%s", string(data)))
}

func (m *MCPHandler) callDeletePost(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	postID, _ := args["post_id"].(string)
	if postID == "" {
		return m.toolError(id, "post_id is required")
	}

	if err := m.service.DeletePost(postID); err != nil {
		return m.toolError(id, err.Error())
	}
	return m.toolResult(id, fmt.Sprintf("Post %s deleted.", postID))
}

func (m *MCPHandler) callListPosts(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	limit := 30
	if l, ok := args["limit"].(float64); ok && l > 0 && l <= 100 {
		limit = int(l)
	}

	var result *db.ExplorePostListResult
	var err error

	cursor, _ := args["cursor"].(string)
	if cursor != "" {
		ts, cid, ok := db.ParseExploreCursor(cursor)
		if !ok {
			return m.toolError(id, "invalid cursor format")
		}
		result, err = db.ListExplorePostsBefore(ts, cid, limit)
	} else {
		result, err = db.ListExplorePostsNewest(limit)
	}

	if err != nil {
		return m.toolError(id, err.Error())
	}

	data, _ := json.Marshal(result)
	return m.toolResult(id, string(data))
}

func (m *MCPHandler) callAddComment(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	postID, _ := args["post_id"].(string)
	author, _ := args["author"].(string)
	content, _ := args["content"].(string)

	if postID == "" || author == "" || content == "" {
		return m.toolError(id, "post_id, author, and content are required")
	}

	comment, err := m.service.AddComment(postID, author, content)
	if err != nil {
		return m.toolError(id, err.Error())
	}

	data, _ := json.Marshal(comment)
	return m.toolResult(id, fmt.Sprintf("Comment added.\n%s", string(data)))
}

func (m *MCPHandler) callAddTags(id json.RawMessage, args map[string]any) *jsonrpcResponse {
	postID, _ := args["post_id"].(string)
	if postID == "" {
		return m.toolError(id, "post_id is required")
	}

	var tags []string
	if tagArr, ok := args["tags"].([]any); ok {
		for _, t := range tagArr {
			if s, ok := t.(string); ok {
				tags = append(tags, s)
			}
		}
	}
	if len(tags) == 0 {
		return m.toolError(id, "tags array is required and must not be empty")
	}

	if err := m.service.AddTags(postID, tags); err != nil {
		return m.toolError(id, err.Error())
	}
	return m.toolResult(id, fmt.Sprintf("Tags added to post %s.", postID))
}

// --- helpers ---

func (m *MCPHandler) toolResult(id json.RawMessage, text string) *jsonrpcResponse {
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]any{
			"content": []map[string]any{{"type": "text", "text": text}},
		},
	}
}

func (m *MCPHandler) toolError(id json.RawMessage, msg string) *jsonrpcResponse {
	return &jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]any{
			"content": []map[string]any{{"type": "text", "text": "Error: " + msg}},
			"isError": true,
		},
	}
}
```

**Step 2: Register MCP endpoint in routes.go**

Add after explore REST routes:

```go
// Explore MCP endpoint
exploreHandler := explore.NewMCPHandler(h.server.Explore())
api.POST("/explore/mcp", gin.WrapF(exploreHandler.HandleMCP))
```

Wait — this needs to be a `gin.HandlerFunc`, not `gin.WrapF`. Use the Gin handler directly:

```go
exploreHandler := explore.NewMCPHandler(h.server.Explore())
api.POST("/explore/mcp", exploreHandler.HandleMCP)
```

**Step 3: Add import for `explore` package in `routes.go`**

```go
import (
	"github.com/gin-gonic/gin"
	"github.com/xiaoyuanzhu-com/my-life-db/explore"
)
```

**Step 4: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add backend/explore/mcp.go backend/api/routes.go
git commit -m "feat: add explore MCP server with streamable HTTP transport"
```

---

### Task 6: MCP Config Update

**Files:**
- Modify: `backend/agentapps/mcpconfig.go`

**Step 1: Add explore MCP to `.mcp.json` output**

In `WriteMCPConfig()`, add the explore server entry. Since this is HTTP-based (not stdio), the config format differs. Check the MCP spec for how HTTP-based servers are configured in `.mcp.json`:

```go
existing.McpServers["explore"] = MCPServerEntry{
	Type: "streamable-http",
	URL:  fmt.Sprintf("http://localhost:%d/api/explore/mcp", port),
}
```

This requires `MCPServerEntry` to support a `URL` field. Update the struct:

```go
type MCPServerEntry struct {
	Type    string   `json:"type"`
	Command string   `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	URL     string   `json:"url,omitempty"`
}
```

And update `WriteMCPConfig` signature to accept port:

```go
func WriteMCPConfig(dir, binaryPath, userDataDir string, port int) error {
```

Update the caller in `server.go` to pass the port.

**Step 2: Verify it compiles**

Run: `cd backend && go build ./...`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add backend/agentapps/mcpconfig.go backend/server/server.go
git commit -m "feat: add explore MCP server to .mcp.json config"
```

---

### Task 7: Frontend — Add Explore Route and Navigation

**Files:**
- Create: `frontend/app/routes/explore.tsx`
- Modify: `frontend/app/spa-routes.tsx`
- Modify: `frontend/app/components/header.tsx`
- Modify: `frontend/app/components/bottom-nav.tsx`

**Step 1: Create the Explore route page (placeholder)**

```tsx
import { useAuth } from "~/contexts/auth-context";

function ExploreContent() {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto md:px-[10%] p-4">
        <p className="text-muted-foreground">Explore feed coming soon...</p>
      </div>
    </div>
  );
}

export default function ExplorePage() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return null;
  return <ExploreContent />;
}
```

**Step 2: Add route in `spa-routes.tsx`**

Add import:
```tsx
import Explore from "./routes/explore";
```

Add route after `file/*`:
```tsx
{
  path: "explore",
  Component: Explore,
},
```

**Step 3: Update header.tsx**

Change import to include `Compass`:
```tsx
import { Database, Terminal, User, Compass } from 'lucide-react';
```

Update `navLinks`:
```tsx
const navLinks = [
  { href: '/', label: 'Data', icon: Database },
  { href: '/explore', label: 'Explore', icon: Compass },
  { href: '/agent', label: 'Agent', icon: Terminal },
  { href: '/me', label: 'Me', icon: User },
];
```

**Step 4: Update bottom-nav.tsx**

Change import to include `Compass`:
```tsx
import { Database, Bot, User, Compass } from 'lucide-react';
```

Update `navItems`:
```tsx
const navItems = [
  { href: '/', label: 'Data', icon: Database },
  { href: '/explore', label: 'Explore', icon: Compass },
  { href: '/agent', label: 'Agent', icon: Bot },
  { href: '/me', label: 'Me', icon: User },
];
```

**Step 5: Verify frontend builds**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: Build succeeds, Explore tab visible in nav.

**Step 6: Commit**

```bash
git add frontend/app/routes/explore.tsx frontend/app/spa-routes.tsx frontend/app/components/header.tsx frontend/app/components/bottom-nav.tsx
git commit -m "feat: add Explore tab to navigation with placeholder page"
```

---

### Task 8: Frontend — Explore Feed Types and API

**Files:**
- Create: `frontend/app/types/explore.ts`
- Create: `frontend/app/hooks/use-explore.ts`

**Step 1: Define types**

```tsx
export interface ExplorePost {
  id: string;
  author: string;
  title: string;
  content?: string;
  mediaType?: "image" | "video";
  mediaPaths?: string[];
  mediaDir?: string;
  tags?: string[];
  createdAt: number;
}

export interface ExploreComment {
  id: string;
  postId: string;
  author: string;
  content: string;
  createdAt: number;
}

export interface ExplorePostWithComments extends ExplorePost {
  comments: ExploreComment[];
}

export interface ExplorePostsResponse {
  items: ExplorePost[];
  cursors: {
    first: string | null;
    last: string | null;
  };
  hasMore: {
    older: boolean;
    newer: boolean;
  };
}
```

**Step 2: Create API hooks**

```tsx
import { api } from "~/lib/api";
import type { ExplorePostsResponse, ExplorePostWithComments } from "~/types/explore";

export async function fetchExplorePosts(params?: {
  before?: string;
  after?: string;
  limit?: number;
}): Promise<ExplorePostsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.before) searchParams.set("before", params.before);
  if (params?.after) searchParams.set("after", params.after);
  if (params?.limit) searchParams.set("limit", String(params.limit));

  const url = `/api/explore/posts${searchParams.toString() ? "?" + searchParams.toString() : ""}`;
  const response = await api.get(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchExplorePost(id: string): Promise<ExplorePostWithComments> {
  const response = await api.get(`/api/explore/posts/${id}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function deleteExplorePost(id: string): Promise<void> {
  const response = await api.delete(`/api/explore/posts/${id}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
```

**Step 3: Verify frontend builds**

Run: `cd frontend && npm run typecheck`
Expected: No type errors.

**Step 4: Commit**

```bash
git add frontend/app/types/explore.ts frontend/app/hooks/use-explore.ts
git commit -m "feat: add explore types and API hooks"
```

---

### Task 9: Frontend — Masonry Feed Component

**Files:**
- Create: `frontend/app/components/explore/explore-feed.tsx`
- Create: `frontend/app/components/explore/post-card.tsx`
- Modify: `frontend/app/routes/explore.tsx` (wire up feed)

**Step 1: Create PostCard component**

```tsx
import type { ExplorePost } from "~/types/explore";

interface PostCardProps {
  post: ExplorePost;
  onClick: () => void;
}

export function PostCard({ post, onClick }: PostCardProps) {
  const coverImage = post.mediaPaths?.[0];
  const hasMultipleImages = (post.mediaPaths?.length ?? 0) > 1;

  return (
    <div
      className="break-inside-avoid mb-3 cursor-pointer group"
      onClick={onClick}
    >
      <div className="bg-card rounded-xl overflow-hidden border border-border/50 hover:border-border transition-colors">
        {/* Cover media */}
        {coverImage && (
          <div className="relative">
            <img
              src={`/raw/${coverImage}`}
              alt={post.title}
              className="w-full object-cover"
              loading="lazy"
            />
            {hasMultipleImages && (
              <div className="absolute top-2 right-2 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
                {post.mediaPaths!.length}
              </div>
            )}
            {post.mediaType === "video" && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center">
                  <div className="w-0 h-0 border-l-[16px] border-l-white border-y-[10px] border-y-transparent ml-1" />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Content */}
        <div className="p-3">
          <h3 className="font-semibold text-sm line-clamp-2">{post.title}</h3>
          {post.content && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{post.content}</p>
          )}

          {/* Tags */}
          {post.tags && post.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {post.tags.map((tag) => (
                <span key={tag} className="text-xs bg-muted px-1.5 py-0.5 rounded-full text-muted-foreground">
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Author + date */}
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs font-medium text-foreground/80">{post.author}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(post.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Create ExploreFeed component**

```tsx
import { useState, useEffect, useCallback, useRef } from "react";
import { fetchExplorePosts } from "~/hooks/use-explore";
import { PostCard } from "./post-card";
import type { ExplorePost, ExplorePostsResponse } from "~/types/explore";

const BATCH_SIZE = 30;
const SCROLL_THRESHOLD = 1000;

interface ExploreFeedProps {
  onPostClick: (post: ExplorePost) => void;
}

export function ExploreFeed({ onPostClick }: ExploreFeedProps) {
  const [posts, setPosts] = useState<ExplorePost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [lastCursor, setLastCursor] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchExplorePosts({ limit: BATCH_SIZE });
        if (cancelled) return;
        setPosts(data.items);
        setHasMoreOlder(data.hasMore.older);
        setLastCursor(data.cursors.last);
      } catch (err) {
        console.error("Failed to load explore posts:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Scroll-driven load more
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreOlder || !lastCursor) return;
    setLoadingMore(true);
    try {
      const data = await fetchExplorePosts({ before: lastCursor, limit: BATCH_SIZE });
      setPosts((prev) => [...prev, ...data.items]);
      setHasMoreOlder(data.hasMore.older);
      setLastCursor(data.cursors.last);
    } catch (err) {
      console.error("Failed to load more posts:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMoreOlder, lastCursor]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < SCROLL_THRESHOLD) {
        loadMore();
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [loadMore]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-2">
        <p className="text-muted-foreground text-sm">No posts yet.</p>
        <p className="text-muted-foreground text-xs">Posts will appear here when agents publish them via MCP.</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="p-4 md:px-[10%]">
        <div className="columns-2 md:columns-3 lg:columns-4 gap-3">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} onClick={() => onPostClick(post)} />
          ))}
        </div>

        {loadingMore && (
          <div className="flex justify-center py-4">
            <div className="text-muted-foreground text-sm">Loading more...</div>
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 3: Wire up in explore.tsx**

```tsx
import { useState } from "react";
import { useAuth } from "~/contexts/auth-context";
import { ExploreFeed } from "~/components/explore/explore-feed";
import type { ExplorePost } from "~/types/explore";

function ExploreContent() {
  const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(null);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ExploreFeed onPostClick={setSelectedPost} />
      {/* Post detail modal will be added in next task */}
    </div>
  );
}

export default function ExplorePage() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  if (!isAuthenticated) return null;
  return <ExploreContent />;
}
```

**Step 4: Verify frontend builds**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add frontend/app/components/explore/ frontend/app/routes/explore.tsx
git commit -m "feat: add masonry explore feed with post cards and infinite scroll"
```

---

### Task 10: Frontend — Post Detail Modal

**Files:**
- Create: `frontend/app/components/explore/post-detail.tsx`
- Modify: `frontend/app/routes/explore.tsx` (add modal)

**Step 1: Create PostDetail component**

```tsx
import { useState, useEffect } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { fetchExplorePost } from "~/hooks/use-explore";
import type { ExplorePostWithComments } from "~/types/explore";

interface PostDetailProps {
  postId: string;
  onClose: () => void;
}

export function PostDetail({ postId, onClose }: PostDetailProps) {
  const [post, setPost] = useState<ExplorePostWithComments | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchExplorePost(postId);
        if (!cancelled) setPost(data);
      } catch (err) {
        console.error("Failed to load post:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [postId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (loading || !post) {
    return (
      <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center" onClick={onClose}>
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const mediaPaths = post.mediaPaths ?? [];
  const hasMultipleImages = post.mediaType === "image" && mediaPaths.length > 1;

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card rounded-xl border max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <div className="flex justify-end p-3 pb-0">
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Media */}
        {mediaPaths.length > 0 && (
          <div className="relative">
            {post.mediaType === "video" ? (
              <video src={`/raw/${mediaPaths[0]}`} controls className="w-full" />
            ) : (
              <>
                <img
                  src={`/raw/${mediaPaths[currentImageIndex]}`}
                  alt={post.title}
                  className="w-full object-contain max-h-[60vh]"
                />
                {hasMultipleImages && (
                  <>
                    <button
                      onClick={() => setCurrentImageIndex((i) => Math.max(0, i - 1))}
                      className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 text-white rounded-full p-1 disabled:opacity-30"
                      disabled={currentImageIndex === 0}
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      onClick={() => setCurrentImageIndex((i) => Math.min(mediaPaths.length - 1, i + 1))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 text-white rounded-full p-1 disabled:opacity-30"
                      disabled={currentImageIndex === mediaPaths.length - 1}
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                      {mediaPaths.map((_, i) => (
                        <div
                          key={i}
                          className={`w-1.5 h-1.5 rounded-full ${i === currentImageIndex ? "bg-white" : "bg-white/50"}`}
                        />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Content */}
        <div className="p-4">
          <h2 className="text-lg font-semibold">{post.title}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm font-medium text-foreground/80">{post.author}</span>
            <span className="text-sm text-muted-foreground">
              {new Date(post.createdAt).toLocaleDateString()}
            </span>
          </div>

          {post.content && (
            <p className="mt-3 text-sm whitespace-pre-wrap">{post.content}</p>
          )}

          {post.tags && post.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {post.tags.map((tag) => (
                <span key={tag} className="text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground">
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Comments */}
          {post.comments.length > 0 && (
            <div className="mt-4 border-t pt-4">
              <h3 className="text-sm font-semibold mb-2">Comments ({post.comments.length})</h3>
              <div className="space-y-3">
                {post.comments.map((comment) => (
                  <div key={comment.id}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{comment.author}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(comment.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-sm mt-0.5">{comment.content}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Wire modal into explore.tsx**

Update `ExploreContent`:

```tsx
import { PostDetail } from "~/components/explore/post-detail";

function ExploreContent() {
  const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(null);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <ExploreFeed onPostClick={setSelectedPost} />
      {selectedPost && (
        <PostDetail
          postId={selectedPost.id}
          onClose={() => setSelectedPost(null)}
        />
      )}
    </div>
  );
}
```

**Step 3: Verify frontend builds**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add frontend/app/components/explore/post-detail.tsx frontend/app/routes/explore.tsx
git commit -m "feat: add post detail modal with image carousel and comments"
```

---

### Task 11: End-to-End Test

**Step 1: Start backend with fresh database**

Run: `cd backend && rm -rf .my-life-db/ && go run .`
Expected: Server starts, migration 019 runs.

**Step 2: Test MCP endpoint**

```bash
# Initialize
curl -s -X POST http://localhost:12345/api/explore/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | jq

# List tools
curl -s -X POST http://localhost:12345/api/explore/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq

# Create a text-only post
curl -s -X POST http://localhost:12345/api/explore/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"createPost","arguments":{"author":"Test Agent","title":"Hello World","content":"My first post!","tags":["test","hello"]}}}' | jq

# List posts
curl -s -X POST http://localhost:12345/api/explore/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"listPosts","arguments":{}}}' | jq
```

Expected: All responses return valid JSON-RPC with correct data.

**Step 3: Test REST API**

```bash
curl -s http://localhost:12345/api/explore/posts | jq
```

Expected: Returns the post created via MCP.

**Step 4: Test frontend**

Open `http://localhost:12345` in browser, click Explore tab.
Expected: Feed shows the test post. Clicking it opens the detail modal.

**Step 5: Commit any fixes discovered during testing**

---

### Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Database migration | `backend/db/migration_019_explore_tables.go` |
| 2 | Models + queries | `backend/db/explore.go` |
| 3 | Service layer | `backend/explore/service.go` |
| 4 | REST handlers | `backend/api/explore.go`, `routes.go`, `server.go` |
| 5 | MCP server | `backend/explore/mcp.go`, `routes.go` |
| 6 | MCP config | `backend/agentapps/mcpconfig.go` |
| 7 | Frontend route + nav | `spa-routes.tsx`, `header.tsx`, `bottom-nav.tsx`, `explore.tsx` |
| 8 | Frontend types + API | `types/explore.ts`, `hooks/use-explore.ts` |
| 9 | Masonry feed | `explore-feed.tsx`, `post-card.tsx` |
| 10 | Post detail modal | `post-detail.tsx` |
| 11 | End-to-end test | Manual verification |
