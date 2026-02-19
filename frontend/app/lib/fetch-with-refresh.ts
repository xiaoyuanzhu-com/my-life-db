/**
 * Fetch wrapper that automatically refreshes tokens on 401
 *
 * Usage: Use this instead of plain fetch() for API calls that need auth
 *
 * In native app context (WebView), refresh is delegated to the native
 * AuthManager via the bridge. The native side is the single auth owner;
 * it refreshes tokens, updates the Keychain, and pushes fresh cookies
 * back into the WebView. This avoids dual-writer race conditions.
 */

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

/**
 * Attempt to refresh the access token.
 * - Native WebView: delegates to native bridge (requestTokenRefresh)
 * - Web browser: cookie-based POST to /api/oauth/refresh
 * Exported for use by WebSocket reconnection logic
 */
export async function refreshAccessToken(): Promise<boolean> {
  // If already refreshing, wait for that to complete
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }

  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      // In native app context, delegate refresh to native via bridge
      if ((window as any).isNativeApp) {
        return await refreshViaNativeBridge();
      }

      // Web: cookie-based refresh
      const response = await fetch('/api/oauth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });

      if (response.ok) {
        console.log('✅ Token refreshed successfully');
        return true;
      }

      console.error('❌ Token refresh failed:', response.status);
      return false;
    } catch (error) {
      console.error('❌ Token refresh error:', error);
      return false;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Delegate token refresh to the native app via the bridge URL scheme.
 * The native side awaits AuthManager.refreshAccessToken(), pushes fresh
 * cookies into the WebView, and returns { success: true/false }.
 */
async function refreshViaNativeBridge(): Promise<boolean> {
  try {
    const response = await fetch('nativebridge://message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'requestTokenRefresh' }),
    });

    if (response.ok) {
      const result = await response.json();
      if (result.success) {
        console.log('✅ Token refreshed via native bridge');
        return true;
      }
    }

    console.error('❌ Native bridge token refresh failed');
    return false;
  } catch (error) {
    console.error('❌ Native bridge token refresh error:', error);
    return false;
  }
}

/**
 * Fetch wrapper that automatically refreshes tokens on 401 errors
 *
 * @param input - URL or Request object
 * @param init - Fetch options
 * @returns Response
 */
export async function fetchWithRefresh(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  // Ensure credentials are included
  const fetchOptions: RequestInit = {
    ...init,
    credentials: 'same-origin',
  };

  // Make the initial request
  let response = await fetch(input, fetchOptions);

  // If we get a 401, try to refresh the token
  if (response.status === 401) {
    console.log('🔄 Got 401, attempting token refresh...');

    const refreshed = await refreshAccessToken();

    if (refreshed) {
      // Retry the original request with the new token
      console.log('🔄 Retrying original request with new token...');
      response = await fetch(input, fetchOptions);
    } else {
      // Refresh failed - return 401 and let UI handle it (show login button)
      console.log('❌ Token refresh failed, returning 401');
      // Return the 401 response - components will check isAuthenticated and show login UI
    }
  }

  return response;
}
