package appclient

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/agent"
	"github.com/xiaoyuanzhu-com/my-life-db/config"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/fs"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// LocalAppClient implements AppClient using direct service calls
type LocalAppClient struct {
	database  *sql.DB
	fsService *fs.Service
}

// NewLocalClient creates a new LocalAppClient
func NewLocalClient(database *sql.DB, fsService *fs.Service) *LocalAppClient {
	return &LocalAppClient{
		database:  database,
		fsService: fsService,
	}
}

// ──────────────────────────────────────────────────────────────
// SEARCH & RETRIEVAL
// ──────────────────────────────────────────────────────────────

// Search for files using keyword search (simplified - no semantic search yet)
func (c *LocalAppClient) Search(ctx context.Context, req SearchRequest) (*SearchResult, error) {
	// Build SQL query with filters
	query := `
		SELECT path, name, mime_type, created_at
		FROM files
		WHERE 1=1
	`
	var args []interface{}

	// Add text search if query provided
	if req.Query != "" {
		query += ` AND (name LIKE ? OR text_preview LIKE ?)`
		pattern := "%" + req.Query + "%"
		args = append(args, pattern, pattern)
	}

	// Add mime type filter
	if req.Type != "" {
		query += ` AND mime_type LIKE ?`
		args = append(args, req.Type+"%")
	}

	// Add folder filter
	if req.Folder != "" {
		query += ` AND path LIKE ?`
		args = append(args, req.Folder+"/%")
	}

	query += ` ORDER BY created_at DESC`

	// Add limit
	limit := req.Limit
	if limit == 0 {
		limit = 10
	}
	query += fmt.Sprintf(` LIMIT %d`, limit)

	// Execute query
	rows, err := c.database.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []SearchResultItem
	for rows.Next() {
		var item SearchResultItem
		var createdAt string
		err := rows.Scan(&item.Path, &item.Name, &item.MimeType, &createdAt)
		if err != nil {
			continue
		}
		item.Score = 1.0 // Default score for simple search
		results = append(results, item)
	}

	return &SearchResult{
		Results: results,
		Total:   len(results),
	}, nil
}

// GetFile returns file metadata with digests
func (c *LocalAppClient) GetFile(ctx context.Context, path string) (*FileWithDigests, error) {
	// Get file record
	query := `SELECT path, name, mime_type, size, created_at FROM files WHERE path = ?`
	row := c.database.QueryRow(query, path)

	var file FileWithDigests
	var createdAtStr string
	err := row.Scan(&file.Path, &file.Name, &file.MimeType, &file.Size, &createdAtStr)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("file not found: %s", path)
	}
	if err != nil {
		return nil, err
	}

	file.CreatedAt, _ = time.Parse(time.RFC3339, createdAtStr)

	// Get digests
	digestQuery := `SELECT digester, status, content, error FROM digests WHERE file_path = ?`
	rows, err := c.database.Query(digestQuery, path)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	file.Digests = make(map[string]DigestContent)
	for rows.Next() {
		var digester, status string
		var content, errorMsg sql.NullString

		err := rows.Scan(&digester, &status, &content, &errorMsg)
		if err != nil {
			continue
		}

		digest := DigestContent{
			Status: status,
		}
		if content.Valid {
			digest.Content = content.String
		}
		if errorMsg.Valid {
			digest.Error = errorMsg.String
		}

		file.Digests[digester] = digest
	}

	return &file, nil
}

// ListRecentFiles returns recently added files
func (c *LocalAppClient) ListRecentFiles(ctx context.Context, limit int, mimeTypePrefix string) ([]FileSummary, error) {
	if limit == 0 {
		limit = 10
	}

	query := `
		SELECT path, name, mime_type, size, created_at
		FROM files
		WHERE is_folder = 0
	`
	var args []interface{}

	if mimeTypePrefix != "" {
		query += ` AND mime_type LIKE ?`
		args = append(args, mimeTypePrefix+"%")
	}

	query += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)

	rows, err := c.database.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []FileSummary
	for rows.Next() {
		var f FileSummary
		var createdAtStr string
		err := rows.Scan(&f.Path, &f.Name, &f.MimeType, &f.Size, &createdAtStr)
		if err != nil {
			continue
		}
		f.CreatedAt, _ = time.Parse(time.RFC3339, createdAtStr)
		files = append(files, f)
	}

	return files, nil
}

// ──────────────────────────────────────────────────────────────
// ORGANIZATION
// ──────────────────────────────────────────────────────────────

// GetFolderTree returns the folder structure
func (c *LocalAppClient) GetFolderTree(ctx context.Context, depth int) (*FolderNode, error) {
	cfg := config.Get()
	if depth == 0 {
		depth = 2
	}

	root := &FolderNode{
		Name:     filepath.Base(cfg.UserDataDir),
		Path:     "",
		IsFolder: true,
		Children: []*FolderNode{},
	}

	pathFilter := fs.NewPathFilter(fs.ExcludeForTree)
	c.buildFolderTree(root, cfg.UserDataDir, "", depth, 1, pathFilter)

	return root, nil
}

func (c *LocalAppClient) buildFolderTree(node *FolderNode, baseDir, relativePath string, maxDepth, currentDepth int, pathFilter *fs.PathFilter) {
	if maxDepth > 0 && currentDepth > maxDepth {
		return
	}

	fullPath := filepath.Join(baseDir, relativePath)
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return
	}

	atRoot := relativePath == ""
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		name := entry.Name()
		if pathFilter.IsExcludedEntry(name, atRoot) {
			continue
		}

		childPath := name
		if relativePath != "" {
			childPath = filepath.Join(relativePath, name)
		}

		child := &FolderNode{
			Name:     name,
			Path:     childPath,
			IsFolder: true,
			Children: []*FolderNode{},
		}

		if currentDepth < maxDepth {
			c.buildFolderTree(child, baseDir, childPath, maxDepth, currentDepth+1, pathFilter)
		}

		node.Children = append(node.Children, child)
	}
}

// ReadGuideline reads the user's organization guideline
func (c *LocalAppClient) ReadGuideline(ctx context.Context) (string, error) {
	cfg := config.Get()
	guidelinePath := filepath.Join(cfg.UserDataDir, "guideline.md")

	content, err := os.ReadFile(guidelinePath)
	if err != nil {
		if os.IsNotExist(err) {
			return "No guideline.md found. The user has not created organization guidelines yet.", nil
		}
		return "", err
	}

	return string(content), nil
}

// MoveFile moves a file
func (c *LocalAppClient) MoveFile(ctx context.Context, from, to string) error {
	return c.fsService.MoveFile(ctx, from, to)
}

// ──────────────────────────────────────────────────────────────
// INTENTIONS & SUGGESTIONS
// ──────────────────────────────────────────────────────────────

// SaveFileIntention creates or updates a file intention
func (c *LocalAppClient) SaveFileIntention(ctx context.Context, intention *agent.FileIntention) error {
	if intention.ID == "" {
		intention.ID = uuid.New().String()
	}

	now := time.Now().UTC()
	if intention.CreatedAt.IsZero() {
		intention.CreatedAt = now
	}
	intention.UpdatedAt = now

	query := `
		INSERT INTO file_intentions (id, file_path, conversation_id, intention_type, intention_details, confidence, suggested_folder, reasoning, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(file_path) DO UPDATE SET
			conversation_id = excluded.conversation_id,
			intention_type = excluded.intention_type,
			intention_details = excluded.intention_details,
			confidence = excluded.confidence,
			suggested_folder = excluded.suggested_folder,
			reasoning = excluded.reasoning,
			updated_at = excluded.updated_at
	`

	_, err := c.database.Exec(query,
		intention.ID,
		intention.FilePath,
		intention.ConversationID,
		intention.IntentionType,
		intention.IntentionDetails,
		intention.Confidence,
		intention.SuggestedFolder,
		intention.Reasoning,
		intention.CreatedAt.Format(time.RFC3339),
		intention.UpdatedAt.Format(time.RFC3339),
	)

	return err
}

// GetFileIntention retrieves a file intention
func (c *LocalAppClient) GetFileIntention(ctx context.Context, filePath string) (*agent.FileIntention, error) {
	query := `
		SELECT id, file_path, conversation_id, intention_type, intention_details, confidence, suggested_folder, reasoning, created_at, updated_at
		FROM file_intentions
		WHERE file_path = ?
	`

	row := c.database.QueryRow(query, filePath)

	var intention agent.FileIntention
	var createdAtStr, updatedAtStr string
	var conversationID, intentionDetails, suggestedFolder, reasoning sql.NullString

	err := row.Scan(
		&intention.ID,
		&intention.FilePath,
		&conversationID,
		&intention.IntentionType,
		&intentionDetails,
		&intention.Confidence,
		&suggestedFolder,
		&reasoning,
		&createdAtStr,
		&updatedAtStr,
	)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if conversationID.Valid {
		intention.ConversationID = conversationID.String
	}
	if intentionDetails.Valid {
		intention.IntentionDetails = intentionDetails.String
	}
	if suggestedFolder.Valid {
		intention.SuggestedFolder = suggestedFolder.String
	}
	if reasoning.Valid {
		intention.Reasoning = reasoning.String
	}

	intention.CreatedAt, _ = time.Parse(time.RFC3339, createdAtStr)
	intention.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAtStr)

	return &intention, nil
}

// CreateSuggestion creates a pending organization suggestion
func (c *LocalAppClient) CreateSuggestion(ctx context.Context, s *agent.Suggestion) (string, error) {
	if s.ID == "" {
		s.ID = uuid.New().String()
	}

	now := time.Now().UTC()
	if s.CreatedAt.IsZero() {
		s.CreatedAt = now
	}

	query := `
		INSERT INTO organization_suggestions (id, conversation_id, file_path, target_folder, reasoning, confidence, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`

	_, err := c.database.Exec(query,
		s.ID,
		s.ConversationID,
		s.FilePath,
		s.TargetFolder,
		s.Reasoning,
		s.Confidence,
		"pending",
		s.CreatedAt.Format(time.RFC3339),
	)

	if err != nil {
		return "", err
	}

	return s.ID, nil
}

// GetPendingSuggestion retrieves a pending suggestion for a conversation
func (c *LocalAppClient) GetPendingSuggestion(ctx context.Context, convID string) (*agent.Suggestion, error) {
	query := `
		SELECT id, conversation_id, file_path, target_folder, reasoning, confidence, status, created_at, resolved_at
		FROM organization_suggestions
		WHERE conversation_id = ? AND status = 'pending'
		ORDER BY created_at DESC
		LIMIT 1
	`

	row := c.database.QueryRow(query, convID)

	var s agent.Suggestion
	var createdAtStr string
	var resolvedAtStr sql.NullString

	err := row.Scan(
		&s.ID,
		&s.ConversationID,
		&s.FilePath,
		&s.TargetFolder,
		&s.Reasoning,
		&s.Confidence,
		&s.Status,
		&createdAtStr,
		&resolvedAtStr,
	)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	s.CreatedAt, _ = time.Parse(time.RFC3339, createdAtStr)
	if resolvedAtStr.Valid {
		t, _ := time.Parse(time.RFC3339, resolvedAtStr.String)
		s.ResolvedAt = &t
	}

	return &s, nil
}

// ResolveSuggestion executes or rejects a suggestion
func (c *LocalAppClient) ResolveSuggestion(ctx context.Context, suggestionID, action string) error {
	// Get the suggestion
	query := `SELECT file_path, target_folder, status FROM organization_suggestions WHERE id = ?`
	row := c.database.QueryRow(query, suggestionID)

	var filePath, targetFolder, status string
	err := row.Scan(&filePath, &targetFolder, &status)
	if err == sql.ErrNoRows {
		return fmt.Errorf("suggestion not found")
	}
	if err != nil {
		return err
	}

	if status != "pending" {
		return fmt.Errorf("suggestion already resolved")
	}

	// Update status
	now := time.Now().UTC()
	updateQuery := `UPDATE organization_suggestions SET status = ?, resolved_at = ? WHERE id = ?`

	if action == "accept" {
		// Move the file
		err = c.MoveFile(ctx, filePath, filepath.Join(targetFolder, filepath.Base(filePath)))
		if err != nil {
			log.Error().Err(err).Str("file", filePath).Str("target", targetFolder).Msg("failed to move file")
			return err
		}

		_, err = c.database.Exec(updateQuery, "accepted", now.Format(time.RFC3339), suggestionID)
	} else {
		_, err = c.database.Exec(updateQuery, "rejected", now.Format(time.RFC3339), suggestionID)
	}

	return err
}

// ──────────────────────────────────────────────────────────────
// CONVERSATION STORAGE (internal helper methods)
// ──────────────────────────────────────────────────────────────

// SaveConversation saves a conversation to the database
func (c *LocalAppClient) SaveConversation(ctx context.Context, conv *agent.Conversation) error {
	query := `
		INSERT INTO agent_conversations (id, created_at, updated_at, status, summary)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			updated_at = excluded.updated_at,
			status = excluded.status,
			summary = excluded.summary
	`

	_, err := c.database.Exec(query,
		conv.ID,
		conv.CreatedAt.Format(time.RFC3339),
		conv.UpdatedAt.Format(time.RFC3339),
		conv.Status,
		conv.Summary,
	)

	return err
}

// SaveMessage saves a message to the database
func (c *LocalAppClient) SaveMessage(ctx context.Context, msg *agent.Message) error {
	// Serialize metadata (tool use, etc.)
	var metadata string
	if len(msg.ToolUse) > 0 || msg.ToolResultID != "" {
		meta := map[string]interface{}{}
		if len(msg.ToolUse) > 0 {
			meta["tool_use"] = msg.ToolUse
		}
		if msg.ToolResultID != "" {
			meta["tool_result_id"] = msg.ToolResultID
		}
		metaBytes, _ := json.Marshal(meta)
		metadata = string(metaBytes)
	}

	query := `
		INSERT INTO agent_messages (id, conversation_id, role, content, metadata, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`

	_, err := c.database.Exec(query,
		msg.ID,
		msg.ConversationID,
		msg.Role,
		msg.Content,
		metadata,
		msg.CreatedAt.Format(time.RFC3339),
	)

	return err
}

// GetConversation retrieves a conversation with messages
func (c *LocalAppClient) GetConversation(ctx context.Context, convID string) (*agent.Conversation, error) {
	// Get conversation
	query := `SELECT id, created_at, updated_at, status, summary FROM agent_conversations WHERE id = ?`
	row := c.database.QueryRow(query, convID)

	var conv agent.Conversation
	var createdAtStr, updatedAtStr string
	var summary sql.NullString

	err := row.Scan(&conv.ID, &createdAtStr, &updatedAtStr, &conv.Status, &summary)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	conv.CreatedAt, _ = time.Parse(time.RFC3339, createdAtStr)
	conv.UpdatedAt, _ = time.Parse(time.RFC3339, updatedAtStr)
	if summary.Valid {
		conv.Summary = summary.String
	}

	// Get messages
	msgQuery := `SELECT id, conversation_id, role, content, metadata, created_at FROM agent_messages WHERE conversation_id = ? ORDER BY created_at ASC`
	rows, err := c.database.Query(msgQuery, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var msg agent.Message
		var createdAtStr string
		var metadata sql.NullString

		err := rows.Scan(&msg.ID, &msg.ConversationID, &msg.Role, &msg.Content, &metadata, &createdAtStr)
		if err != nil {
			continue
		}

		msg.CreatedAt, _ = time.Parse(time.RFC3339, createdAtStr)

		// Deserialize metadata
		if metadata.Valid && metadata.String != "" {
			var meta map[string]interface{}
			json.Unmarshal([]byte(metadata.String), &meta)

			if toolUse, ok := meta["tool_use"]; ok {
				toolBytes, _ := json.Marshal(toolUse)
				json.Unmarshal(toolBytes, &msg.ToolUse)
			}
			if toolResultID, ok := meta["tool_result_id"].(string); ok {
				msg.ToolResultID = toolResultID
			}
		}

		conv.Messages = append(conv.Messages, msg)
	}

	return &conv, nil
}
