package db

import (
	"context"
	"database/sql"

	"github.com/google/uuid"
)

// GetDigestByID retrieves a digest by ID
func (d *DB) GetDigestByID(id string) (*Digest, error) {
	query := `
		SELECT id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at
		FROM digests
		WHERE id = ?
	`

	row := d.conn.QueryRow(query, id)

	var dg Digest
	var content, sqlarName, digestError sql.NullString

	err := row.Scan(
		&dg.ID, &dg.FilePath, &dg.Digester, &dg.Status, &content,
		&sqlarName, &digestError, &dg.Attempts, &dg.CreatedAt, &dg.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	dg.Content = StringPtr(content)
	dg.SqlarName = StringPtr(sqlarName)
	dg.Error = StringPtr(digestError)

	return &dg, nil
}

// GetDigestsForFile retrieves all digests for a file
func (d *DB) GetDigestsForFile(filePath string) ([]Digest, error) {
	query := `
		SELECT id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at
		FROM digests
		WHERE file_path = ?
		ORDER BY digester
	`

	rows, err := d.conn.Query(query, filePath)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var digests []Digest
	for rows.Next() {
		var dg Digest
		var content, sqlarName, digestError sql.NullString

		err := rows.Scan(
			&dg.ID, &dg.FilePath, &dg.Digester, &dg.Status, &content,
			&sqlarName, &digestError, &dg.Attempts, &dg.CreatedAt, &dg.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}

		dg.Content = StringPtr(content)
		dg.SqlarName = StringPtr(sqlarName)
		dg.Error = StringPtr(digestError)

		digests = append(digests, dg)
	}

	return digests, nil
}

// GetDigestByFileAndDigester retrieves a specific digest
func (d *DB) GetDigestByFileAndDigester(filePath, digester string) (*Digest, error) {
	query := `
		SELECT id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at
		FROM digests
		WHERE file_path = ? AND digester = ?
	`

	row := d.conn.QueryRow(query, filePath, digester)

	var dg Digest
	var content, sqlarName, digestError sql.NullString

	err := row.Scan(
		&dg.ID, &dg.FilePath, &dg.Digester, &dg.Status, &content,
		&sqlarName, &digestError, &dg.Attempts, &dg.CreatedAt, &dg.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	dg.Content = StringPtr(content)
	dg.SqlarName = StringPtr(sqlarName)
	dg.Error = StringPtr(digestError)

	return &dg, nil
}

// CreateDigest creates a new digest record
func (d *DB) CreateDigest(ctx context.Context, dg *Digest) error {
	if dg.ID == "" {
		dg.ID = uuid.New().String()
	}
	now := NowMs()
	if dg.CreatedAt == 0 {
		dg.CreatedAt = now
	}
	if dg.UpdatedAt == 0 {
		dg.UpdatedAt = now
	}

	query := `
		INSERT INTO digests (id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`

	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(query,
			dg.ID, dg.FilePath, dg.Digester, dg.Status, dg.Content,
			dg.SqlarName, dg.Error, dg.Attempts, dg.CreatedAt, dg.UpdatedAt,
		)
		return err
	})
}

// UpdateDigest updates an existing digest
func (d *DB) UpdateDigest(ctx context.Context, dg *Digest) error {
	dg.UpdatedAt = NowMs()

	query := `
		UPDATE digests
		SET status = ?, content = ?, sqlar_name = ?, error = ?, attempts = ?, updated_at = ?
		WHERE id = ?
	`

	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(query,
			dg.Status, dg.Content, dg.SqlarName, dg.Error, dg.Attempts, dg.UpdatedAt, dg.ID,
		)
		return err
	})
}

// UpsertDigest creates or updates a digest
func (d *DB) UpsertDigest(ctx context.Context, dg *Digest) error {
	now := NowMs()
	if dg.ID == "" {
		dg.ID = GeneratePathHash(dg.FilePath) + "-" + dg.Digester
	}
	dg.UpdatedAt = now

	query := `
		INSERT INTO digests (id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(file_path, digester) DO UPDATE SET
			status = excluded.status,
			content = excluded.content,
			sqlar_name = excluded.sqlar_name,
			error = excluded.error,
			attempts = excluded.attempts,
			updated_at = excluded.updated_at
	`

	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(query,
			dg.ID, dg.FilePath, dg.Digester, dg.Status, dg.Content,
			dg.SqlarName, dg.Error, dg.Attempts, now, dg.UpdatedAt,
		)
		return err
	})
}

// DeleteDigest removes a digest
func (d *DB) DeleteDigest(ctx context.Context, id string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("DELETE FROM digests WHERE id = ?", id)
		return err
	})
}

// DeleteDigestsForFile removes all digests for a file
func (d *DB) DeleteDigestsForFile(ctx context.Context, filePath string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("DELETE FROM digests WHERE file_path = ?", filePath)
		return err
	})
}

// ResetDigesterAll resets all digests of a specific type
func (d *DB) ResetDigesterAll(ctx context.Context, digester string) (int64, error) {
	var affected int64
	err := d.Write(ctx, func(tx *sql.Tx) error {
		result, err := tx.Exec(`
			UPDATE digests
			SET status = 'todo', error = NULL, attempts = 0, updated_at = ?
			WHERE digester = ?
		`, NowMs(), digester)
		if err != nil {
			return err
		}
		affected, err = result.RowsAffected()
		return err
	})
	if err != nil {
		return 0, err
	}
	return affected, nil
}

// GetDigestStats returns statistics about digests
func (d *DB) GetDigestStats() (map[string]interface{}, error) {
	stats := make(map[string]interface{})

	// Count by status
	rows, err := d.conn.Query(`
		SELECT status, COUNT(*) as count
		FROM digests
		GROUP BY status
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byStatus := make(map[string]int64)
	for rows.Next() {
		var status string
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		byStatus[status] = count
	}
	stats["byStatus"] = byStatus

	// Count by digester
	rows, err = d.conn.Query(`
		SELECT digester, status, COUNT(*) as count
		FROM digests
		GROUP BY digester, status
		ORDER BY digester
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byDigester := make(map[string]map[string]int64)
	for rows.Next() {
		var digester, status string
		var count int64
		if err := rows.Scan(&digester, &status, &count); err != nil {
			return nil, err
		}
		if _, ok := byDigester[digester]; !ok {
			byDigester[digester] = make(map[string]int64)
		}
		byDigester[digester][status] = count
	}
	stats["byDigester"] = byDigester

	// Total
	var total int64
	err = d.conn.QueryRow("SELECT COUNT(*) FROM digests").Scan(&total)
	if err != nil {
		return nil, err
	}
	stats["total"] = total

	return stats, nil
}

// GetPendingDigests retrieves digests that need processing
func (d *DB) GetPendingDigests(limit int) ([]Digest, error) {
	query := `
		SELECT id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at
		FROM digests
		WHERE status IN ('todo', 'failed')
		  AND attempts < 3
		ORDER BY created_at ASC
		LIMIT ?
	`

	rows, err := d.conn.Query(query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var digests []Digest
	for rows.Next() {
		var dg Digest
		var content, sqlarName, digestError sql.NullString

		err := rows.Scan(
			&dg.ID, &dg.FilePath, &dg.Digester, &dg.Status, &content,
			&sqlarName, &digestError, &dg.Attempts, &dg.CreatedAt, &dg.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}

		dg.Content = StringPtr(content)
		dg.SqlarName = StringPtr(sqlarName)
		dg.Error = StringPtr(digestError)

		digests = append(digests, dg)
	}

	return digests, nil
}

// GetDistinctDigesters returns all unique digester names
func (d *DB) GetDistinctDigesters() ([]string, error) {
	rows, err := d.conn.Query("SELECT DISTINCT digester FROM digests ORDER BY digester")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var digesters []string
	for rows.Next() {
		var digester string
		if err := rows.Scan(&digester); err != nil {
			return nil, err
		}
		digesters = append(digesters, digester)
	}

	return digesters, nil
}

// ListDigestsForPath returns all digests for a file path (alias for GetDigestsForFile)
func (d *DB) ListDigestsForPath(filePath string) []Digest {
	digests, err := d.GetDigestsForFile(filePath)
	if err != nil {
		return nil
	}
	return digests
}

// GetDigestByPathAndDigester returns a digest by file path and digester name
func (d *DB) GetDigestByPathAndDigester(filePath, digester string) *Digest {
	dg, err := d.GetDigestByFileAndDigester(filePath, digester)
	if err != nil {
		return nil
	}
	return dg
}

// UpdateDigestMap updates a digest using a map of fields
func (d *DB) UpdateDigestMap(ctx context.Context, id string, fields map[string]interface{}) error {
	dg, err := d.GetDigestByID(id)
	if err != nil || dg == nil {
		return err
	}

	// Apply updates
	if status, ok := fields["status"].(string); ok {
		dg.Status = status
	}
	if content, ok := fields["content"].(string); ok {
		dg.Content = &content
	}
	if sqlarName, ok := fields["sqlar_name"].(string); ok {
		dg.SqlarName = &sqlarName
	}
	if errorStr, ok := fields["error"]; ok {
		if errorStr == nil {
			dg.Error = nil
		} else if s, ok := errorStr.(string); ok {
			dg.Error = &s
		} else if sp, ok := errorStr.(*string); ok {
			dg.Error = sp
		}
	}
	if attempts, ok := fields["attempts"].(int); ok {
		dg.Attempts = attempts
	}
	if updatedAt, ok := fields["updated_at"].(int64); ok {
		dg.UpdatedAt = updatedAt
	}

	return d.UpdateDigest(ctx, dg)
}

// GetFilesWithPendingDigests returns file paths that have pending or failed digests
// Only returns inbox files - library files don't get auto-digested
func (d *DB) GetFilesWithPendingDigests() []string {
	query := `
		SELECT DISTINCT d.file_path
		FROM digests d
		INNER JOIN files f ON f.path = d.file_path
		WHERE d.status IN ('todo', 'failed')
		  AND d.attempts < 3
		  AND (d.file_path = 'inbox' OR d.file_path LIKE 'inbox/%')
		ORDER BY d.created_at ASC
		LIMIT 100
	`

	rows, err := d.conn.Query(query)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			continue
		}
		paths = append(paths, path)
	}

	return paths
}
