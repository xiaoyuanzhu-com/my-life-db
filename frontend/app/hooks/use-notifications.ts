// Unified notification hook - shares a single SSE connection
// Replaces use-inbox-notifications and use-preview-notifications

import { useEffect, useRef, useCallback, useMemo } from 'react';

// Singleton EventSource connection (shared across all hook instances)
let sharedEventSource: EventSource | null = null;
let connectionRefCount = 0;
let reconnectTimeout: NodeJS.Timeout | null = null;

// Event listeners registry
const listeners: Set<(event: MessageEvent) => void> = new Set();

// Debounce delay for batching rapid notifications
const DEBOUNCE_MS = 200;

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
 * Connect to SSE stream (shared across all hooks)
 */
function connectToNotifications() {
  if (sharedEventSource) {
    return; // Already connected
  }

  const accessToken = localStorage.getItem('access_token');
  let url = '/api/notifications/stream';
  if (accessToken) {
    url += `?token=${encodeURIComponent(accessToken)}`;
  }

  const eventSource = new EventSource(url);
  sharedEventSource = eventSource;

  eventSource.onmessage = (event) => {
    // Broadcast to all listeners
    listeners.forEach(listener => listener(event));
  };

  eventSource.onerror = () => {
    disconnectFromNotifications();

    // Attempt reconnection after 5 seconds (only if there are active listeners)
    if (connectionRefCount > 0) {
      reconnectTimeout = setTimeout(() => {
        connectToNotifications();
      }, 5000);
    }
  };
}

/**
 * Disconnect from SSE stream
 */
function disconnectFromNotifications() {
  if (sharedEventSource) {
    sharedEventSource.close();
    sharedEventSource = null;
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

/**
 * Subscribe to notifications
 */
function subscribe(listener: (event: MessageEvent) => void) {
  listeners.add(listener);
  connectionRefCount++;

  // Connect if this is the first subscriber
  if (connectionRefCount === 1) {
    connectToNotifications();
  }

  // Return unsubscribe function
  return () => {
    listeners.delete(listener);
    connectionRefCount--;

    // Disconnect if no more subscribers
    if (connectionRefCount === 0) {
      disconnectFromNotifications();
    }
  };
}

/**
 * Force reconnect (used by visibility change handler)
 */
function reconnect() {
  if (connectionRefCount > 0) {
    disconnectFromNotifications();
    connectToNotifications();
  }
}

// Handle page visibility changes globally
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reconnect();
    }
  });
}

// ============================================================================
// Public hooks
// ============================================================================

interface UseInboxNotificationsOptions {
  onInboxChange: () => void;
  enabled?: boolean;
}

/**
 * Hook for inbox change notifications
 */
export function useInboxNotifications(options: UseInboxNotificationsOptions) {
  const { onInboxChange, enabled = true } = options;

  // Debounce the callback to batch rapid notifications
  const debouncedOnChange = useMemo(
    () => debounce(onInboxChange, DEBOUNCE_MS),
    [onInboxChange]
  );

  const listenerRef = useRef<((event: MessageEvent) => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // Create listener
    const listener = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        // Ignore connection confirmation
        if (data.type === 'connected') {
          return;
        }

        // Trigger debounced refresh on any notification event
        debouncedOnChange();
      } catch {
        // Silently ignore parse errors
      }
    };

    listenerRef.current = listener;

    // Subscribe
    const unsubscribe = subscribe(listener);

    // Cleanup
    return () => {
      unsubscribe();
      debouncedOnChange.cancel();
    };
  }, [enabled, debouncedOnChange]);
}

interface UsePreviewNotificationsOptions {
  onPreviewUpdated: (filePath: string, previewType: string) => void;
  enabled?: boolean;
}

/**
 * Hook for preview update notifications
 */
export function usePreviewNotifications(options: UsePreviewNotificationsOptions) {
  const { onPreviewUpdated, enabled = true } = options;

  const listenerRef = useRef<((event: MessageEvent) => void) | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // Create listener
    const listener = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        // Ignore connection confirmation
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

    listenerRef.current = listener;

    // Subscribe
    const unsubscribe = subscribe(listener);

    // Cleanup
    return () => {
      unsubscribe();
    };
  }, [enabled, onPreviewUpdated]);
}
