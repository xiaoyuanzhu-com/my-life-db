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
      const response = await fetch('/api/system/oauth/refresh', {
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
 * Delegate token refresh to the native app via the WKScriptMessageHandlerWithReply
 * named "native". The native side awaits AuthManager.refreshAccessToken(),
 * pushes fresh cookies into the WebView, and resolves the Promise with
 * { success: true/false, accessToken?: string }.
 */
async function refreshViaNativeBridge(): Promise<boolean> {
  try {
    const result = await (window as any).webkit?.messageHandlers?.native?.postMessage({
      action: 'requestTokenRefresh',
    });

    if (result?.success) {
      // Update the access token for subsequent Authorization header injection
      if (result.accessToken) {
        (window as any).__nativeAccessToken = result.accessToken;
      }
      console.log('✅ Token refreshed via native bridge');
      return true;
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

  // In native app context, add Authorization header from native-injected token.
  // This bypasses WebPage cookie issues — the backend prefers Bearer over cookies.
  const w = window as any;
  if (w.isNativeApp && w.__nativeAccessToken) {
    const headers = new Headers(fetchOptions.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${w.__nativeAccessToken}`);
    }
    fetchOptions.headers = headers;
  }

  // Make the initial request
  let response = await fetch(input, fetchOptions);

  // If we get a 401, try to refresh the token
  if (response.status === 401) {
    console.log('🔄 Got 401, attempting token refresh...');

    const refreshed = await refreshAccessToken();

    if (refreshed) {
      // Retry with fresh token (refreshViaNativeBridge updates __nativeAccessToken)
      if (w.isNativeApp && w.__nativeAccessToken) {
        const headers = new Headers(fetchOptions.headers);
        headers.set('Authorization', `Bearer ${w.__nativeAccessToken}`);
        fetchOptions.headers = headers;
      }
      response = await fetch(input, fetchOptions);
    }
  }

  return response;
}
