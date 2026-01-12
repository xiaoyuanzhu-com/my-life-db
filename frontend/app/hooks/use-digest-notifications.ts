// React hook for real-time digest notifications (preview-ready events)

import { useEffect, useRef, useCallback } from 'react';

interface DigestNotificationEvent {
  type: string;
  path: string;
  data?: {
    digester?: string;
    type?: string;
  };
}

interface UseDigestNotificationsOptions {
  /**
   * Callback when a preview becomes ready for a file
   * @param filePath - The path of the file whose preview is ready
   */
  onPreviewReady: (filePath: string) => void;

  /**
   * Whether to enable the hook
   * @default true
   */
  enabled?: boolean;
}

/**
 * Hook for real-time digest notifications via Server-Sent Events
 *
 * Listens for preview-ready events and triggers callback to refresh file data.
 * This provides a better UX by auto-refreshing when previews (HEIC conversions,
 * doc screenshots, URL screenshots) complete processing.
 *
 * @example
 * ```tsx
 * useDigestNotifications({
 *   onPreviewReady: (filePath) => {
 *     // Refresh only the specific file that got a preview
 *     queryClient.invalidateQueries(['file', filePath]);
 *   },
 * });
 * ```
 */
export function useDigestNotifications(options: UseDigestNotificationsOptions) {
  const { onPreviewReady, enabled = true } = options;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Connect to SSE stream
  const connect = useCallback(() => {
    if (!enabled) return;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // EventSource automatically sends cookies (primary auth method for web)
    const accessToken = localStorage.getItem('access_token');

    let url = '/api/notifications/stream';
    if (accessToken) {
      url += `?token=${encodeURIComponent(accessToken)}`;
    }

    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data: DigestNotificationEvent = JSON.parse(event.data);

        // Handle connection confirmation
        if (data.type === 'connected') {
          return;
        }

        // Listen for digest-update events with type=preview-ready
        if (
          data.type === 'digest-update' &&
          data.data?.type === 'preview-ready' &&
          data.path
        ) {
          onPreviewReady(data.path);
        }
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
  }, [enabled, onPreviewReady]);

  // Handle page visibility changes (critical for mobile/PWA)
  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      // When page becomes visible, reconnect to ensure fresh connection
      if (document.visibilityState === 'visible') {
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
    };
  }, [enabled, connect]);
}
