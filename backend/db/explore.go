package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// ExplorePost represents a post in the explore feed.
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

// ExploreComment represents a comment on an explore post.
type ExploreComment struct {
	ID        string `json:"id"`
	PostID    string `json:"postId"`
	Author    string `json:"author"`
	Content   string `json:"content"`
	CreatedAt int64  `json:"createdAt"`
}

// ExplorePostWithComments is a post together with its comments.
type ExplorePostWithComments struct {
	ExplorePost
	Comments []ExploreComment `json:"comments"`
}

// ExplorePostListResult is the result of a paginated post list query.
type ExplorePostListResult struct {
	Posts      []ExplorePost `json:"posts"`
	HasOlder   bool          `json:"hasOlder"`
	HasNewer   bool          `json:"hasNewer"`
}

// CreateExploreCursor builds a cursor string from a timestamp and id.
func CreateExploreCursor(epochMs int64, id string) string {
	return fmt.Sprintf("%d:%s", epochMs, id)
}

// ParseExploreCursor extracts the timestamp and id from a cursor string.
func ParseExploreCursor(cursor string) (int64, string, error) {
	parts := strings.SplitN(cursor, ":", 2)
	if len(parts) != 2 {
		return 0, "", fmt.Errorf("invalid cursor format")
	}
	var epochMs int64
	if _, err := fmt.Sscanf(parts[0], "%d", &epochMs); err != nil {
		return 0, "", fmt.Errorf("invalid cursor timestamp: %w", err)
	}
	return epochMs, parts[1], nil
}

// scanExplorePost scans a row into an ExplorePost.
// Column order: id, author, title, content, media_type, media_paths, media_dir, tags, created_at
func scanExplorePost(row interface{ Scan(...any) error }) (ExplorePost, error) {
	var p ExplorePost
	var content, mediaType, mediaDir sql.NullString
	var mediaPathsJSON, tagsJSON sql.NullString

	err := row.Scan(
		&p.ID, &p.Author, &p.Title, &content, &mediaType,
		&mediaPathsJSON, &mediaDir, &tagsJSON, &p.CreatedAt,
	)
	if err != nil {
		return p, err
	}

	p.Content = StringPtr(content)
	p.MediaType = StringPtr(mediaType)
	p.MediaDir = StringPtr(mediaDir)

	if mediaPathsJSON.Valid && mediaPathsJSON.String != "" {
		if err := json.Unmarshal([]byte(mediaPathsJSON.String), &p.MediaPaths); err != nil {
			p.MediaPaths = nil
		}
	}
	if tagsJSON.Valid && tagsJSON.String != "" {
		if err := json.Unmarshal([]byte(tagsJSON.String), &p.Tags); err != nil {
			p.Tags = nil
		}
	}

	return p, nil
}

// InsertExplorePost inserts a new explore post.
func InsertExplorePost(p *ExplorePost) error {
	mediaPathsJSON, _ := json.Marshal(p.MediaPaths)
	tagsJSON, _ := json.Marshal(p.Tags)

	_, err := GetDB().Exec(`
		INSERT INTO explore_posts (id, author, title, content, media_type, media_paths, media_dir, tags, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		p.ID, p.Author, p.Title,
		NullString(p.Content), NullString(p.MediaType),
		string(mediaPathsJSON), NullString(p.MediaDir),
		string(tagsJSON), p.CreatedAt,
	)
	return err
}

// GetExplorePost retrieves a single explore post by ID, with its comments.
func GetExplorePost(id string) (*ExplorePostWithComments, error) {
	row := GetDB().QueryRow(`
		SELECT id, author, title, content, media_type, media_paths, media_dir, tags, created_at
		FROM explore_posts
		WHERE id = ?
	`, id)

	post, err := scanExplorePost(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	comments, err := ListExploreComments(id)
	if err != nil {
		return nil, err
	}

	return &ExplorePostWithComments{
		ExplorePost: post,
		Comments:    comments,
	}, nil
}

// DeleteExplorePost deletes an explore post by ID.
func DeleteExplorePost(id string) error {
	_, err := GetDB().Exec(`DELETE FROM explore_posts WHERE id = ?`, id)
	return err
}

// UpdateExplorePostTags replaces the tags on an explore post.
func UpdateExplorePostTags(id string, tags []string) error {
	tagsJSON, _ := json.Marshal(tags)
	_, err := GetDB().Exec(`UPDATE explore_posts SET tags = ? WHERE id = ?`, string(tagsJSON), id)
	return err
}

const explorePostColumns = `id, author, title, content, media_type, media_paths, media_dir, tags, created_at`
const defaultExploreLimit = 20

// ListExplorePostsNewest returns the most recent posts (first page).
func ListExplorePostsNewest(limit int) (*ExplorePostListResult, error) {
	if limit <= 0 {
		limit = defaultExploreLimit
	}

	rows, err := GetDB().Query(fmt.Sprintf(`
		SELECT %s FROM explore_posts
		ORDER BY created_at DESC, id DESC
		LIMIT ?
	`, explorePostColumns), limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	posts, err := collectExplorePosts(rows)
	if err != nil {
		return nil, err
	}

	hasOlder := len(posts) > limit
	if hasOlder {
		posts = posts[:limit]
	}

	return &ExplorePostListResult{
		Posts:    posts,
		HasOlder: hasOlder,
		HasNewer: false,
	}, nil
}

// ListExplorePostsBefore returns posts older than the given cursor.
func ListExplorePostsBefore(cursor string, limit int) (*ExplorePostListResult, error) {
	if limit <= 0 {
		limit = defaultExploreLimit
	}

	epochMs, cursorID, err := ParseExploreCursor(cursor)
	if err != nil {
		return nil, err
	}

	rows, err := GetDB().Query(fmt.Sprintf(`
		SELECT %s FROM explore_posts
		WHERE (created_at < ? OR (created_at = ? AND id < ?))
		ORDER BY created_at DESC, id DESC
		LIMIT ?
	`, explorePostColumns), epochMs, epochMs, cursorID, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	posts, err := collectExplorePosts(rows)
	if err != nil {
		return nil, err
	}

	hasOlder := len(posts) > limit
	if hasOlder {
		posts = posts[:limit]
	}

	return &ExplorePostListResult{
		Posts:    posts,
		HasOlder: hasOlder,
		HasNewer: true,
	}, nil
}

// ListExplorePostsAfter returns posts newer than the given cursor.
func ListExplorePostsAfter(cursor string, limit int) (*ExplorePostListResult, error) {
	if limit <= 0 {
		limit = defaultExploreLimit
	}

	epochMs, cursorID, err := ParseExploreCursor(cursor)
	if err != nil {
		return nil, err
	}

	// Query in ascending order to get the next page, then reverse.
	rows, err := GetDB().Query(fmt.Sprintf(`
		SELECT %s FROM explore_posts
		WHERE (created_at > ? OR (created_at = ? AND id > ?))
		ORDER BY created_at ASC, id ASC
		LIMIT ?
	`, explorePostColumns), epochMs, epochMs, cursorID, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	posts, err := collectExplorePosts(rows)
	if err != nil {
		return nil, err
	}

	hasNewer := len(posts) > limit
	if hasNewer {
		posts = posts[:limit]
	}

	// Reverse to get descending order (newest first).
	for i, j := 0, len(posts)-1; i < j; i, j = i+1, j-1 {
		posts[i], posts[j] = posts[j], posts[i]
	}

	return &ExplorePostListResult{
		Posts:    posts,
		HasOlder: true,
		HasNewer: hasNewer,
	}, nil
}

// collectExplorePosts scans all rows into a slice of ExplorePost.
func collectExplorePosts(rows *sql.Rows) ([]ExplorePost, error) {
	var posts []ExplorePost
	for rows.Next() {
		p, err := scanExplorePost(rows)
		if err != nil {
			return nil, err
		}
		posts = append(posts, p)
	}
	if posts == nil {
		posts = []ExplorePost{}
	}
	return posts, rows.Err()
}

// InsertExploreComment inserts a new comment on a post.
func InsertExploreComment(c *ExploreComment) error {
	_, err := GetDB().Exec(`
		INSERT INTO explore_comments (id, post_id, author, content, created_at)
		VALUES (?, ?, ?, ?, ?)
	`, c.ID, c.PostID, c.Author, c.Content, c.CreatedAt)
	return err
}

// ListExploreComments returns all comments for a post, ordered by creation time.
func ListExploreComments(postID string) ([]ExploreComment, error) {
	rows, err := GetDB().Query(`
		SELECT id, post_id, author, content, created_at
		FROM explore_comments
		WHERE post_id = ?
		ORDER BY created_at ASC
	`, postID)
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
	if comments == nil {
		comments = []ExploreComment{}
	}
	return comments, rows.Err()
}
