package db

import (
	"database/sql"
	"time"
)

// QdrantDocument represents a document chunk in qdrant_documents table
type QdrantDocument struct {
	DocumentID       string
	FilePath         string
	SourceType       string
	ChunkIndex       int
	ChunkCount       int
	ChunkText        string
	SpanStart        int
	SpanEnd          int
	OverlapTokens    int
	WordCount        int
	TokenCount       int
	ContentHash      string
	MetadataJSON     *string
	EmbeddingStatus  string
	EmbeddingVersion int
	QdrantPointID    *string
	QdrantIndexedAt  *string
	QdrantError      *string
	CreatedAt        string
	UpdatedAt        string
}

// UpsertQdrantDocument creates or updates a qdrant document
func UpsertQdrantDocument(doc *QdrantDocument) error {
	db := GetDB()
	now := time.Now().UTC().Format(time.RFC3339)

	// Check if document exists
	var exists bool
	err := db.QueryRow("SELECT 1 FROM qdrant_documents WHERE document_id = ?", doc.DocumentID).Scan(&exists)
	if err != nil && err != sql.ErrNoRows {
		return err
	}

	if err == sql.ErrNoRows {
		// Insert new document
		_, err = db.Exec(`
			INSERT INTO qdrant_documents (
				document_id, file_path, source_type, chunk_index, chunk_count,
				chunk_text, span_start, span_end, overlap_tokens, word_count,
				token_count, content_hash, metadata_json, embedding_status,
				embedding_version, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
		`,
			doc.DocumentID, doc.FilePath, doc.SourceType, doc.ChunkIndex, doc.ChunkCount,
			doc.ChunkText, doc.SpanStart, doc.SpanEnd, doc.OverlapTokens, doc.WordCount,
			doc.TokenCount, doc.ContentHash, doc.MetadataJSON, doc.EmbeddingVersion, now, now,
		)
		return err
	}

	// Update existing document
	_, err = db.Exec(`
		UPDATE qdrant_documents SET
			file_path = ?, source_type = ?, chunk_index = ?, chunk_count = ?,
			chunk_text = ?, span_start = ?, span_end = ?, overlap_tokens = ?,
			word_count = ?, token_count = ?, content_hash = ?, metadata_json = ?,
			embedding_status = 'pending', embedding_version = ?, qdrant_error = NULL,
			updated_at = ?
		WHERE document_id = ?
	`,
		doc.FilePath, doc.SourceType, doc.ChunkIndex, doc.ChunkCount,
		doc.ChunkText, doc.SpanStart, doc.SpanEnd, doc.OverlapTokens,
		doc.WordCount, doc.TokenCount, doc.ContentHash, doc.MetadataJSON,
		doc.EmbeddingVersion, now, doc.DocumentID,
	)
	return err
}

// ListQdrantDocumentsByFile returns all chunks for a file
func ListQdrantDocumentsByFile(filePath string) ([]QdrantDocument, error) {
	db := GetDB()
	rows, err := db.Query(`
		SELECT document_id, file_path, source_type, chunk_index, chunk_count,
			chunk_text, span_start, span_end, overlap_tokens, word_count,
			token_count, content_hash, metadata_json, embedding_status,
			embedding_version, qdrant_point_id, qdrant_indexed_at, qdrant_error,
			created_at, updated_at
		FROM qdrant_documents
		WHERE file_path = ?
		ORDER BY source_type, chunk_index
	`, filePath)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var documents []QdrantDocument
	for rows.Next() {
		var doc QdrantDocument
		err := rows.Scan(
			&doc.DocumentID, &doc.FilePath, &doc.SourceType, &doc.ChunkIndex, &doc.ChunkCount,
			&doc.ChunkText, &doc.SpanStart, &doc.SpanEnd, &doc.OverlapTokens, &doc.WordCount,
			&doc.TokenCount, &doc.ContentHash, &doc.MetadataJSON, &doc.EmbeddingStatus,
			&doc.EmbeddingVersion, &doc.QdrantPointID, &doc.QdrantIndexedAt, &doc.QdrantError,
			&doc.CreatedAt, &doc.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		documents = append(documents, doc)
	}

	return documents, rows.Err()
}

// ListQdrantDocumentsByStatus returns documents with a specific status
func ListQdrantDocumentsByStatus(status string, limit int) ([]QdrantDocument, error) {
	db := GetDB()
	var rows *sql.Rows
	var err error

	if limit > 0 {
		rows, err = db.Query(`
			SELECT document_id, file_path, source_type, chunk_index, chunk_count,
				chunk_text, span_start, span_end, overlap_tokens, word_count,
				token_count, content_hash, metadata_json, embedding_status,
				embedding_version, qdrant_point_id, qdrant_indexed_at, qdrant_error,
				created_at, updated_at
			FROM qdrant_documents
			WHERE embedding_status = ?
			LIMIT ?
		`, status, limit)
	} else {
		rows, err = db.Query(`
			SELECT document_id, file_path, source_type, chunk_index, chunk_count,
				chunk_text, span_start, span_end, overlap_tokens, word_count,
				token_count, content_hash, metadata_json, embedding_status,
				embedding_version, qdrant_point_id, qdrant_indexed_at, qdrant_error,
				created_at, updated_at
			FROM qdrant_documents
			WHERE embedding_status = ?
		`, status)
	}

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var documents []QdrantDocument
	for rows.Next() {
		var doc QdrantDocument
		err := rows.Scan(
			&doc.DocumentID, &doc.FilePath, &doc.SourceType, &doc.ChunkIndex, &doc.ChunkCount,
			&doc.ChunkText, &doc.SpanStart, &doc.SpanEnd, &doc.OverlapTokens, &doc.WordCount,
			&doc.TokenCount, &doc.ContentHash, &doc.MetadataJSON, &doc.EmbeddingStatus,
			&doc.EmbeddingVersion, &doc.QdrantPointID, &doc.QdrantIndexedAt, &doc.QdrantError,
			&doc.CreatedAt, &doc.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		documents = append(documents, doc)
	}

	return documents, rows.Err()
}

// UpdateQdrantEmbeddingStatus updates the embedding status of a document
func UpdateQdrantEmbeddingStatus(documentID, status string, pointID *string, indexedAt *string, errorMsg *string) error {
	db := GetDB()
	now := time.Now().UTC().Format(time.RFC3339)

	_, err := db.Exec(`
		UPDATE qdrant_documents SET
			embedding_status = ?,
			qdrant_point_id = ?,
			qdrant_indexed_at = ?,
			qdrant_error = ?,
			updated_at = ?
		WHERE document_id = ?
	`, status, pointID, indexedAt, errorMsg, now, documentID)

	return err
}

// DeleteQdrantDocumentsByFile deletes all chunks for a file
func DeleteQdrantDocumentsByFile(filePath string) (int64, error) {
	db := GetDB()
	result, err := db.Exec("DELETE FROM qdrant_documents WHERE file_path = ?", filePath)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// GetQdrantDocumentIdsByFile returns all document IDs for a file
func GetQdrantDocumentIdsByFile(filePath string) ([]string, error) {
	db := GetDB()
	rows, err := db.Query(`
		SELECT document_id
		FROM qdrant_documents
		WHERE file_path = ?
		ORDER BY source_type, chunk_index
	`, filePath)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}

	return ids, rows.Err()
}

// CountQdrantDocumentsByStatus counts documents with a specific status
func CountQdrantDocumentsByStatus(status string) (int, error) {
	db := GetDB()
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM qdrant_documents WHERE embedding_status = ?", status).Scan(&count)
	return count, err
}
