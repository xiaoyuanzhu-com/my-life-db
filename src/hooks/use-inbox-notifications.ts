// React hook for real-time inbox notifications
'use client';

import { useEffect, useRef, useCallback } from 'react';

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
 * Hook for real-time inbox notifications via Server-Sent Events
 *
 * Features:
 * - Automatic SSE connection to /api/notifications/stream
 * - Automatic reconnection on connection loss
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

  // Connect to SSE stream
  const connect = useCallback(() => {
    if (!enabled) return;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource('/api/notifications/stream');
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle connection confirmation
        if (data.type === 'connected') {
          return;
        }

        // Trigger refresh on any notification event
        onInboxChange();
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
  }, [enabled, onInboxChange]);

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
    };
  }, [enabled, connect]);
}
