/**
 * Authenticated fetch wrapper
 * Automatically adds Bearer token from localStorage to all API requests
 */

export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const accessToken = localStorage.getItem('access_token');

  const headers = new Headers(init?.headers);
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  return fetch(input, {
    ...init,
    headers,
  });
}
