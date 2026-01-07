/**
 * JWT Validation
 * Validates JWT tokens from OAuth provider using JWKS
 */

import * as jose from 'jose';
import { getOAuthConfig } from './oauth-config';

export interface JWTPayload {
  sub: string;
  email?: string;
  preferred_username?: string;
  [key: string]: unknown;
}

let jwksCache: jose.JWTVerifyGetKey | null = null;

/**
 * Get or create JWKS verifier
 */
function getJWKS(): jose.JWTVerifyGetKey {
  if (jwksCache) {
    return jwksCache;
  }

  const config = getOAuthConfig();
  const JWKS = jose.createRemoteJWKSet(new URL(config.jwksUrl));
  jwksCache = JWKS;
  
  return JWKS;
}

/**
 * Validate JWT token
 * Returns payload if valid, throws if invalid
 */
export async function validateJWT(token: string): Promise<JWTPayload> {
  const config = getOAuthConfig();
  const JWKS = getJWKS();

  try {
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: config.issuerUrl,
      audience: config.clientId,
    });

    return payload as JWTPayload;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`JWT validation failed: ${error.message}`);
    }
    throw new Error('JWT validation failed');
  }
}

/**
 * Extract username from JWT payload
 */
export function getUsernameFromPayload(payload: JWTPayload): string {
  // Try preferred_username first (standard OIDC claim)
  if (payload.preferred_username && typeof payload.preferred_username === 'string') {
    return payload.preferred_username;
  }

  // Fallback to extracting from email
  if (payload.email && typeof payload.email === 'string') {
    const emailParts = payload.email.split('@');
    return emailParts[0];
  }

  // Last resort: use sub
  return payload.sub;
}

/**
 * Verify that username matches expected username (for single-user instances)
 */
export function verifyExpectedUsername(username: string): boolean {
  const config = getOAuthConfig();
  
  // If no expected username is configured, accept any username
  if (!config.expectedUsername) {
    return true;
  }

  return username === config.expectedUsername;
}
