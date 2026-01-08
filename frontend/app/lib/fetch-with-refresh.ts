/**
 * Fetch wrapper that automatically refreshes tokens on 401
 *
 * Usage: Use this instead of plain fetch() for API calls that need auth
 */

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

/**
 * Attempt to refresh the access token using the refresh token
 */
async function refreshAccessToken(): Promise<boolean> {
  // If already refreshing, wait for that to complete
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }

  isRefreshing = true;
  refreshPromise = (async () => {
    try {
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
