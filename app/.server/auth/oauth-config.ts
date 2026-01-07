/**
 * OAuth Configuration
 * Handles OAuth/OIDC authentication configuration
 */

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  issuerUrl: string;
  redirectUri: string;
  jwksUrl: string;
  expectedUsername?: string;
}

export type AuthMode = 'none' | 'password' | 'oauth';

/**
 * Get current authentication mode from environment
 */
export function getAuthMode(): AuthMode {
  const mode = process.env.MLD_AUTH_MODE?.toLowerCase() || 'none';
  
  if (!['none', 'password', 'oauth'].includes(mode)) {
    console.warn(`Invalid MLD_AUTH_MODE: ${mode}, defaulting to 'none'`);
    return 'none';
  }
  
  return mode as AuthMode;
}

/**
 * Check if OAuth is enabled
 */
export function isOAuthEnabled(): boolean {
  return getAuthMode() === 'oauth';
}

/**
 * Check if password auth is enabled
 */
export function isPasswordAuthEnabled(): boolean {
  return getAuthMode() === 'password';
}

/**
 * Check if any auth is required
 */
export function isAuthRequired(): boolean {
  return getAuthMode() !== 'none';
}

/**
 * Get OAuth configuration from environment
 * Throws if OAuth is enabled but config is incomplete
 */
export function getOAuthConfig(): OAuthConfig {
  const clientId = process.env.MLD_OAUTH_CLIENT_ID;
  const clientSecret = process.env.MLD_OAUTH_CLIENT_SECRET;
  const issuerUrl = process.env.MLD_OAUTH_ISSUER_URL;
  const redirectUri = process.env.MLD_OAUTH_REDIRECT_URI;
  const jwksUrl = process.env.MLD_OAUTH_JWKS_URL;
  const expectedUsername = process.env.MLD_EXPECTED_USERNAME;

  if (!clientId || !clientSecret || !issuerUrl || !redirectUri || !jwksUrl) {
    throw new Error(
      'OAuth configuration incomplete. Required: MLD_OAUTH_CLIENT_ID, MLD_OAUTH_CLIENT_SECRET, MLD_OAUTH_ISSUER_URL, MLD_OAUTH_REDIRECT_URI, MLD_OAUTH_JWKS_URL'
    );
  }

  return {
    clientId,
    clientSecret,
    issuerUrl,
    redirectUri,
    jwksUrl,
    expectedUsername,
  };
}
