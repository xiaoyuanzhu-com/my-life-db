/**
 * Convert PendingInboxItem to FileWithDigests
 *
 * This allows pending (local-only) items to be rendered using the same
 * FileCard components as server files.
 */

import { useState, useEffect } from 'react';
import type { FileWithDigests } from '~/types/file-card';
import type { PendingInboxItem } from './types';

/**
 * Convert a PendingInboxItem to FileWithDigests format
 * Creates a blob URL for the content and populates required fields
 */
export function pendingItemToFile(
  item: PendingInboxItem,
  blobUrl: string,
  textPreview?: string
): FileWithDigests {
  return {
    // Use pending: prefix to identify local items
    path: `pending:${item.id}`,
    name: item.filename,
    isFolder: false,
    size: item.size,
    mimeType: item.type,
    hash: null,
    modifiedAt: item.createdAt,
    createdAt: item.createdAt,
    // No digests for local items
    digests: [],
    // Text preview for text files
    textPreview,
    // Blob URL for content display
    blobUrl,
  };
}

/**
 * Hook to convert a PendingInboxItem to FileWithDigests
 * Manages blob URL lifecycle (creation and cleanup)
 */
export function usePendingItemAsFile(item: PendingInboxItem): FileWithDigests {
  const [blobUrl, setBlobUrl] = useState<string>('');
  const [textPreview, setTextPreview] = useState<string | undefined>();

  useEffect(() => {
    // Create blob URL for media content
    const url = URL.createObjectURL(item.blob);
    setBlobUrl(url);

    // Extract text preview for text files
    if (item.type === 'text/markdown' || item.type.startsWith('text/')) {
      item.blob.text().then((text) => {
        setTextPreview(text);
      });
    }

    // Cleanup blob URL on unmount or item change
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [item.blob, item.type]);

  return pendingItemToFile(item, blobUrl, textPreview);
}
