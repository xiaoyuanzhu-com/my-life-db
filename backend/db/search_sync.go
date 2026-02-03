package db

import (
	"github.com/xiaoyuanzhu-com/my-life-db/log"
)

// MeiliClientInterface defines the methods needed for search sync operations.
// This avoids importing the vendors package directly.
type MeiliClientInterface interface {
	UpdateDocumentsFilePath(updates map[string]string) error
	DeleteDocument(documentID string) error
}

// QdrantClientInterface defines the methods needed for search sync operations.
// This avoids importing the vendors package directly.
type QdrantClientInterface interface {
	UpdateFilePath(oldPath, newPath string) error
	SetPayload(pointIDs []string, payload map[string]interface{}) error
	Delete(id string) error
}

// SearchClients holds the search service clients for sync operations.
// These are set by the main package at startup to avoid circular imports.
var searchClients struct {
	getMeili  func() MeiliClientInterface
	getQdrant func() QdrantClientInterface
}

// SetSearchClients configures the search clients for sync operations.
// Call this at startup after vendors are initialized.
func SetSearchClients(getMeili func() MeiliClientInterface, getQdrant func() QdrantClientInterface) {
	searchClients.getMeili = getMeili
	searchClients.getQdrant = getQdrant
}

// SyncSearchIndexOnMove updates filePath in external search services (Meili, Qdrant)
// after a file has been moved/renamed. This is a best-effort operation - if the
// external services are unavailable, SQLite is already updated and we log the error.
//
// Call this AFTER the SQLite transaction has committed successfully.
func SyncSearchIndexOnMove(oldPath, newPath string) {
	// Update Meilisearch
	if searchClients.getMeili != nil {
		if meili := searchClients.getMeili(); meili != nil {
			// Get document IDs for this file from our SQLite table
			docs, err := getMeiliDocumentIDsForPath(oldPath)
			if err != nil {
				log.Warn().Err(err).Str("path", oldPath).Msg("failed to get meili document IDs for path sync")
			} else if len(docs) > 0 {
				// Build update map: documentID -> newPath
				updates := make(map[string]string)
				for _, docID := range docs {
					updates[docID] = newPath
				}
				if err := meili.UpdateDocumentsFilePath(updates); err != nil {
					log.Warn().Err(err).Str("oldPath", oldPath).Str("newPath", newPath).Msg("failed to update Meilisearch filePath")
				} else {
					log.Debug().Str("oldPath", oldPath).Str("newPath", newPath).Int("docs", len(docs)).Msg("updated Meilisearch filePath")
				}
			}
		}
	}

	// Update Qdrant
	if searchClients.getQdrant != nil {
		if qdrant := searchClients.getQdrant(); qdrant != nil {
			if err := qdrant.UpdateFilePath(oldPath, newPath); err != nil {
				log.Warn().Err(err).Str("oldPath", oldPath).Str("newPath", newPath).Msg("failed to update Qdrant filePath")
			} else {
				log.Debug().Str("oldPath", oldPath).Str("newPath", newPath).Msg("updated Qdrant filePath")
			}
		}
	}
}

// SyncSearchIndexOnMovePrefix updates filePath in external search services for all
// files with paths starting with oldPath prefix (for folder renames/moves).
//
// Call this AFTER the SQLite transaction has committed successfully.
func SyncSearchIndexOnMovePrefix(oldPath, newPath string) {
	// Update Meilisearch - get all documents with paths starting with oldPath
	if searchClients.getMeili != nil {
		if meili := searchClients.getMeili(); meili != nil {
			docs, err := getMeiliDocumentIDsForPathPrefix(oldPath)
			if err != nil {
				log.Warn().Err(err).Str("path", oldPath).Msg("failed to get meili document IDs for prefix sync")
			} else if len(docs) > 0 {
				// Build update map: documentID -> newPath
				updates := make(map[string]string)
				for docID, docPath := range docs {
					// Calculate new path: replace prefix
					newDocPath := newPath + docPath[len(oldPath):]
					updates[docID] = newDocPath
				}
				if err := meili.UpdateDocumentsFilePath(updates); err != nil {
					log.Warn().Err(err).Str("oldPath", oldPath).Str("newPath", newPath).Msg("failed to update Meilisearch filePaths for prefix")
				} else {
					log.Debug().Str("oldPath", oldPath).Str("newPath", newPath).Int("docs", len(docs)).Msg("updated Meilisearch filePaths for prefix")
				}
			}
		}
	}

	// Update Qdrant - need to update each document individually since SetPayload
	// doesn't support prefix matching with path transformation
	if searchClients.getQdrant != nil {
		if qdrant := searchClients.getQdrant(); qdrant != nil {
			docs, err := getQdrantDocumentIDsForPathPrefix(oldPath)
			if err != nil {
				log.Warn().Err(err).Str("path", oldPath).Msg("failed to get qdrant document IDs for prefix sync")
			} else {
				updated := 0
				for docID, docPath := range docs {
					// Calculate new path: replace prefix
					newDocPath := newPath + docPath[len(oldPath):]
					if err := qdrant.SetPayload([]string{docID}, map[string]interface{}{"filePath": newDocPath}); err != nil {
						log.Warn().Err(err).Str("docID", docID).Msg("failed to update Qdrant point filePath")
					} else {
						updated++
					}
				}
				if updated > 0 {
					log.Debug().Str("oldPath", oldPath).Str("newPath", newPath).Int("updated", updated).Msg("updated Qdrant filePaths for prefix")
				}
			}
		}
	}
}

// SyncSearchIndexOnDelete removes documents from external search services.
// Call this AFTER the SQLite transaction has committed successfully.
//
// Note: For deletes, we need to call this BEFORE DeleteFileWithCascade since
// we need the document IDs from SQLite. The caller should:
// 1. Get document IDs from SQLite
// 2. Delete from SQLite (DeleteFileWithCascade)
// 3. Delete from external services
func SyncSearchIndexOnDelete(meiliDocIDs []string, qdrantDocIDs []string) {
	// Delete from Meilisearch
	if searchClients.getMeili != nil && len(meiliDocIDs) > 0 {
		if meili := searchClients.getMeili(); meili != nil {
			for _, docID := range meiliDocIDs {
				if err := meili.DeleteDocument(docID); err != nil {
					log.Warn().Err(err).Str("docID", docID).Msg("failed to delete document from Meilisearch")
				}
			}
			log.Debug().Int("count", len(meiliDocIDs)).Msg("deleted documents from Meilisearch")
		}
	}

	// Delete from Qdrant
	if searchClients.getQdrant != nil && len(qdrantDocIDs) > 0 {
		if qdrant := searchClients.getQdrant(); qdrant != nil {
			for _, docID := range qdrantDocIDs {
				if err := qdrant.Delete(docID); err != nil {
					log.Warn().Err(err).Str("docID", docID).Msg("failed to delete point from Qdrant")
				}
			}
			log.Debug().Int("count", len(qdrantDocIDs)).Msg("deleted points from Qdrant")
		}
	}
}

// GetSearchDocumentIDsForPath returns document IDs from meili_documents and qdrant_documents
// for the given file path. Used before deletion to know what to delete from external services.
func GetSearchDocumentIDsForPath(path string) (meiliDocIDs []string, qdrantDocIDs []string, err error) {
	meiliDocIDs, err = getMeiliDocumentIDsForPath(path)
	if err != nil {
		return nil, nil, err
	}

	qdrantDocIDs, err = getQdrantDocumentIDsForPath(path)
	if err != nil {
		return meiliDocIDs, nil, err
	}

	return meiliDocIDs, qdrantDocIDs, nil
}

// Helper: get meili document IDs for a specific path
func getMeiliDocumentIDsForPath(path string) ([]string, error) {
	rows, err := GetDB().Query("SELECT document_id FROM meili_documents WHERE file_path = ?", path)
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

// Helper: get meili document IDs and paths for a path prefix
func getMeiliDocumentIDsForPathPrefix(pathPrefix string) (map[string]string, error) {
	rows, err := GetDB().Query(
		"SELECT document_id, file_path FROM meili_documents WHERE file_path = ? OR file_path LIKE ? || '/%'",
		pathPrefix, pathPrefix,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var id, path string
		if err := rows.Scan(&id, &path); err != nil {
			return nil, err
		}
		result[id] = path
	}
	return result, rows.Err()
}

// Helper: get qdrant document IDs for a specific path
func getQdrantDocumentIDsForPath(path string) ([]string, error) {
	rows, err := GetDB().Query("SELECT document_id FROM qdrant_documents WHERE file_path = ?", path)
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

// Helper: get qdrant document IDs and paths for a path prefix
func getQdrantDocumentIDsForPathPrefix(pathPrefix string) (map[string]string, error) {
	rows, err := GetDB().Query(
		"SELECT document_id, file_path FROM qdrant_documents WHERE file_path = ? OR file_path LIKE ? || '/%'",
		pathPrefix, pathPrefix,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var id, path string
		if err := rows.Scan(&id, &path); err != nil {
			return nil, err
		}
		result[id] = path
	}
	return result, rows.Err()
}
