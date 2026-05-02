package textindex

import (
	"path/filepath"

	"github.com/google/uuid"
	"github.com/xiaoyuanzhu-com/my-life-db/db"
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// Indexer reads files and writes them into the SQLite FTS5 files_fts table.
// Writes are synchronous: by the time OnFileChange returns, the row is in
// the index. There is no staging table, no async sync worker, no external
// service.
type Indexer struct {
	dataRoot string
	db       *db.DB
}

// NewIndexer creates a text indexer rooted at the user's data directory.
// dataRoot is the absolute filesystem path; relative file paths in
// db.files are joined against it to read content.
func NewIndexer(dataRoot string, database *db.DB) *Indexer {
	return &Indexer{dataRoot: dataRoot, db: database}
}

// OnFileChange is called by the FS service when a file is created,
// modified, or its content otherwise changes. We re-read the file and
// upsert its row in files_fts.
//
// isNew and contentChanged match the existing FS event signature; we
// don't currently use them — every change re-indexes — because the FTS5
// write is cheap (single SQLite transaction) and the content-hash dedup
// the old meili pipeline did mostly existed to avoid sync churn against
// an external service that no longer exists.
func (idx *Indexer) OnFileChange(filePath string, isNew bool, contentChanged bool) {
	if err := idx.indexFile(filePath); err != nil {
		log.Error().Err(err).Str("path", filePath).Msg("text indexer: failed to index file")
	}
}

// OnFileDelete removes the file's row from files_fts.
func (idx *Indexer) OnFileDelete(filePath string) {
	if err := db.DeleteFileFromIndex(filePath); err != nil {
		log.Error().Err(err).Str("path", filePath).Msg("text indexer: failed to delete from index")
	}
}

// indexFile reads the file from disk and writes it to files_fts.
// Folders and binary files are skipped; for text files the content is
// read up to MaxContentBytes.
func (idx *Indexer) indexFile(filePath string) error {
	file, err := idx.db.GetFileByPath(filePath)
	if err != nil || file == nil {
		// File was removed from the DB between events — nothing to index.
		return nil
	}
	if file.IsFolder {
		return nil
	}

	// Read content if the file looks textual. Binary files still get an
	// index row keyed on file_path (so filename search works) but with
	// empty content.
	content := ""
	isText := IsTextFile(filePath)
	if !isText && file.MimeType != nil {
		isText = IsTextFileByMimeType(*file.MimeType)
	}
	if isText {
		fullPath := filepath.Join(idx.dataRoot, filePath)
		content, _ = ReadTextContent(fullPath)
	}

	// Reuse the file_path as a stable document ID. The old pipeline
	// generated UUIDs because Meilisearch wanted opaque keys; FTS5
	// doesn't care, but the DocumentID column in files_fts exists for
	// future use (e.g., linking to a future docs table).
	documentID := stableDocID(filePath)
	return db.IndexFile(documentID, filePath, content)
}

// Backfill walks the files table and indexes any row missing from
// files_fts. Idempotent — re-running adds nothing.
func (idx *Indexer) Backfill() {
	log.Info().Msg("text indexer: starting backfill")

	rows, err := db.GetDB().Query(`SELECT path FROM files WHERE is_folder = 0`)
	if err != nil {
		log.Error().Err(err).Msg("text indexer: failed to query files for backfill")
		return
	}
	defer rows.Close()

	total, indexed, skipped := 0, 0, 0
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			continue
		}
		total++

		already, err := db.IsFileIndexed(path)
		if err != nil {
			continue
		}
		if already {
			skipped++
			continue
		}

		if err := idx.indexFile(path); err != nil {
			log.Warn().Err(err).Str("path", path).Msg("text indexer: backfill failed for file")
			continue
		}
		indexed++
	}

	log.Info().
		Int("total", total).
		Int("indexed", indexed).
		Int("skipped", skipped).
		Msg("text indexer: backfill complete")
}

// stableDocID returns a UUID for a file path. Currently unused by FTS5
// but kept for forward compatibility in case we add a separate documents
// table that joins on a stable ID. Generated fresh per call — the FTS5
// table treats document_id as UNINDEXED metadata only.
func stableDocID(_ string) string {
	return uuid.New().String()
}
