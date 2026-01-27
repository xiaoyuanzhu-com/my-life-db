/**
 * Global API client with automatic token refresh
 *
 * Usage:
 *   import { api } from '~/lib/api';
 *
 *   // GET request
 *   const res = await api.get('/api/settings');
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
