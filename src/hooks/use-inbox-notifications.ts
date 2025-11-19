// React hook for real-time inbox notifications
'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { NotificationEvent } from '@/lib/notifications/notification-service';

interface UseInboxNotificationsOptions {
  /**
   * Callback when inbox changes (triggers refresh)
   */
  onInboxChange: () => void;

  /**
   * Whether to show browser notifications
   * @default true
   */
  enableBrowserNotifications?: boolean;

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
 * - Browser notifications for inbox changes
 * - Automatic reconnection on connection loss
 * - Requests notification permission on mount
 *
 * @example
 * ```tsx
 * useInboxNotifications({
 *   onInboxChange: () => setRefreshTrigger(prev => prev + 1),
 *   enableBrowserNotifications: true,
 * });
 * ```
 */
export function useInboxNotifications(options: UseInboxNotificationsOptions) {
  const {
    onInboxChange,
    enableBrowserNotifications = true,
    enabled = true,
  } = options;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasPermissionRef = useRef(false);

  // Request notification permission
  useEffect(() => {
    if (!enableBrowserNotifications) return;

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((permission) => {
        hasPermissionRef.current = permission === 'granted';
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      hasPermissionRef.current = true;
    }
  }, [enableBrowserNotifications]);

  // Show browser notification
  const showNotification = useCallback((event: NotificationEvent) => {
    if (!enableBrowserNotifications || !hasPermissionRef.current) return;

    const { type, metadata } = event;

    let title = 'Inbox Updated';
    let body = 'New item in inbox';

    if (type === 'inbox-created' && metadata?.name) {
      title = 'New Inbox Item';
      body = `${metadata.name}`;

      // Add file size if available
      if (metadata.size) {
        const sizeKB = Math.round(metadata.size / 1024);
        body += ` (${sizeKB} KB)`;
      }
    } else if (type === 'inbox-updated') {
      title = 'Inbox Item Updated';
      body = metadata?.name || 'Item was updated';
    } else if (type === 'inbox-deleted') {
      title = 'Inbox Item Deleted';
      body = metadata?.name || 'Item was deleted';
    }

    new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: 'inbox-notification',
      renotify: false,
    });
  }, [enableBrowserNotifications]);

  // Connect to SSE stream
  const connect = useCallback(() => {
    if (!enabled) return;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    console.log('[Notifications] Connecting to SSE stream...');

    const eventSource = new EventSource('/api/notifications/stream');
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      console.log('[Notifications] SSE connection established');
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle connection confirmation
        if (data.type === 'connected') {
          console.log('[Notifications] Connected to notification stream');
          return;
        }

        // Handle notification events
        const notificationEvent = data as NotificationEvent;
        console.log('[Notifications] Received event:', notificationEvent);

        // Trigger refresh
        onInboxChange();

        // Show browser notification
        showNotification(notificationEvent);
      } catch (error) {
        console.error('[Notifications] Failed to parse event:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('[Notifications] SSE error:', error);
      eventSource.close();

      // Attempt reconnection after 5 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        console.log('[Notifications] Attempting to reconnect...');
        connect();
      }, 5000);
    };
  }, [enabled, onInboxChange, showNotification]);

  // Setup connection
  useEffect(() => {
    if (!enabled) return;

    connect();

    // Cleanup
    return () => {
      if (eventSourceRef.current) {
        console.log('[Notifications] Closing SSE connection');
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
