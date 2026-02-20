package db

import (
	"database/sql"
	"time"
)

const (
	// SessionDuration is the default session lifetime (30 days)
	SessionDuration = 30 * 24 * time.Hour
)

// CreateSession creates a new session in the database
func CreateSession(id string) (*Session, error) {
	db := GetDB()
	now := NowMs()
	expiresAt := time.Now().Add(SessionDuration).UnixMilli()

	_, err := db.Exec(`
		INSERT INTO sessions (id, created_at, expires_at, last_used_at)
		VALUES (?, ?, ?, ?)
	`, id, now, expiresAt, now)
	if err != nil {
		return nil, err
	}

	return &Session{
		ID:         id,
		CreatedAt:  now,
		ExpiresAt:  expiresAt,
		LastUsedAt: now,
	}, nil
}

// GetSession retrieves a session by ID, returns nil if not found or expired
func GetSession(id string) (*Session, error) {
	db := GetDB()

	var s Session
	err := db.QueryRow(`
		SELECT id, created_at, expires_at, last_used_at
		FROM sessions
		WHERE id = ? AND expires_at > ?
	`, id, NowMs()).Scan(&s.ID, &s.CreatedAt, &s.ExpiresAt, &s.LastUsedAt)

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	return &s, nil
}

// TouchSession updates the last_used_at timestamp for a session
func TouchSession(id string) error {
	db := GetDB()

	_, err := db.Exec(`
		UPDATE sessions
		SET last_used_at = ?
		WHERE id = ?
	`, NowMs(), id)

	return err
}

// DeleteSession removes a session from the database
func DeleteSession(id string) error {
	db := GetDB()

	_, err := db.Exec(`DELETE FROM sessions WHERE id = ?`, id)
	return err
}

// DeleteExpiredSessions removes all expired sessions
func DeleteExpiredSessions() (int64, error) {
	db := GetDB()

	result, err := db.Exec(`DELETE FROM sessions WHERE expires_at <= ?`, NowMs())
	if err != nil {
		return 0, err
	}

	return result.RowsAffected()
}

// ExtendSession extends the expiration time of a session
func ExtendSession(id string) error {
	db := GetDB()
	expiresAt := time.Now().Add(SessionDuration).UnixMilli()

	_, err := db.Exec(`
		UPDATE sessions
		SET expires_at = ?, last_used_at = ?
		WHERE id = ?
	`, expiresAt, NowMs(), id)

	return err
}
