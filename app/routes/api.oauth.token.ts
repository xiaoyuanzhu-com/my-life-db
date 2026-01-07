/**
 * OAuth Token Endpoint (for iOS app)
 * Exchanges authorization code for JWT tokens
 */

import type { ActionFunctionArgs } from 'react-router';
import * as oauth from 'oauth4webapi';
import { getOAuthConfig, isOAuthEnabled } from '~/.server/auth/oauth-config';
import { validateJWT, getUsernameFromPayload, verifyExpectedUsername } from '~/.server/auth/jwt-validator';

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  // Check if OAuth is enabled
  if (!isOAuthEnabled()) {
    return Response.json(
      { error: 'OAuth is not enabled' },
      { status: 400 }
    );
  }

  try {
    const config = getOAuthConfig();
    const body = await request.json();
    const { code, redirect_uri } = body;

    if (!code) {
      return Response.json(
        { error: 'Missing authorization code' },
        { status: 400 }
      );
    }

    // OAuth client configuration
    const client: oauth.Client = {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      token_endpoint_auth_method: 'client_secret_post',
    };

    // Discover OAuth server metadata
    const issuer = new URL(config.issuerUrl);
    const authServer = await oauth.discoveryRequest(issuer).then((response) =>
      oauth.processDiscoveryResponse(issuer, response)
    );

    if (!authServer.token_endpoint) {
      throw new Error('OAuth server metadata missing token_endpoint');
    }

    // Exchange authorization code for tokens
    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('redirect_uri', redirect_uri || config.redirectUri);
    params.set('client_id', config.clientId);
    params.set('client_secret', config.clientSecret);

    const response = await oauth.authorizationCodeGrantRequest(
      authServer,
      client,
      params
    );

    const result = await oauth.processAuthorizationCodeOpenIDResponse(
      authServer,
      client,
      response
    );

    if (oauth.isOAuth2Error(result)) {
      throw new Error(`OAuth error: ${result.error} - ${result.error_description}`);
    }

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

    // Return tokens to client
    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: result.expires_in,
      username,
    });
  } catch (error) {
    console.error('OAuth token error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Token exchange failed' },
      { status: 500 }
    );
  }
}
