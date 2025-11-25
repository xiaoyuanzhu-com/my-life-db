// Session management functions
import 'server-only';
import { dbRun, dbSelectOne } from './client';
import { randomBytes } from 'crypto';

export interface Session {
  token: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
}

const ONE_YEAR_IN_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Create a new session token
 */
export function createSession(): Session {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ONE_YEAR_IN_MS);

  const session: Session = {
    token,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    last_used_at: now.toISOString(),
  };

  dbRun(
    `
      INSERT INTO sessions (token, created_at, expires_at, last_used_at)
      VALUES (?, ?, ?, ?)
    `,
    [session.token, session.created_at, session.expires_at, session.last_used_at]
  );

  return session;
}

/**
 * Validate a session token
 * Returns the session if valid, null if invalid or expired
 */
export function validateSession(token: string): Session | null {
  const session = dbSelectOne<Session>(
    `
      SELECT token, created_at, expires_at, last_used_at
      FROM sessions
      WHERE token = ?
    `,
    [token]
  );

  if (!session) {
    return null;
  }

  // Check if session is expired
  const now = new Date();
  const expiresAt = new Date(session.expires_at);

  if (now > expiresAt) {
    // Delete expired session
    deleteSession(token);
    return null;
  }

  // Update last used timestamp
  dbRun(
    `
      UPDATE sessions
      SET last_used_at = ?
      WHERE token = ?
    `,
    [now.toISOString(), token]
  );

  return {
    ...session,
    last_used_at: now.toISOString(),
  };
}

/**
 * Delete a session
 */
export function deleteSession(token: string): void {
  dbRun('DELETE FROM sessions WHERE token = ?', [token]);
}

/**
 * Delete all expired sessions (cleanup)
 */
export function deleteExpiredSessions(): number {
  const now = new Date().toISOString();

  const result = dbRun(
    `
      DELETE FROM sessions
      WHERE expires_at < ?
    `,
    [now]
  );

  return result.changes;
}

/**
 * Verify password (from environment variable)
 */
export function verifyPassword(password: string): boolean {
  const correctPassword = process.env.MLD_PASSWORD;

  if (!correctPassword || correctPassword.trim() === '') {
    throw new Error('MLD_PASSWORD environment variable is not set');
  }

  return password === correctPassword;
}
