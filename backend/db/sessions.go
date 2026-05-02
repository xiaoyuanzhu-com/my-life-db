package db

import (
	"context"
	"database/sql"
	"time"
)

const (
	// SessionDuration is the default session lifetime (30 days)
	SessionDuration = 30 * 24 * time.Hour
)

// CreateSession creates a new session in the database
func (d *DB) CreateSession(ctx context.Context, id string) (*Session, error) {
	now := NowMs()
	expiresAt := time.Now().Add(SessionDuration).UnixMilli()

	if err := d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`
			INSERT INTO sessions (id, created_at, expires_at, last_used_at)
			VALUES (?, ?, ?, ?)
		`, id, now, expiresAt, now)
		return err
	}); err != nil {
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
func (d *DB) GetSession(id string) (*Session, error) {
	var s Session
	err := d.conn.QueryRow(`
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
func (d *DB) TouchSession(ctx context.Context, id string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`
			UPDATE sessions
			SET last_used_at = ?
			WHERE id = ?
		`, NowMs(), id)
		return err
	})
}

// DeleteSession removes a session from the database
func (d *DB) DeleteSession(ctx context.Context, id string) error {
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM sessions WHERE id = ?`, id)
		return err
	})
}

// DeleteExpiredSessions removes all expired sessions
func (d *DB) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	var affected int64
	err := d.Write(ctx, func(tx *sql.Tx) error {
		result, err := tx.Exec(`DELETE FROM sessions WHERE expires_at <= ?`, NowMs())
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

// ExtendSession extends the expiration time of a session
func (d *DB) ExtendSession(ctx context.Context, id string) error {
	expiresAt := time.Now().Add(SessionDuration).UnixMilli()
	return d.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`
			UPDATE sessions
			SET expires_at = ?, last_used_at = ?
			WHERE id = ?
		`, expiresAt, NowMs(), id)
		return err
	})
}
