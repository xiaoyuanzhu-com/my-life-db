package db

import (
	"database/sql"
	"time"

	"github.com/google/uuid"
)

// MeiliDocument represents a document in meili_documents table
type MeiliDocument struct {
	DocumentID     string
	FilePath       string
	Content        string
	Summary        *string
	Tags           *string
	ContentHash    string
	WordCount      int
	MimeType       *string
	MetadataJSON   *string
	MeiliStatus    string
	MeiliTaskID    *string
	MeiliIndexedAt *string
	MeiliError     *string
	CreatedAt      string
	UpdatedAt      string
}

// UpsertMeiliDocument creates or updates a meili document
func UpsertMeiliDocument(doc *MeiliDocument) error {
	db := GetDB()
	now := time.Now().UTC().Format(time.RFC3339)

	// Check if document exists for this file path
	var existing MeiliDocument
	err := db.QueryRow(`
		SELECT document_id, content_hash
		FROM meili_documents
		WHERE file_path = ?
	`, doc.FilePath).Scan(&existing.DocumentID, &existing.ContentHash)

	if err == sql.ErrNoRows {
		// Insert new document with UUID
		if doc.DocumentID == "" {
			doc.DocumentID = uuid.New().String()
		}

		_, err = db.Exec(`
			INSERT INTO meili_documents (
				document_id, file_path, content, summary, tags, content_hash,
				word_count, mime_type, metadata_json, meili_status,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
		`,
			doc.DocumentID, doc.FilePath, doc.Content, doc.Summary, doc.Tags,
			doc.ContentHash, doc.WordCount, doc.MimeType, doc.MetadataJSON, now, now,
		)
		return err
	}

	if err != nil {
		return err
	}

	// Check if content actually changed
	if existing.ContentHash == doc.ContentHash {
		// Content unchanged, skip update
		return nil
	}

	// Update existing document
	_, err = db.Exec(`
		UPDATE meili_documents SET
			content = ?, summary = ?, tags = ?, content_hash = ?, word_count = ?,
			mime_type = ?, metadata_json = ?, meili_status = 'pending',
			meili_error = NULL, updated_at = ?
		WHERE document_id = ?
	`,
		doc.Content, doc.Summary, doc.Tags, doc.ContentHash, doc.WordCount,
		doc.MimeType, doc.MetadataJSON, now, existing.DocumentID,
	)
	return err
}

// GetMeiliDocumentByFilePath returns the document for a file
func GetMeiliDocumentByFilePath(filePath string) (*MeiliDocument, error) {
	db := GetDB()
	var doc MeiliDocument

	err := db.QueryRow(`
		SELECT document_id, file_path, content, summary, tags, content_hash,
			word_count, mime_type, metadata_json, meili_status, meili_task_id,
			meili_indexed_at, meili_error, created_at, updated_at
		FROM meili_documents
		WHERE file_path = ?
	`, filePath).Scan(
		&doc.DocumentID, &doc.FilePath, &doc.Content, &doc.Summary, &doc.Tags,
		&doc.ContentHash, &doc.WordCount, &doc.MimeType, &doc.MetadataJSON,
		&doc.MeiliStatus, &doc.MeiliTaskID, &doc.MeiliIndexedAt, &doc.MeiliError,
		&doc.CreatedAt, &doc.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, nil
	}

	if err != nil {
		return nil, err
	}

	return &doc, nil
}

// ListMeiliDocumentsByStatus returns documents with a specific status
func ListMeiliDocumentsByStatus(status string, limit int) ([]MeiliDocument, error) {
	db := GetDB()
	var rows *sql.Rows
	var err error

	if limit > 0 {
		rows, err = db.Query(`
			SELECT document_id, file_path, content, summary, tags, content_hash,
				word_count, mime_type, metadata_json, meili_status, meili_task_id,
				meili_indexed_at, meili_error, created_at, updated_at
			FROM meili_documents
			WHERE meili_status = ?
			LIMIT ?
		`, status, limit)
	} else {
		rows, err = db.Query(`
			SELECT document_id, file_path, content, summary, tags, content_hash,
				word_count, mime_type, metadata_json, meili_status, meili_task_id,
				meili_indexed_at, meili_error, created_at, updated_at
			FROM meili_documents
			WHERE meili_status = ?
		`, status)
	}

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var documents []MeiliDocument
	for rows.Next() {
		var doc MeiliDocument
		err := rows.Scan(
			&doc.DocumentID, &doc.FilePath, &doc.Content, &doc.Summary, &doc.Tags,
			&doc.ContentHash, &doc.WordCount, &doc.MimeType, &doc.MetadataJSON,
			&doc.MeiliStatus, &doc.MeiliTaskID, &doc.MeiliIndexedAt, &doc.MeiliError,
			&doc.CreatedAt, &doc.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}
		documents = append(documents, doc)
	}

	return documents, rows.Err()
}

// UpdateMeiliStatus updates the meilisearch status of a document
func UpdateMeiliStatus(documentID, status string, taskID *string, errorMsg *string) error {
	db := GetDB()
	now := time.Now().UTC().Format(time.RFC3339)

	var indexedAt *string
	if status == "indexed" {
		indexedAt = &now
	}

	_, err := db.Exec(`
		UPDATE meili_documents SET
			meili_status = ?,
			meili_task_id = ?,
			meili_indexed_at = ?,
			meili_error = ?,
			updated_at = ?
		WHERE document_id = ?
	`, status, taskID, indexedAt, errorMsg, now, documentID)

	return err
}

// DeleteMeiliDocumentByFilePath deletes the document for a file
func DeleteMeiliDocumentByFilePath(filePath string) error {
	db := GetDB()
	_, err := db.Exec("DELETE FROM meili_documents WHERE file_path = ?", filePath)
	return err
}

// CountMeiliDocumentsByStatus counts documents with a specific status
func CountMeiliDocumentsByStatus(status string) (int, error) {
	db := GetDB()
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM meili_documents WHERE meili_status = ?", status).Scan(&count)
	return count, err
}

// GetMeiliDocumentIdForFile returns the document ID for a file (or error if not found)
func GetMeiliDocumentIdForFile(filePath string) (string, error) {
	doc, err := GetMeiliDocumentByFilePath(filePath)
	if err != nil {
		return "", err
	}
	if doc == nil {
		return "", sql.ErrNoRows
	}
	return doc.DocumentID, nil
}
