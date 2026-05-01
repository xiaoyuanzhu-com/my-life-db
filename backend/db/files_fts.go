package db

import (
	"fmt"
	"strings"
)

// files_fts is a SQLite FTS5 virtual table backed by the wangfenjin/simple
// tokenizer (see migration_027_files_fts.go). All write paths are synchronous
// — when a file's content changes we INSERT OR REPLACE the row immediately
// inside the same transaction the file metadata lives in. There is no
// staging table and no async sync worker; the index is always consistent
// with what the writer last saw.

// FTSHit is a single result row from SearchFTS.
type FTSHit struct {
	DocumentID    string
	FilePath      string
	Score         float64 // bm25 score (lower is better; we negate at API layer if needed)
	Snippet       string  // simple_snippet output with <em>...</em> highlights on the content column
	FilePathHL    string  // simple_highlight output on the file_path column (may equal FilePath if no match there)
	HasContentHit bool    // true if the snippet column contains highlight markup
}

// FTSSearchOptions controls SearchFTS pagination + filters.
type FTSSearchOptions struct {
	Limit      int
	Offset     int
	TypeFilter string // matched against files.mime_type via STARTS WITH
	PathFilter string // matched against files.file_path via STARTS WITH
}

// IndexFile upserts a row into files_fts. Use INSERT OR REPLACE on the
// internal rowid surrogate isn't viable for FTS5 — we DELETE then INSERT
// to keep semantics simple and the tokenizer state clean.
func IndexFile(documentID, filePath, content string) error {
	d := GetDB()
	if d == nil {
		return fmt.Errorf("db not initialized")
	}

	tx, err := d.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err = tx.Exec(`DELETE FROM files_fts WHERE file_path = ?`, filePath); err != nil {
		return fmt.Errorf("delete existing fts row: %w", err)
	}
	if _, err = tx.Exec(
		`INSERT INTO files_fts(document_id, file_path, content) VALUES (?, ?, ?)`,
		documentID, filePath, content,
	); err != nil {
		return fmt.Errorf("insert fts row: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// DeleteFileFromIndex removes a single row by file_path. No-op if missing.
func DeleteFileFromIndex(filePath string) error {
	d := GetDB()
	if d == nil {
		return nil
	}
	_, err := d.Exec(`DELETE FROM files_fts WHERE file_path = ?`, filePath)
	return err
}

// RenameFileInIndex updates file_path on the single row matching oldPath.
// Used when a file is moved or renamed; preserves the existing tokenized
// content (no reindex needed).
func RenameFileInIndex(oldPath, newPath string) error {
	d := GetDB()
	if d == nil {
		return nil
	}
	_, err := d.Exec(
		`UPDATE files_fts SET file_path = ? WHERE file_path = ?`,
		newPath, oldPath,
	)
	return err
}

// RenamePrefixInIndex bulk-rewrites file_path for every row whose path
// begins with oldPrefix. Used when a directory is moved/renamed.
func RenamePrefixInIndex(oldPrefix, newPrefix string) error {
	d := GetDB()
	if d == nil {
		return nil
	}
	// SQLite doesn't have STARTS WITH; we use file_path LIKE 'old%' with
	// ESCAPE for safety, but since file paths in this app shouldn't contain
	// SQL wildcards in practice, we do a simple LIKE prefix match.
	pattern := escapeLikePrefix(oldPrefix) + "%"
	_, err := d.Exec(
		`UPDATE files_fts
		 SET file_path = ? || substr(file_path, ?)
		 WHERE file_path LIKE ? ESCAPE '\'`,
		newPrefix, len(oldPrefix)+1, pattern,
	)
	return err
}

// IsFileIndexed reports whether files_fts has a row for the given path.
// Used by the indexer's backfill loop to skip files that are already up
// to date.
func IsFileIndexed(filePath string) (bool, error) {
	d := GetDB()
	if d == nil {
		return false, fmt.Errorf("db not initialized")
	}
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM files_fts WHERE file_path = ?`, filePath).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// SearchFTS runs a full-text query against files_fts, joins file metadata
// for filtering, and returns ranked hits with highlight markup.
//
// The query is wrapped in simple_query() so the user can type freeform
// text (English or Chinese) without learning FTS5 syntax.
//
// snippet length is fixed at 64 tokens with <em>...</em> markup matching
// what the frontend already parses for Meilisearch results.
func SearchFTS(query string, opts FTSSearchOptions) ([]FTSHit, int, error) {
	d := GetDB()
	if d == nil {
		return nil, 0, fmt.Errorf("db not initialized")
	}

	limit := opts.Limit
	if limit <= 0 {
		limit = 20
	}
	offset := opts.Offset
	if offset < 0 {
		offset = 0
	}

	// Build args + filter SQL incrementally so empty filters compile to
	// no-ops at the SQL layer. simple_query() must wrap the user input.
	whereParts := []string{"files_fts MATCH simple_query(?)"}
	args := []any{query}

	if opts.PathFilter != "" {
		whereParts = append(whereParts, "files_fts.file_path LIKE ? ESCAPE '\\'")
		args = append(args, escapeLikePrefix(opts.PathFilter)+"%")
	}
	if opts.TypeFilter != "" {
		whereParts = append(whereParts, "files.mime_type LIKE ? ESCAPE '\\'")
		args = append(args, escapeLikePrefix(opts.TypeFilter)+"%")
	}

	whereSQL := strings.Join(whereParts, " AND ")

	// Count total hits (for pagination). simple_query() / MATCH already
	// filter — same WHERE, no LIMIT/OFFSET.
	countSQL := `
		SELECT COUNT(*)
		FROM files_fts
		LEFT JOIN files ON files.path = files_fts.file_path
		WHERE ` + whereSQL

	var total int
	if err := d.QueryRow(countSQL, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count fts hits: %w", err)
	}

	// Fetch the page of hits with snippet/highlight markup.
	// simple_snippet(files_fts, 2, ...) — column 2 is content.
	// simple_highlight(files_fts, 1, ...) — column 1 is file_path.
	pageSQL := `
		SELECT
			files_fts.document_id,
			files_fts.file_path,
			simple_snippet(files_fts, 2, '<em>', '</em>', '...', 64) AS snippet,
			simple_highlight(files_fts, 1, '<em>', '</em>') AS file_path_hl,
			bm25(files_fts) AS score
		FROM files_fts
		LEFT JOIN files ON files.path = files_fts.file_path
		WHERE ` + whereSQL + `
		ORDER BY score
		LIMIT ? OFFSET ?`
	pageArgs := append(append([]any{}, args...), limit, offset)

	rows, err := d.Query(pageSQL, pageArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("query fts: %w", err)
	}
	defer rows.Close()

	var hits []FTSHit
	for rows.Next() {
		var h FTSHit
		if err := rows.Scan(&h.DocumentID, &h.FilePath, &h.Snippet, &h.FilePathHL, &h.Score); err != nil {
			return nil, 0, fmt.Errorf("scan fts row: %w", err)
		}
		h.HasContentHit = strings.Contains(h.Snippet, "<em>")
		hits = append(hits, h)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return hits, total, nil
}

// escapeLikePrefix escapes %, _, and \ in a LIKE prefix so we can do a
// safe "starts with" match. Use with `ESCAPE '\'` in the SQL.
func escapeLikePrefix(s string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
	)
	return r.Replace(s)
}
