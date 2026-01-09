// React hook for real-time inbox notifications

import { useEffect, useRef, useCallback, useMemo } from 'react';

// Debounce delay for batching rapid notifications
const DEBOUNCE_MS = 200;

interface UseInboxNotificationsOptions {
  /**
   * Callback when inbox changes (triggers refresh)
   */
  onInboxChange: () => void;

  /**
   * Whether to enable the hook
   * @default true
   */
  enabled?: boolean;
}

/**
 * Simple debounce function
 */
function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): { (...args: Parameters<T>): void; cancel: () => void } {
  let timeoutId: NodeJS.Timeout | null = null;

  const debounced = (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, delay);
  };

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return debounced;
}

/**
 * Hook for real-time inbox notifications via Server-Sent Events
 *
 * Features:
 * - Automatic SSE connection to /api/notifications/stream
 * - Automatic reconnection on connection loss
 * - Page visibility detection (reconnects when page becomes visible)
 * - Mobile/PWA optimized for background/foreground transitions
 * - Debounced callback to batch rapid notifications (200ms)
 * - Triggers callback when inbox changes
 *
 * @example
 * ```tsx
 * useInboxNotifications({
 *   onInboxChange: () => setRefreshTrigger(prev => prev + 1),
 * });
 * ```
 */
export function useInboxNotifications(options: UseInboxNotificationsOptions) {
  const {
    onInboxChange,
    enabled = true,
  } = options;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Debounce the callback to batch rapid notifications
  const debouncedOnChange = useMemo(
    () => debounce(onInboxChange, DEBOUNCE_MS),
    [onInboxChange]
  );

  // Connect to SSE stream
  const connect = useCallback(() => {
    if (!enabled) return;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // EventSource automatically sends cookies (primary auth method for web)
    // For backward compatibility (mobile apps, debugging), also support query param
    const accessToken = localStorage.getItem('access_token');

    // Prefer cookie-based auth (sent automatically by browser)
    // Fallback to query param if localStorage token exists (mobile/debugging)
    let url = '/api/notifications/stream';
    if (accessToken) {
      url += `?token=${encodeURIComponent(accessToken)}`;
    }

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle connection confirmation
        if (data.type === 'connected') {
          return;
        }

        // Trigger debounced refresh on any notification event
        debouncedOnChange();
      } catch {
        // Silently ignore parse errors
      }
    };

    eventSource.onerror = () => {
      eventSource.close();

      // Attempt reconnection after 5 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 5000);
    };
  }, [enabled, debouncedOnChange]);

  // Handle page visibility changes (critical for mobile/PWA)
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      // When page becomes visible, reconnect to ensure fresh data
      if (document.visibilityState === 'visible') {
        // Check if connection is stale by closing and reconnecting
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
        }
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, connect]);

  // Setup connection
  useEffect(() => {
    if (!enabled) return;

    connect();

    // Cleanup
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      // Cancel any pending debounced calls
      debouncedOnChange.cancel();
    };
  }, [enabled, connect, debouncedOnChange]);
}
