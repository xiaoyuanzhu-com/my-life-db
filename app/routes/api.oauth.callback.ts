/**
 * OAuth Callback Endpoint
 * Handles OAuth authorization code exchange for tokens
 */

import type { LoaderFunctionArgs } from 'react-router';
import * as oauth from 'oauth4webapi';
import { getOAuthConfig, isOAuthEnabled } from '~/.server/auth/oauth-config';
import { validateJWT, getUsernameFromPayload, verifyExpectedUsername } from '~/.server/auth/jwt-validator';

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

    // OAuth client configuration
    const client: oauth.Client = {
      client_id: config.clientId,
      token_endpoint_auth_method: 'client_secret_post',
    };

    // Client authentication method
    const clientAuth = oauth.ClientSecretPost(config.clientSecret);

    // Discover OAuth server metadata
    const issuer = new URL(config.issuerUrl);
    const authServer = await oauth.discoveryRequest(issuer).then((response) =>
      oauth.processDiscoveryResponse(issuer, response)
    );

    if (!authServer.token_endpoint) {
      throw new Error('OAuth server metadata missing token_endpoint');
    }

    // Validate callback parameters (validates state, code, error params)
    // This will throw if there's an error parameter in the callback
    const params = oauth.validateAuthResponse(
      authServer,
      client,
      url.searchParams,
      oauth.skipStateCheck // We're not tracking state in this simple implementation
    );

    // Exchange authorization code for tokens
    const response = await oauth.authorizationCodeGrantRequest(
      authServer,
      client,
      clientAuth,
      params,
      config.redirectUri,
      oauth.nopkce // Not using PKCE
    );

    // Process the token response
    const result = await oauth.processAuthorizationCodeResponse(
      authServer,
      client,
      response
    );

    const accessToken = result.access_token;
    const refreshToken = result.refresh_token;

    // Validate JWT and extract username
    const payload = await validateJWT(accessToken);
    const username = getUsernameFromPayload(payload);

    // Verify username matches expected username (for single-user instances)
    if (!verifyExpectedUsername(username)) {
      return Response.json(
        { error: `Access denied. This instance is configured for user: ${config.expectedUsername}` },
        { status: 403 }
      );
    }

    // For web clients: store tokens in localStorage and redirect
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Authentication Successful</title>
</head>
<body>
  <script>
    // Store tokens in localStorage
    localStorage.setItem('access_token', '${accessToken}');
    ${refreshToken ? `localStorage.setItem('refresh_token', '${refreshToken}');` : ''}
    localStorage.setItem('username', '${username}');

    // Redirect to home page
    window.location.href = '/';
  </script>
  <p>Authentication successful. Redirecting...</p>
</body>
</html>
    `;

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  } catch (error) {
    console.error('OAuth callback error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'OAuth callback failed' },
      { status: 500 }
    );
  }
}
