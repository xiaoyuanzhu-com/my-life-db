// React hook for real-time preview notifications (unified for all preview types)

import { useEffect, useRef, useCallback } from 'react';

interface PreviewNotificationEvent {
  type: string;
  path: string;
  data?: {
    previewType?: string; // 'text', 'image', 'screenshot'
  };
}

interface UsePreviewNotificationsOptions {
  /**
   * Callback when a preview is updated for a file
   * @param filePath - The path of the file whose preview was updated
   * @param previewType - The type of preview ('text', 'image', 'screenshot')
   */
  onPreviewUpdated: (filePath: string, previewType: string) => void;

  /**
   * Whether to enable the hook
   * @default true
   */
  enabled?: boolean;
}

/**
 * Hook for real-time preview notifications via Server-Sent Events
 *
 * Listens for preview-updated events for all preview types:
 * - text: Text file previews extracted by filesystem watcher
 * - image: HEIC → JPEG conversions
 * - screenshot: PDF, EPUB, URL screenshots
 *
 * This provides a better UX by auto-refreshing when previews complete processing.
 *
 * @example
 * ```tsx
 * usePreviewNotifications({
 *   onPreviewUpdated: (filePath, previewType) => {
 *     console.log(`Preview ready for ${filePath}: ${previewType}`);
 *     // Refresh the feed or specific file
 *     refetch();
 *   },
 * });
 * ```
 */
export function usePreviewNotifications(options: UsePreviewNotificationsOptions) {
  const { onPreviewUpdated, enabled = true } = options;

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
        const data: PreviewNotificationEvent = JSON.parse(event.data);

        // Handle connection confirmation
        if (data.type === 'connected') {
          return;
        }

        // Listen for preview-updated events
        if (data.type === 'preview-updated' && data.path) {
          const previewType = data.data?.previewType || 'unknown';
          onPreviewUpdated(data.path, previewType);
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
  }, [enabled, onPreviewUpdated]);

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
