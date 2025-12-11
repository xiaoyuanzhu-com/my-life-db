/**
 * Inbox Feed Types
 *
 * Types for the sparse page-based inbox feed with cursor pagination.
 */

import type { InboxItem } from '~/routes/api.inbox';

/**
 * Data for a single loaded page
 */
export interface PageData {
  /** Page index (0 = newest, higher = older) */
  pageIndex: number;

  /** Items in this page (sorted newest first within page) */
  items: InboxItem[];

  /** Cursors for this page's boundaries */
  cursors: {
    first: string | null;  // Cursor of first (newest) item
    last: string | null;   // Cursor of last (oldest) item
  };

  /** Whether more pages exist in each direction */
  hasMore: {
    older: boolean;
    newer: boolean;
  };

  /** Timestamp when page was loaded (for LRU eviction) */
  loadedAt: number;
}

/**
 * Constants for feed behavior
 */
export const FEED_CONSTANTS = {
  /** Items per page */
  BATCH_SIZE: 30,

  /** Maximum pages to keep in memory */
  MAX_PAGES: 10,

  /** Distance from edge to trigger load (px) */
  SCROLL_THRESHOLD: 1000,

  /** Default estimated item height for spacers (px) */
  DEFAULT_ITEM_HEIGHT: 200,

  /** Threshold for "at bottom" detection (px) */
  BOTTOM_STICK_THRESHOLD: 48,
} as const;
