package meili

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"

	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Indexer reads files and upserts meili_documents rows.
// The existing SyncWorker picks up pending rows and pushes to Meilisearch.
type Indexer struct {
	dataRoot  string
	syncNudge func() // called after upserting to wake sync worker
}

// NewIndexer creates a new Meilisearch indexer.
// dataRoot is the absolute path to the user data directory.
// syncNudge is called after documents are upserted (typically SyncWorker.Nudge).
func NewIndexer(dataRoot string, syncNudge func()) *Indexer {
	return &Indexer{
		dataRoot:  dataRoot,
		syncNudge: syncNudge,
	}
}

// OnFileChange is called when the FS service detects a file change.
// It reads the file content and upserts a meili_documents row.
func (idx *Indexer) OnFileChange(filePath string, isNew bool, contentChanged bool) {
	if err := idx.indexFile(filePath); err != nil {
		log.Error().Err(err).Str("path", filePath).Msg("meili indexer: failed to index file")
		return
	}
	idx.syncNudge()
}

// OnFileDelete is called when the FS service detects a file deletion.
func (idx *Indexer) OnFileDelete(filePath string) {
	if err := db.DeleteMeiliDocumentByFilePath(filePath); err != nil {
		log.Error().Err(err).Str("path", filePath).Msg("meili indexer: failed to delete document")
	}
}

// indexFile reads file content and upserts into meili_documents.
func (idx *Indexer) indexFile(filePath string) error {
	// Get file record for mime type
	file, err := db.GetFileByPath(filePath)
	if err != nil || file == nil {
		return nil // File doesn't exist in DB, skip
	}

	if file.IsFolder {
		return nil
	}

	// Read text content
	content := ""
	isText := IsTextFile(filePath)
	if !isText && file.MimeType != nil {
		isText = IsTextFileByMimeType(*file.MimeType)
	}

	if isText {
		fullPath := filepath.Join(idx.dataRoot, filePath)
		content, err = ReadTextContent(fullPath)
		if err != nil {
			log.Warn().Err(err).Str("path", filePath).Msg("meili indexer: failed to read content")
			// Continue with empty content — filename still gets indexed
		}
	}

	// Compute content hash (filename + content)
	hashInput := filePath + "\n" + content
	hash := sha256.Sum256([]byte(hashInput))
	contentHash := hex.EncodeToString(hash[:])

	wordCount := len(strings.Fields(content))

	doc := &db.MeiliDocument{
		FilePath:    filePath,
		Content:     content,
		ContentHash: contentHash,
		WordCount:   wordCount,
		MimeType:    file.MimeType,
	}

	return db.UpsertMeiliDocument(doc)
}

// Backfill indexes all existing files that are not yet in meili_documents.
// Runs in the caller's goroutine (server.go launches it in a goroutine).
func (idx *Indexer) Backfill() {
	log.Info().Msg("meili indexer: starting backfill of all files")

	rows, err := db.GetDB().Query(`SELECT path FROM files WHERE is_folder = 0`)
	if err != nil {
		log.Error().Err(err).Msg("meili indexer: failed to query files for backfill")
		return
	}
	defer rows.Close()

	total := 0
	indexed := 0
	skipped := 0

	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			continue
		}
		total++

		// Check if already indexed with same content
		existing, err := db.GetMeiliDocumentByFilePath(path)
		if err != nil {
			continue
		}

		if existing != nil && existing.MeiliStatus == "indexed" {
			skipped++
			continue
		}

		if err := idx.indexFile(path); err != nil {
			log.Warn().Err(err).Str("path", path).Msg("meili indexer: backfill failed for file")
			continue
		}
		indexed++
	}

	log.Info().
		Int("total", total).
		Int("indexed", indexed).
		Int("skipped", skipped).
		Msg("meili indexer: backfill complete")

	if indexed > 0 {
		idx.syncNudge()
	}
}
