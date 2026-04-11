package explore

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/oklog/ulid/v2"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Service manages explore posts and their media files.
type Service struct {
	baseDir string // e.g. /path/to/user-data/explore
}

// NewService creates a new explore service.
func NewService(userDataDir string) *Service {
	dir := filepath.Join(userDataDir, "explore")
	return &Service{baseDir: dir}
}

// BaseDir returns the base directory for explore media.
func (s *Service) BaseDir() string {
	return s.baseDir
}

// CreatePostInput contains the data needed to create a new explore post.
type CreatePostInput struct {
	Author    string       `json:"author"`
	Title     string       `json:"title"`
	Content   *string      `json:"content,omitempty"`
	MediaType *string      `json:"mediaType,omitempty"`
	Media     []MediaInput `json:"media,omitempty"`
	Tags      []string     `json:"tags,omitempty"`
}

// MediaInput represents a media file to attach to a post.
// Provide either Content (base64-encoded) or Path (absolute file path), not both.
type MediaInput struct {
	Filename string `json:"filename"`
	Content  string `json:"content,omitempty"` // base64-encoded
	Path     string `json:"path,omitempty"`    // absolute file path (alternative to base64)
}

// sanitizeForPath strips special characters, replaces spaces with hyphens,
// and limits to 80 characters. Supports CJK and other Unicode letters.
func sanitizeForPath(s string) string {
	// Replace spaces and underscores with hyphens
	s = strings.ReplaceAll(s, " ", "-")
	s = strings.ReplaceAll(s, "_", "-")

	// Keep only letters (including CJK), digits, and hyphens
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' {
			b.WriteRune(r)
		}
	}
	s = b.String()

	// Collapse multiple hyphens
	re := regexp.MustCompile(`-{2,}`)
	s = re.ReplaceAllString(s, "-")

	// Trim leading/trailing hyphens
	s = strings.Trim(s, "-")

	// Lowercase
	s = strings.ToLower(s)

	// Limit length
	if len(s) > 80 {
		s = s[:80]
		// Don't end with a hyphen after truncation
		s = strings.TrimRight(s, "-")
	}

	if s == "" {
		s = "untitled"
	}

	return s
}

// CreatePost creates a new explore post, writes media files, and inserts into the database.
func (s *Service) CreatePost(input CreatePostInput) (*db.ExplorePostWithComments, error) {
	id := ulid.Make().String()
	now := time.Now().UnixMilli()

	// Build media dir: <sanitized-author>/<YYMM>-<sanitized-title>/
	var mediaDir *string
	var mediaPaths []string

	if len(input.Media) > 0 {
		authorSlug := sanitizeForPath(input.Author)
		titleSlug := sanitizeForPath(input.Title)
		yymm := time.Now().Format("0601") // Go format: 06=2-digit year, 01=2-digit month

		dirName := fmt.Sprintf("%s-%s", yymm, titleSlug)
		relDir := filepath.Join(authorSlug, dirName)
		absDir := filepath.Join(s.baseDir, relDir)

		// If directory exists, append suffix
		absDir, relDir = uniqueDir(absDir, relDir)

		if err := os.MkdirAll(absDir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create media directory: %w", err)
		}

		mediaDir = &relDir

		for _, m := range input.Media {
			destPath := filepath.Join(absDir, m.Filename)

			if m.Path != "" {
				// Copy from file path
				data, err := os.ReadFile(m.Path)
				if err != nil {
					return nil, fmt.Errorf("failed to read %s: %w", m.Path, err)
				}
				if err := os.WriteFile(destPath, data, 0644); err != nil {
					return nil, fmt.Errorf("failed to write %s: %w", m.Filename, err)
				}
			} else {
				// Decode from base64
				data, err := base64.StdEncoding.DecodeString(m.Content)
				if err != nil {
					return nil, fmt.Errorf("invalid base64 for %s: %w", m.Filename, err)
				}
				if err := os.WriteFile(destPath, data, 0644); err != nil {
					return nil, fmt.Errorf("failed to write %s: %w", m.Filename, err)
				}
			}

			mediaPaths = append(mediaPaths, filepath.Join("explore", relDir, m.Filename))
		}

		log.Info().Str("postId", id).Str("mediaDir", relDir).Int("files", len(input.Media)).Msg("explore: wrote media files")
	}

	post := &db.ExplorePost{
		ID:         id,
		Author:     input.Author,
		Title:      input.Title,
		Content:    input.Content,
		MediaType:  input.MediaType,
		MediaPaths: mediaPaths,
		MediaDir:   mediaDir,
		Tags:       input.Tags,
		CreatedAt:  now,
	}
	if post.Tags == nil {
		post.Tags = []string{}
	}
	if post.MediaPaths == nil {
		post.MediaPaths = []string{}
	}

	if err := db.InsertExplorePost(post); err != nil {
		return nil, fmt.Errorf("failed to insert post: %w", err)
	}

	log.Info().Str("postId", id).Str("author", input.Author).Str("title", input.Title).Msg("explore: created post")

	return &db.ExplorePostWithComments{
		ExplorePost: *post,
		Comments:    []db.ExploreComment{},
	}, nil
}

// DeletePost deletes a post from the database and removes its media directory.
func (s *Service) DeletePost(id string) error {
	// Get the post first to find its media dir
	post, err := db.GetExplorePost(id)
	if err != nil {
		return fmt.Errorf("failed to get post: %w", err)
	}
	if post == nil {
		return fmt.Errorf("post not found: %s", id)
	}

	// Delete from database (CASCADE will remove comments)
	if err := db.DeleteExplorePost(id); err != nil {
		return fmt.Errorf("failed to delete post from db: %w", err)
	}

	// Remove media directory if it exists
	if post.MediaDir != nil && *post.MediaDir != "" {
		absDir := filepath.Join(s.baseDir, *post.MediaDir)
		if err := os.RemoveAll(absDir); err != nil {
			log.Warn().Err(err).Str("postId", id).Str("dir", absDir).Msg("explore: failed to remove media dir")
		} else {
			log.Info().Str("postId", id).Str("dir", absDir).Msg("explore: removed media dir")
		}
	}

	log.Info().Str("postId", id).Msg("explore: deleted post")
	return nil
}

// AddComment adds a comment to an existing post.
func (s *Service) AddComment(postID, author, content string) (*db.ExploreComment, error) {
	// Validate post exists
	post, err := db.GetExplorePost(postID)
	if err != nil {
		return nil, fmt.Errorf("failed to get post: %w", err)
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
		return nil, fmt.Errorf("failed to insert comment: %w", err)
	}

	log.Info().Str("commentId", comment.ID).Str("postId", postID).Str("author", author).Msg("explore: added comment")
	return comment, nil
}

// AddTags merges new tags into a post's existing tags idempotently.
func (s *Service) AddTags(postID string, tags []string) ([]string, error) {
	post, err := db.GetExplorePost(postID)
	if err != nil {
		return nil, fmt.Errorf("failed to get post: %w", err)
	}
	if post == nil {
		return nil, fmt.Errorf("post not found: %s", postID)
	}

	// Build set from existing tags
	existing := make(map[string]bool, len(post.Tags))
	for _, t := range post.Tags {
		existing[t] = true
	}

	// Merge new tags
	merged := make([]string, len(post.Tags))
	copy(merged, post.Tags)
	for _, t := range tags {
		if !existing[t] {
			merged = append(merged, t)
			existing[t] = true
		}
	}

	if err := db.UpdateExplorePostTags(postID, merged); err != nil {
		return nil, fmt.Errorf("failed to update tags: %w", err)
	}

	log.Info().Str("postId", postID).Strs("tags", merged).Msg("explore: updated tags")
	return merged, nil
}

// uniqueDir ensures the directory path is unique by appending -2, -3, etc.
func uniqueDir(absDir, relDir string) (string, string) {
	if _, err := os.Stat(absDir); os.IsNotExist(err) {
		return absDir, relDir
	}

	for i := 2; ; i++ {
		suffix := fmt.Sprintf("-%d", i)
		candidate := absDir + suffix
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate, relDir + suffix
		}
	}
}
