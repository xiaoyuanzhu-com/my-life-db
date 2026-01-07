/**
 * Authentication Middleware
 * Validates requests based on configured auth mode
 */

import { getAuthMode, isOAuthEnabled, isPasswordAuthEnabled } from './oauth-config';
import { validateJWT, getUsernameFromPayload, verifyExpectedUsername } from './jwt-validator';
import { verifySessionToken } from './edge-session';

export interface AuthResult {
  authenticated: boolean;
  username?: string;
  error?: string;
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Extract session token from cookies
 */
function extractSessionCookie(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');

  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(';').map(c => c.trim());
  const sessionCookie = cookies.find(c => c.startsWith('session='));

  if (!sessionCookie) {
    return null;
  }

  return sessionCookie.split('=')[1];
}

/**
 * Authenticate request based on current auth mode
 */
export async function authenticateRequest(request: Request): Promise<AuthResult> {
  const authMode = getAuthMode();

  // No auth required
  if (authMode === 'none') {
    return { authenticated: true };
  }

  // OAuth mode: validate JWT from Authorization header
  if (authMode === 'oauth') {
    const token = extractBearerToken(request);

    if (!token) {
      return {
        authenticated: false,
        error: 'Missing Authorization header',
      };
    }

    try {
      const payload = await validateJWT(token);
      const username = getUsernameFromPayload(payload);

      if (!verifyExpectedUsername(username)) {
        return {
          authenticated: false,
          error: 'Access denied for this user',
        };
      }

      return {
        authenticated: true,
        username,
      };
    } catch (error) {
      return {
        authenticated: false,
        error: error instanceof Error ? error.message : 'Invalid token',
      };
    }
  }

  // Password mode: validate session cookie
  if (authMode === 'password') {
    const sessionToken = extractSessionCookie(request);

    if (!sessionToken) {
      return {
        authenticated: false,
        error: 'No session cookie',
      };
    }

    try {
      const isValid = await verifySessionToken(sessionToken);

      if (!isValid) {
        return {
          authenticated: false,
          error: 'Invalid or expired session',
        };
      }

      return { authenticated: true };
    } catch (error) {
      return {
        authenticated: false,
        error: 'Session validation failed',
      };
    }
  }

  return {
    authenticated: false,
    error: 'Unknown auth mode',
  };
}

/**
 * Require authentication for a request
 * Returns null if authenticated, or an error Response if not
 */
export async function requireAuth(request: Request): Promise<Response | null> {
  const result = await authenticateRequest(request);

  if (!result.authenticated) {
    return Response.json(
      { error: result.error || 'Authentication required' },
      { status: 401 }
    );
  }

  return null;
}
