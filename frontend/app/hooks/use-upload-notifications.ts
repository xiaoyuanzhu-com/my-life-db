/**
 * Hook for upload progress notifications
 *
 * Subscribes to the upload queue and shows toast notifications for:
 * - Upload completion (success)
 * - Upload failures (with retry info)
 */

import { useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import type { PendingInboxItem } from '~/lib/send-queue/types';

interface UseUploadNotificationsOptions {
  /**
   * Whether notifications are enabled
   * @default true
   */
  enabled?: boolean;
}

/**
 * Hook that subscribes to upload queue and shows toast notifications
 */
export function useUploadNotifications(options: UseUploadNotificationsOptions = {}) {
  const { enabled = true } = options;

  // Track items we've already notified about to avoid duplicates
  const notifiedSuccessRef = useRef<Set<string>>(new Set());
  const notifiedErrorRef = useRef<Set<string>>(new Set());
  const prevItemsRef = useRef<Map<string, PendingInboxItem>>(new Map());

  const handleProgress = useCallback((items: PendingInboxItem[]) => {
    const prevItems = prevItemsRef.current;

    for (const item of items) {
      const prev = prevItems.get(item.id);

      // Check for successful upload
      if (
        item.status === 'uploaded' &&
        !notifiedSuccessRef.current.has(item.id)
      ) {
        notifiedSuccessRef.current.add(item.id);
        toast.success('Upload complete', {
          description: item.filename,
          duration: 3000,
        });
      }

      // Check for new error (only notify once per error)
      if (
        item.errorMessage &&
        (!prev?.errorMessage || prev.errorMessage !== item.errorMessage) &&
        !notifiedErrorRef.current.has(`${item.id}-${item.retryCount}`)
      ) {
        notifiedErrorRef.current.add(`${item.id}-${item.retryCount}`);

        // Calculate retry time for display
        let retryInfo = '';
        if (item.nextRetryAt) {
          const retryDate = new Date(item.nextRetryAt);
          const now = new Date();
          const diffMs = retryDate.getTime() - now.getTime();
          if (diffMs > 0) {
            const diffSeconds = Math.ceil(diffMs / 1000);
            if (diffSeconds < 60) {
              retryInfo = ` (retrying in ${diffSeconds}s)`;
            } else {
              const diffMinutes = Math.ceil(diffSeconds / 60);
              retryInfo = ` (retrying in ${diffMinutes}m)`;
            }
          }
        }

        toast.error(`Upload failed: ${item.filename}`, {
          description: `${item.errorMessage}${retryInfo}`,
          duration: 5000,
        });
      }
    }

    // Update previous items map
    prevItemsRef.current = new Map(items.map((item) => [item.id, item]));
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let unsubscribe: (() => void) | undefined;

    const setup = async () => {
      const { getUploadQueueManager } = await import(
        '~/lib/send-queue/upload-queue-manager'
      );
      const manager = getUploadQueueManager();
      await manager.init();

      unsubscribe = manager.onProgress(handleProgress);

      // Get initial items
      const items = await manager.getPendingItems();
      // Pre-populate refs with existing items so we don't notify about old items
      for (const item of items) {
        if (item.status === 'uploaded') {
          notifiedSuccessRef.current.add(item.id);
        }
        if (item.errorMessage) {
          notifiedErrorRef.current.add(`${item.id}-${item.retryCount}`);
        }
      }
      prevItemsRef.current = new Map(items.map((i) => [i.id, i]));
    };

    setup();

    return () => {
      unsubscribe?.();
    };
  }, [enabled, handleProgress]);
}

/**
 * Show a toast for upload start (call this when enqueueing)
 */
export function showUploadStartToast(filename: string, count?: number) {
  if (count && count > 1) {
    toast.info(`Uploading ${count} files...`, {
      duration: 2000,
    });
  } else {
    toast.info(`Uploading ${filename}...`, {
      duration: 2000,
    });
  }
}
