/**
 * Get authorization headers with Bearer token from localStorage
 */
export function getAuthHeaders(): HeadersInit {
  const accessToken = localStorage.getItem('access_token');

  if (accessToken) {
    return {
      'Authorization': `Bearer ${accessToken}`,
    };
  }

  return {};
}
