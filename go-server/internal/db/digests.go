package db

import (
	"database/sql"

	"github.com/google/uuid"
)

// GetDigestByID retrieves a digest by ID
func GetDigestByID(id string) (*Digest, error) {
	query := `
		SELECT id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at
		FROM digests
		WHERE id = ?
	`

	row := GetDB().QueryRow(query, id)

	var d Digest
	var content, sqlarName, digestError sql.NullString

	err := row.Scan(
		&d.ID, &d.FilePath, &d.Digester, &d.Status, &content,
		&sqlarName, &digestError, &d.Attempts, &d.CreatedAt, &d.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	d.Content = StringPtr(content)
	d.SqlarName = StringPtr(sqlarName)
	d.Error = StringPtr(digestError)

	return &d, nil
}

// GetDigestsForFile retrieves all digests for a file
func GetDigestsForFile(filePath string) ([]Digest, error) {
	query := `
		SELECT id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at
		FROM digests
		WHERE file_path = ?
		ORDER BY digester
	`

	rows, err := GetDB().Query(query, filePath)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var digests []Digest
	for rows.Next() {
		var d Digest
		var content, sqlarName, digestError sql.NullString

		err := rows.Scan(
			&d.ID, &d.FilePath, &d.Digester, &d.Status, &content,
			&sqlarName, &digestError, &d.Attempts, &d.CreatedAt, &d.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}

		d.Content = StringPtr(content)
		d.SqlarName = StringPtr(sqlarName)
		d.Error = StringPtr(digestError)

		digests = append(digests, d)
	}

	return digests, nil
}

// GetDigestByFileAndDigester retrieves a specific digest
func GetDigestByFileAndDigester(filePath, digester string) (*Digest, error) {
	query := `
		SELECT id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at
		FROM digests
		WHERE file_path = ? AND digester = ?
	`

	row := GetDB().QueryRow(query, filePath, digester)

	var d Digest
	var content, sqlarName, digestError sql.NullString

	err := row.Scan(
		&d.ID, &d.FilePath, &d.Digester, &d.Status, &content,
		&sqlarName, &digestError, &d.Attempts, &d.CreatedAt, &d.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	d.Content = StringPtr(content)
	d.SqlarName = StringPtr(sqlarName)
	d.Error = StringPtr(digestError)

	return &d, nil
}

// CreateDigest creates a new digest record
func CreateDigest(d *Digest) error {
	if d.ID == "" {
		d.ID = uuid.New().String()
	}
	now := NowUTC()
	if d.CreatedAt == "" {
		d.CreatedAt = now
	}
	if d.UpdatedAt == "" {
		d.UpdatedAt = now
	}

	query := `
		INSERT INTO digests (id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`

	_, err := GetDB().Exec(query,
		d.ID, d.FilePath, d.Digester, d.Status, d.Content,
		d.SqlarName, d.Error, d.Attempts, d.CreatedAt, d.UpdatedAt,
	)
	return err
}

// UpdateDigest updates an existing digest
func UpdateDigest(d *Digest) error {
	d.UpdatedAt = NowUTC()

	query := `
		UPDATE digests
		SET status = ?, content = ?, sqlar_name = ?, error = ?, attempts = ?, updated_at = ?
		WHERE id = ?
	`

	_, err := GetDB().Exec(query,
		d.Status, d.Content, d.SqlarName, d.Error, d.Attempts, d.UpdatedAt, d.ID,
	)
	return err
}

// UpsertDigest creates or updates a digest
func UpsertDigest(d *Digest) error {
	now := NowUTC()
	if d.ID == "" {
		d.ID = GeneratePathHash(d.FilePath) + "-" + d.Digester
	}
	d.UpdatedAt = now

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

	_, err := GetDB().Exec(query,
		d.ID, d.FilePath, d.Digester, d.Status, d.Content,
		d.SqlarName, d.Error, d.Attempts, now, d.UpdatedAt,
	)
	return err
}

// DeleteDigest removes a digest
func DeleteDigest(id string) error {
	_, err := GetDB().Exec("DELETE FROM digests WHERE id = ?", id)
	return err
}

// DeleteDigestsForFile removes all digests for a file
func DeleteDigestsForFile(filePath string) error {
	_, err := GetDB().Exec("DELETE FROM digests WHERE file_path = ?", filePath)
	return err
}

// ResetDigesterAll resets all digests of a specific type
func ResetDigesterAll(digester string) (int64, error) {
	result, err := GetDB().Exec(`
		UPDATE digests
		SET status = 'todo', error = NULL, attempts = 0, updated_at = ?
		WHERE digester = ?
	`, NowUTC(), digester)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// GetDigestStats returns statistics about digests
func GetDigestStats() (map[string]interface{}, error) {
	stats := make(map[string]interface{})

	// Count by status
	rows, err := GetDB().Query(`
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
	rows, err = GetDB().Query(`
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
	err = GetDB().QueryRow("SELECT COUNT(*) FROM digests").Scan(&total)
	if err != nil {
		return nil, err
	}
	stats["total"] = total

	return stats, nil
}

// GetPendingDigests retrieves digests that need processing
func GetPendingDigests(limit int) ([]Digest, error) {
	query := `
		SELECT id, file_path, digester, status, content, sqlar_name, error, attempts, created_at, updated_at
		FROM digests
		WHERE status IN ('todo', 'failed')
		  AND attempts < 3
		ORDER BY created_at ASC
		LIMIT ?
	`

	rows, err := GetDB().Query(query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var digests []Digest
	for rows.Next() {
		var d Digest
		var content, sqlarName, digestError sql.NullString

		err := rows.Scan(
			&d.ID, &d.FilePath, &d.Digester, &d.Status, &content,
			&sqlarName, &digestError, &d.Attempts, &d.CreatedAt, &d.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}

		d.Content = StringPtr(content)
		d.SqlarName = StringPtr(sqlarName)
		d.Error = StringPtr(digestError)

		digests = append(digests, d)
	}

	return digests, nil
}

// GetDistinctDigesters returns all unique digester names
func GetDistinctDigesters() ([]string, error) {
	rows, err := GetDB().Query("SELECT DISTINCT digester FROM digests ORDER BY digester")
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
