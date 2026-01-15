/**
 * React hook for the send queue
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PendingInboxItem } from './types';
import { getUploadQueueManager } from './upload-queue-manager';

interface UseSendQueueResult {
  /** All pending items in the queue */
  pendingItems: PendingInboxItem[];
  /** Whether the queue is initialized */
  isInitialized: boolean;
  /** Send text and/or files to inbox */
  send: (text: string | undefined, files: File[]) => Promise<PendingInboxItem[]>;
  /** Cancel a pending upload */
  cancel: (id: string) => Promise<void>;
  /** Refresh the pending items list */
  refresh: () => Promise<void>;
}

/**
 * Hook to interact with the local-first send queue
 */
export function useSendQueue(
  onUploadComplete?: (item: PendingInboxItem, serverPath: string) => void
): UseSendQueueResult {
  const [pendingItems, setPendingItems] = useState<PendingInboxItem[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const onUploadCompleteRef = useRef(onUploadComplete);

  // Keep ref updated
  useEffect(() => {
    onUploadCompleteRef.current = onUploadComplete;
  }, [onUploadComplete]);

  // Initialize queue manager
  useEffect(() => {
    const manager = getUploadQueueManager();

    const init = async () => {
      await manager.init();
      const items = await manager.getPendingItems();
      setPendingItems(items);
      setIsInitialized(true);
    };

    init().catch(console.error);

    // Subscribe to progress updates
    const unsubProgress = manager.onProgress((items) => {
      setPendingItems(items);
    });

    // Subscribe to upload complete events
    const unsubComplete = manager.onUploadComplete((item, serverPath) => {
      onUploadCompleteRef.current?.(item, serverPath);
    });

    return () => {
      unsubProgress();
      unsubComplete();
    };
  }, []);

  const send = useCallback(async (text: string | undefined, files: File[]): Promise<PendingInboxItem[]> => {
    const manager = getUploadQueueManager();
    return manager.enqueueAll(text, files, 'inbox');
  }, []);

  const cancel = useCallback(async (id: string): Promise<void> => {
    const manager = getUploadQueueManager();
    return manager.cancelUpload(id);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const manager = getUploadQueueManager();
    const items = await manager.getPendingItems();
    setPendingItems(items);
  }, []);

  return {
    pendingItems,
    isInitialized,
    send,
    cancel,
    refresh,
  };
}
