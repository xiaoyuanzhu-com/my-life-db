// Unified notification hook - shares a single SSE connection
// Replaces use-inbox-notifications and use-preview-notifications

import { useEffect, useMemo } from 'react';
import { refreshAccessToken } from '~/lib/fetch-with-refresh';

// Singleton EventSource connection (shared across all hook instances)
let sharedEventSource: EventSource | null = null;
let connectionRefCount = 0;
let reconnectTimeout: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;

// Event listeners registry
const listeners: Set<(event: MessageEvent) => void> = new Set();

// Debounce delay for batching rapid notifications
const DEBOUNCE_MS = 200;

// Reconnect delay: exponential backoff starting at 5s, capping at 60s
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

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
 * Connect to SSE stream (shared across all hooks).
 * Uses cookie-based auth — the access_token cookie is sent automatically.
 */
function connectToNotifications() {
  if (sharedEventSource) {
    return; // Already connected
  }

  const eventSource = new EventSource('/api/notifications/stream');
  sharedEventSource = eventSource;

  eventSource.onopen = () => {
    // Connection succeeded — reset backoff
    consecutiveFailures = 0;

    // Notify all listeners that the SSE connection was (re)established.
    // Subscribers use this to refresh stale data — events may have been
    // missed during the disconnect (buffer overflow, network drop, sleep/wake).
    const reconnectEvent = new MessageEvent('message', {
      data: JSON.stringify({ type: 'sse-reconnected' }),
    });
    listeners.forEach(listener => listener(reconnectEvent));
  };

  eventSource.onmessage = (event) => {
    // Broadcast to all listeners
    listeners.forEach(listener => listener(event));
  };

  eventSource.onerror = () => {
    disconnectFromNotifications();

    if (connectionRefCount > 0) {
      // Exponential backoff: 5s, 10s, 20s, 40s, 60s, 60s, ...
      consecutiveFailures++;
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, consecutiveFailures - 1),
        RECONNECT_MAX_MS,
      );

      reconnectTimeout = setTimeout(async () => {
        try {
          await refreshAccessToken();
        } catch {
          // Refresh failed, but still try to reconnect — cookie may have been
          // updated by another tab or the native shell.
        }
        connectToNotifications();
      }, delay);
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
 * Force reconnect (used by visibility change handler).
 * Resets backoff since user explicitly returned to the page.
 */
function reconnect() {
  if (connectionRefCount > 0) {
    consecutiveFailures = 0;
    disconnectFromNotifications();
    connectToNotifications();
  }
}

// Handle page visibility changes globally
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      // After sleep/wake, token may have expired - try to refresh first
      try {
        await refreshAccessToken();
      } catch {
        // Refresh failed, but still try to reconnect
      }
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

    // Subscribe
    const unsubscribe = subscribe(listener);

    // Cleanup
    return () => {
      unsubscribe();
    };
  }, [enabled, onPreviewUpdated]);
}

interface UseLibraryNotificationsOptions {
  onLibraryChange: (path: string, operation: string) => void;
  enabled?: boolean;
}

/**
 * Hook for library change notifications (create, delete, rename, move, upload)
 */
export function useLibraryNotifications(options: UseLibraryNotificationsOptions) {
  const { onLibraryChange, enabled = true } = options;

  // Debounce the callback to batch rapid notifications
  const debouncedOnChange = useMemo(
    () => debounce((path: string, operation: string) => onLibraryChange(path, operation), DEBOUNCE_MS),
    [onLibraryChange]
  );

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

        // Listen for library-changed events
        if (data.type === 'library-changed') {
          const path = data.path || '';
          const operation = data.data?.operation || 'unknown';
          debouncedOnChange(path, operation);
        }
      } catch {
        // Silently ignore parse errors
      }
    };

    // Subscribe
    const unsubscribe = subscribe(listener);

    // Cleanup
    return () => {
      unsubscribe();
      debouncedOnChange.cancel();
    };
  }, [enabled, debouncedOnChange]);
}

interface UseClaudeSessionNotificationsOptions {
  onSessionUpdated: () => void;
  enabled?: boolean;
}

/**
 * Hook for Claude session update notifications.
 * Triggers when session metadata changes (title updates, new sessions, deletions).
 *
 * Debounced (200ms) to batch rapid SSE events — a single session creation can fire
 * 3-4 SSE events (created, JSONL write, title PATCH, isProcessing change). Without
 * debounce, each triggers a separate API call. The debounce is an efficiency measure;
 * correctness is handled by refreshSessions using authoritative replacement (not merge).
 *
 * Also triggers on SSE reconnection (sse-reconnected) to catch up on events that
 * may have been missed during disconnect (network drop, sleep/wake, buffer overflow).
 */
export function useClaudeSessionNotifications(options: UseClaudeSessionNotificationsOptions) {
  const { onSessionUpdated, enabled = true } = options;

  // Debounce the callback to batch rapid notifications (matches useInboxNotifications pattern)
  const debouncedOnSessionUpdated = useMemo(
    () => debounce(onSessionUpdated, DEBOUNCE_MS),
    [onSessionUpdated]
  );

  useEffect(() => {
    if (!enabled) return;

    const listener = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'claude-session-updated' || data.type === 'sse-reconnected') {
          debouncedOnSessionUpdated();
        }
      } catch {
        // Ignore parse errors
      }
    };

    const unsubscribe = subscribe(listener);
    return () => {
      unsubscribe();
      debouncedOnSessionUpdated.cancel();
    };
  }, [enabled, debouncedOnSessionUpdated]);
}
