/**
 * Global API client with automatic token refresh
 *
 * Usage:
 *   import { api } from '~/lib/api';
 *
 *   // GET request
 *   const res = await api.get('/api/system/settings');
 *   const data = await res.json();
 *
 *   // POST request
 *   const res = await api.post('/api/items', { name: 'test' });
 *
 *   // PUT request
 *   const res = await api.put('/api/items/123', { name: 'updated' });
 *
 *   // DELETE request
 *   const res = await api.delete('/api/items/123');
 *
 * All methods automatically:
 * - Include credentials (cookies)
 * - Refresh OAuth tokens on 401
 * - Retry the original request after refresh
 */

import { fetchWithRefresh } from './fetch-with-refresh';

/**
 * Encode a relative filesystem path for use as a URL segment.
 *
 * Splits on `/`, encodes each segment with encodeURIComponent, then rejoins
 * — so "journal/2026 spring/04.md" becomes "journal/2026%20spring/04.md".
 * Leading slash is stripped to keep the result append-friendly:
 *
 *   `/api/data/files/${encodePath(p)}`
 */
export function encodePath(path: string): string {
  return path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

export const api = {
  /**
   * Make a GET request
   */
  get: (url: string, init?: Omit<RequestInit, 'method'>) =>
    fetchWithRefresh(url, { ...init, method: 'GET' }),

  /**
   * Make a POST request with optional JSON body
   */
  post: (url: string, data?: unknown, init?: Omit<RequestInit, 'method' | 'body'>) =>
    fetchWithRefresh(url, {
      ...init,
      method: 'POST',
      headers: {
        ...(data !== undefined && { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),

  /**
   * Make a PUT request with JSON body
   */
  put: (url: string, data: unknown, init?: Omit<RequestInit, 'method' | 'body'>) =>
    fetchWithRefresh(url, {
      ...init,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      body: JSON.stringify(data),
    }),

  /**
   * Make a PATCH request with JSON body
   */
  patch: (url: string, data: unknown, init?: Omit<RequestInit, 'method' | 'body'>) =>
    fetchWithRefresh(url, {
      ...init,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      body: JSON.stringify(data),
    }),

  /**
   * Make a DELETE request
   */
  delete: (url: string, init?: Omit<RequestInit, 'method'>) =>
    fetchWithRefresh(url, { ...init, method: 'DELETE' }),

  /**
   * Make a custom request (for special cases like file uploads)
   * This is the underlying fetchWithRefresh for cases that need full control
   */
  fetch: fetchWithRefresh,
};
