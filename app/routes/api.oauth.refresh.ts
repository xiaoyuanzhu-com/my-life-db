/**
 * OAuth Token Refresh Endpoint
 * Exchanges refresh token for a new access token
 */

import type { ActionFunctionArgs } from 'react-router';
import * as oauth from 'oauth4webapi';
import { getOAuthConfig, isOAuthEnabled } from '~/.server/auth/oauth-config';
import { validateJWT, getUsernameFromPayload, verifyExpectedUsername } from '~/.server/auth/jwt-validator';

export async function action({ request }: ActionFunctionArgs) {
  // Only support POST
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  // Check if OAuth is enabled
  if (!isOAuthEnabled()) {
    return Response.json({ error: 'OAuth is not enabled' }, { status: 400 });
  }

  try {
    const config = getOAuthConfig();

    // Get refresh token from cookie
    const cookieHeader = request.headers.get('Cookie');
    const cookies: Record<string, string> = {};
    if (cookieHeader) {
      cookieHeader.split(';').forEach(cookie => {
        const [name, ...rest] = cookie.split('=');
        const value = rest.join('=').trim();
        if (name && value) {
          cookies[name.trim()] = decodeURIComponent(value);
        }
      });
    }

    const refreshToken = cookies.refresh_token;
    if (!refreshToken) {
      return Response.json(
        { error: 'No refresh token available' },
        { status: 401 }
      );
    }

    // OAuth client configuration
    const client: oauth.Client = {
      client_id: config.clientId,
      token_endpoint_auth_method: 'client_secret_post',
    };

    const clientAuth = oauth.ClientSecretPost(config.clientSecret);

    // Discover OAuth server metadata
    const issuer = new URL(config.issuerUrl);
    const authServer = await oauth.discoveryRequest(issuer).then((response) =>
      oauth.processDiscoveryResponse(issuer, response)
    );

    if (!authServer.token_endpoint) {
      throw new Error('OAuth server metadata missing token_endpoint');
    }

    // Exchange refresh token for new access token
    const response = await oauth.refreshTokenGrantRequest(
      authServer,
      client,
      clientAuth,
      refreshToken
    );

    const result = await oauth.processRefreshTokenResponse(
      authServer,
      client,
      response
    );

    const newAccessToken = result.access_token;
    const newRefreshToken = result.refresh_token; // May or may not get a new one

    // Validate the new JWT
    const payload = await validateJWT(newAccessToken);
    const username = getUsernameFromPayload(payload);

    // Verify username matches expected username
    if (!verifyExpectedUsername(username)) {
      return Response.json(
        { error: `Access denied. This instance is configured for user: ${config.expectedUsername}` },
        { status: 403 }
      );
    }

    // Set new access token cookie (and refresh token if renewed)
    const headers = new Headers();

    headers.append('Set-Cookie',
      `access_token=${newAccessToken}; ` +
      `HttpOnly; ` +
      `Secure; ` +
      `SameSite=Lax; ` +
      `Path=/; ` +
      `Max-Age=86400` // 24 hours
    );

    // If we got a new refresh token, update it
    if (newRefreshToken) {
      headers.append('Set-Cookie',
        `refresh_token=${newRefreshToken}; ` +
        `HttpOnly; ` +
        `Secure; ` +
        `SameSite=Lax; ` +
        `Path=/; ` +
        `Max-Age=2592000` // 30 days
      );
    }

    return Response.json(
      { success: true, message: 'Token refreshed successfully' },
      { headers }
    );
  } catch (error) {
    console.error('Token refresh error:', error);

    // If refresh fails, clear cookies and require re-login
    const headers = new Headers();
    headers.append('Set-Cookie', 'access_token=; Max-Age=0; Path=/');
    headers.append('Set-Cookie', 'refresh_token=; Max-Age=0; Path=/');
    headers.append('Set-Cookie', 'username=; Max-Age=0; Path=/');

    return Response.json(
      { error: 'Token refresh failed. Please login again.' },
      { status: 401, headers }
    );
  }
}
