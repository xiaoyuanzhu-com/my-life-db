/**
 * OAuth Authorization Endpoint
 * Redirects user to OAuth provider's authorization page
 */

import type { LoaderFunctionArgs } from 'react-router';
import { getOAuthConfig, isOAuthEnabled } from '~/.server/auth/oauth-config';

export async function loader({ request }: LoaderFunctionArgs) {
  // Check if OAuth is enabled
  if (!isOAuthEnabled()) {
    return Response.json(
      { error: 'OAuth is not enabled' },
      { status: 400 }
    );
  }

  try {
    const config = getOAuthConfig();
    const url = new URL(request.url);
    
    // Get redirect_uri from query params (for iOS app custom scheme)
    const customRedirectUri = url.searchParams.get('redirect_uri');
    const redirectUri = customRedirectUri || config.redirectUri;

    // Build authorization URL
    // Ensure proper URL joining with trailing slash
    const baseUrl = config.issuerUrl.endsWith('/') ? config.issuerUrl : `${config.issuerUrl}/`;
    const authUrl = new URL(`${baseUrl}authorize/`);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email');
    
    // Add state parameter (optional, for CSRF protection)
    const state = crypto.randomUUID();
    authUrl.searchParams.set('state', state);

    // Redirect to OAuth provider
    return Response.redirect(authUrl.toString(), 302);
  } catch (error) {
    console.error('OAuth authorize error:', error);
    return Response.json(
      { error: 'Failed to initialize OAuth flow' },
      { status: 500 }
    );
  }
}
