// Notification service for broadcasting real-time events
// Uses in-memory EventEmitter for server-side pub/sub
import { EventEmitter } from 'events';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'NotificationService' });

// Notification event types
export type NotificationEventType =
  | 'inbox-created'
  | 'inbox-updated'
  | 'inbox-deleted';

// Notification payload structure
export interface NotificationEvent {
  type: NotificationEventType;
  path: string;
  timestamp: string;
  metadata?: {
    name?: string;
    size?: number;
    mimeType?: string;
  };
}

// Declare global type for HMR persistence
declare global {
  var __mylifedb_notification_service: NotificationService | undefined;
}

/**
 * Singleton notification service
 * Broadcasts events to all connected SSE clients
 */
class NotificationService extends EventEmitter {
  private constructor() {
    super();
    // Increase max listeners (default is 10, but we expect many SSE connections)
    this.setMaxListeners(100);
  }

  static getInstance(): NotificationService {
    // Use globalThis to persist across HMR reloads and module contexts
    if (!globalThis.__mylifedb_notification_service) {
      globalThis.__mylifedb_notification_service = new NotificationService();
      log.info('NotificationService initialized');
    }
    return globalThis.__mylifedb_notification_service;
  }

  /**
   * Emit a notification event to all connected clients
   */
  notify(event: NotificationEvent): void {
    log.info({ event }, 'Broadcasting notification');
    this.emit('notification', event);
  }

  /**
   * Subscribe to notification events
   * Returns unsubscribe function
   */
  subscribe(listener: (event: NotificationEvent) => void): () => void {
    this.on('notification', listener);
    log.debug('Client subscribed to notifications');

    // Return unsubscribe function
    return () => {
      this.off('notification', listener);
      log.debug('Client unsubscribed from notifications');
    };
  }

  /**
   * Get number of active subscribers
   */
  getSubscriberCount(): number {
    return this.listenerCount('notification');
  }
}

// Export singleton instance
export const notificationService = NotificationService.getInstance();
