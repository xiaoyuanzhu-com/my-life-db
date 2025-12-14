import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { FileCard } from './FileCard';
import { PendingItemCard } from './pending-item-card';
import type { InboxResponse } from '~/routes/api.inbox';
import type { PageData } from '~/types/inbox-feed';
import { FEED_CONSTANTS } from '~/types/inbox-feed';
import { useSendQueue } from '~/lib/send-queue';

interface InboxFeedProps {
  onRefresh?: number;
  scrollToCursor?: string;
  onScrollComplete?: () => void;
}

const { BATCH_SIZE, MAX_PAGES, SCROLL_THRESHOLD, DEFAULT_ITEM_HEIGHT, BOTTOM_STICK_THRESHOLD } = FEED_CONSTANTS;

/**
 * Parse cursor string to extract path
 */
function parseCursorPath(cursor: string): string | null {
  const match = cursor.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:(.+)$/);
  return match ? match[1] : null;
}

export function InboxFeed({ onRefresh, scrollToCursor, onScrollComplete }: InboxFeedProps) {
  // Page state - sparse map of loaded pages
  const [pages, setPages] = useState<Map<number, PageData>>(new Map());
  const [itemHeights, setItemHeights] = useState<Map<string, number>>(new Map());
  const [loadingPages, setLoadingPages] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Local-first send queue - get pending items
  const { pendingItems, cancel: cancelUpload } = useSendQueue();

  // Filter pending items to only show non-uploaded ones
  const visiblePendingItems = useMemo(() =>
    pendingItems
      .filter(item => item.status !== 'uploaded')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [pendingItems]
  );

  // Refs
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollAnchor = useRef<{ path: string; top: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollMetrics = useRef<{ scrollTop: number; scrollHeight: number; clientHeight: number } | null>(null);
  const contentStabilizedRef = useRef(false);
  const stabilizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Computed values
  const pageIndices = useMemo(() =>
    Array.from(pages.keys()).sort((a, b) => a - b),
    [pages]
  );

  const estimatedItemHeight = useMemo(() => {
    if (itemHeights.size === 0) return DEFAULT_ITEM_HEIGHT;
    const sum = Array.from(itemHeights.values()).reduce((a, b) => a + b, 0);
    return sum / itemHeights.size;
  }, [itemHeights]);

  // Get page height (measured or estimated)
  const getPageHeight = useCallback((pageIndex: number): number => {
    const page = pages.get(pageIndex);
    if (!page) return BATCH_SIZE * estimatedItemHeight;

    return page.items.reduce((sum, item) =>
      sum + (itemHeights.get(item.path) ?? estimatedItemHeight), 0
    );
  }, [pages, itemHeights, estimatedItemHeight]);

  // Capture scroll anchor before DOM changes
  const captureScrollAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();

    // Find first visible item
    for (const [path, el] of itemRefs.current) {
      const rect = el.getBoundingClientRect();
      if (rect.top >= containerRect.top && rect.top < containerRect.bottom) {
        scrollAnchor.current = { path, top: rect.top - containerRect.top };
        return;
      }
    }
  }, []);

  // Restore scroll position after DOM changes
  const restoreScrollAnchor = useCallback(() => {
    if (!scrollAnchor.current) return;

    const el = itemRefs.current.get(scrollAnchor.current.path);
    if (!el) {
      scrollAnchor.current = null;
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const currentTop = elRect.top - containerRect.top;
    const delta = currentTop - scrollAnchor.current.top;

    container.scrollTop += delta;
    scrollAnchor.current = null;
  }, []);

  // Update scroll metrics
  const updateScrollMetrics = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    lastScrollMetrics.current = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    };
  }, []);

  // Load newest page (initial load)
  const loadNewestPage = useCallback(async () => {
    if (loadingPages.has(0)) return;

    setLoadingPages(prev => new Set(prev).add(0));
    setError(null);

    try {
      const response = await fetch(`/api/inbox?limit=${BATCH_SIZE}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: InboxResponse = await response.json();

      const pageData: PageData = {
        pageIndex: 0,
        items: data.items,
        cursors: data.cursors,
        hasMore: data.hasMore,
        loadedAt: Date.now(),
      };

      setPages(new Map([[0, pageData]]));
      setIsInitialLoad(false);
    } catch (err) {
      console.error('Failed to load inbox:', err);
      setError(err instanceof Error ? err.message : 'Failed to load inbox');
    } finally {
      setLoadingPages(prev => {
        const next = new Set(prev);
        next.delete(0);
        return next;
      });
    }
  }, [loadingPages]);

  // Load older page
  const loadOlderPage = useCallback(async (fromPageIndex: number) => {
    const fromPage = pages.get(fromPageIndex);
    if (!fromPage || !fromPage.hasMore.older || !fromPage.cursors.last) return;

    const newPageIndex = fromPageIndex + 1;
    if (loadingPages.has(newPageIndex)) return;

    captureScrollAnchor();
    setLoadingPages(prev => new Set(prev).add(newPageIndex));

    try {
      const response = await fetch(
        `/api/inbox?limit=${BATCH_SIZE}&before=${encodeURIComponent(fromPage.cursors.last)}`
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: InboxResponse = await response.json();

      const pageData: PageData = {
        pageIndex: newPageIndex,
        items: data.items,
        cursors: data.cursors,
        hasMore: data.hasMore,
        loadedAt: Date.now(),
      };

      setPages(prev => {
        const next = new Map(prev);
        next.set(newPageIndex, pageData);
        return next;
      });
    } catch (err) {
      console.error('Failed to load older page:', err);
    } finally {
      setLoadingPages(prev => {
        const next = new Set(prev);
        next.delete(newPageIndex);
        return next;
      });
    }
  }, [pages, loadingPages, captureScrollAnchor]);

  // Load newer page
  const loadNewerPage = useCallback(async (fromPageIndex: number) => {
    const fromPage = pages.get(fromPageIndex);
    if (!fromPage || !fromPage.hasMore.newer || !fromPage.cursors.first) return;

    const newPageIndex = fromPageIndex - 1;
    if (newPageIndex < 0 || loadingPages.has(newPageIndex)) return;

    captureScrollAnchor();
    setLoadingPages(prev => new Set(prev).add(newPageIndex));

    try {
      const response = await fetch(
        `/api/inbox?limit=${BATCH_SIZE}&after=${encodeURIComponent(fromPage.cursors.first)}`
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: InboxResponse = await response.json();

      const pageData: PageData = {
        pageIndex: newPageIndex,
        items: data.items,
        cursors: data.cursors,
        hasMore: data.hasMore,
        loadedAt: Date.now(),
      };

      setPages(prev => {
        const next = new Map(prev);
        next.set(newPageIndex, pageData);
        return next;
      });
    } catch (err) {
      console.error('Failed to load newer page:', err);
    } finally {
      setLoadingPages(prev => {
        const next = new Set(prev);
        next.delete(newPageIndex);
        return next;
      });
    }
  }, [pages, loadingPages, captureScrollAnchor]);

  // Load page around cursor (for pin navigation)
  const loadPageAroundCursor = useCallback(async (cursor: string): Promise<number | null> => {
    // Clear existing pages for clean navigation
    captureScrollAnchor();

    // Use a temporary page index - we'll assign the real one based on position
    const tempPageIndex = 100; // Arbitrary high number to indicate "jumped" page
    setLoadingPages(prev => new Set(prev).add(tempPageIndex));

    try {
      const response = await fetch(
        `/api/inbox?limit=${BATCH_SIZE}&around=${encodeURIComponent(cursor)}`
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: InboxResponse & { targetIndex?: number } = await response.json();

      const pageData: PageData = {
        pageIndex: tempPageIndex,
        items: data.items,
        cursors: data.cursors,
        hasMore: data.hasMore,
        loadedAt: Date.now(),
      };

      // Replace all pages with just this one
      setPages(new Map([[tempPageIndex, pageData]]));

      return data.targetIndex ?? 0;
    } catch (err) {
      console.error('Failed to load page around cursor:', err);
      return null;
    } finally {
      setLoadingPages(prev => {
        const next = new Set(prev);
        next.delete(tempPageIndex);
        return next;
      });
    }
  }, [captureScrollAnchor]);

  // Evict distant pages (LRU based on distance from viewport)
  const evictDistantPages = useCallback((centerPageIndex: number) => {
    if (pages.size <= MAX_PAGES) return;

    const sorted = Array.from(pages.keys())
      .map(idx => ({ idx, distance: Math.abs(idx - centerPageIndex) }))
      .sort((a, b) => b.distance - a.distance);

    const toEvict = sorted.slice(0, pages.size - MAX_PAGES);

    if (toEvict.length > 0) {
      captureScrollAnchor();
      setPages(prev => {
        const next = new Map(prev);
        toEvict.forEach(({ idx }) => next.delete(idx));
        return next;
      });
    }
  }, [pages, captureScrollAnchor]);

  // Scroll to specific item with highlight
  const scrollToItem = useCallback((path: string) => {
    const element = itemRefs.current.get(path);
    if (!element) {
      console.warn(`Cannot scroll to ${path}: element not found`);
      return;
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Highlight animation
    element.style.transition = 'background-color 0.3s ease';
    element.style.backgroundColor = 'hsl(var(--primary) / 0.1)';
    setTimeout(() => {
      element.style.backgroundColor = '';
    }, 1000);

    stickToBottomRef.current = false;

    if (onScrollComplete) {
      setTimeout(onScrollComplete, 500);
    }
  }, [onScrollComplete]);

  // Handle scroll events
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Don't trigger infinite scroll during initial load
    if (isInitialLoad) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // Only allow disabling stickToBottom when content has stabilized (images loaded)
    // This prevents scroll events from async image loading from disabling stick-to-bottom
    const nearBottom = distanceFromBottom < BOTTOM_STICK_THRESHOLD;

    if (nearBottom) {
      // Always allow enabling stickToBottom
      stickToBottomRef.current = true;
    } else if (contentStabilizedRef.current) {
      // Only disable when content is stable (user actually scrolled up)
      stickToBottomRef.current = false;
    }
    // If content not stabilized and user appears to scroll away, keep stickToBottom true

    updateScrollMetrics();

    // Determine current viewport page for eviction
    let viewportPageIndex = 0;
    let accumulatedHeight = 0;
    const viewportCenter = scrollTop + clientHeight / 2;

    for (const pageIndex of [...pageIndices].reverse()) {
      const pageHeight = getPageHeight(pageIndex);
      if (accumulatedHeight + pageHeight > viewportCenter) {
        viewportPageIndex = pageIndex;
        break;
      }
      accumulatedHeight += pageHeight;
    }

    // Load more when near edges
    if (pageIndices.length > 0) {
      const oldestPageIndex = Math.max(...pageIndices);
      const newestPageIndex = Math.min(...pageIndices);

      // Near top -> load older
      if (scrollTop < SCROLL_THRESHOLD) {
        const oldestPage = pages.get(oldestPageIndex);
        if (oldestPage?.hasMore.older && !loadingPages.has(oldestPageIndex + 1)) {
          loadOlderPage(oldestPageIndex);
        }
      }

      // Near bottom -> load newer (if not at page 0)
      if (distanceFromBottom < SCROLL_THRESHOLD) {
        const newestPage = pages.get(newestPageIndex);
        if (newestPage?.hasMore.newer && newestPageIndex > 0 && !loadingPages.has(newestPageIndex - 1)) {
          loadNewerPage(newestPageIndex);
        }
      }
    }

    // Evict distant pages
    evictDistantPages(viewportPageIndex);
  }, [isInitialLoad, pageIndices, pages, loadingPages, getPageHeight, loadOlderPage, loadNewerPage, evictDistantPages, updateScrollMetrics]);

  // Initial load
  useEffect(() => {
    loadNewestPage();
  }, [onRefresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle scrollToCursor prop
  useEffect(() => {
    if (!scrollToCursor) return;

    const navigate = async () => {
      const targetPath = parseCursorPath(scrollToCursor);

      // Check if item is already loaded
      if (targetPath) {
        for (const page of pages.values()) {
          if (page.items.some(item => item.path === targetPath)) {
            // Already loaded, just scroll
            requestAnimationFrame(() => scrollToItem(targetPath));
            return;
          }
        }
      }

      // Load page around cursor
      await loadPageAroundCursor(scrollToCursor);

      // Wait for render, then scroll
      if (targetPath) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => scrollToItem(targetPath));
        });
      }
    };

    navigate();
  }, [scrollToCursor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Measure item heights after render
  useLayoutEffect(() => {
    const newHeights = new Map(itemHeights);
    let changed = false;

    itemRefs.current.forEach((el, path) => {
      const height = el.getBoundingClientRect().height;
      if (height > 0 && newHeights.get(path) !== height) {
        newHeights.set(path, height);
        changed = true;
      }
    });

    if (changed) {
      setItemHeights(newHeights);
    }
  }, [pages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore scroll anchor after pages change
  useLayoutEffect(() => {
    restoreScrollAnchor();
  }, [pages, restoreScrollAnchor]);

  // Auto-scroll to bottom on initial load or when sticking to bottom
  // Use useLayoutEffect to scroll synchronously before paint, avoiding race with ResizeObserver
  useLayoutEffect(() => {
    if (isInitialLoad || pages.size === 0) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    if (stickToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      updateScrollMetrics();
    }
  }, [pages, isInitialLoad, updateScrollMetrics, visiblePendingItems]);

  // Keep view pinned to bottom while content height changes
  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const observer = new ResizeObserver(() => {
      if (!container) return;

      // Content is changing - mark as not stabilized
      contentStabilizedRef.current = false;
      if (stabilizeTimeoutRef.current) {
        clearTimeout(stabilizeTimeoutRef.current);
      }
      // Mark as stabilized after 500ms of no resize events
      stabilizeTimeoutRef.current = setTimeout(() => {
        contentStabilizedRef.current = true;
      }, 500);

      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;

      // Always scroll to bottom if stickToBottomRef is true (simplest check)
      if (stickToBottomRef.current) {
        container.scrollTop = container.scrollHeight;
        updateScrollMetrics();
        return;
      }

      // Also scroll if we're close to bottom (handles edge cases)
      if (distanceFromBottom < BOTTOM_STICK_THRESHOLD) {
        container.scrollTop = container.scrollHeight;
        updateScrollMetrics();
      }
    });

    // Observe the content div, not the container - content changes when images load
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (stabilizeTimeoutRef.current) {
        clearTimeout(stabilizeTimeoutRef.current);
      }
    };
  }, [updateScrollMetrics]);

  // Attach scroll listener
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-destructive">Failed to load inbox: {error}</p>
      </div>
    );
  }

  // Empty state (only if no server items AND no pending items)
  const totalItems = Array.from(pages.values()).reduce((sum, page) => sum + page.items.length, 0);
  if (totalItems === 0 && visiblePendingItems.length === 0 && !isInitialLoad && loadingPages.size === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">No items in inbox</p>
      </div>
    );
  }

  // Render pages
  const sortedPageIndices = [...pageIndices].sort((a, b) => b - a); // Descending: oldest (highest) first

  return (
    <div
      ref={scrollContainerRef}
      className="h-full overflow-y-auto pb-4"
    >
      {/* Loading indicator at top */}
      {loadingPages.size > 0 && (
        <div className="py-4 text-center">
          <p className="text-xs text-muted-foreground">Loading...</p>
        </div>
      )}

      {/* Pages - rendered oldest first (top) to newest last (bottom) */}
      <div ref={contentRef} className="space-y-4 max-w-3xl md:max-w-4xl mx-auto px-4">
        {sortedPageIndices.map((pageIndex) => {
          const page = pages.get(pageIndex);
          if (!page) return null;

          // Reverse items within page for chat order (oldest at top of page)
          const reversedItems = page.items.slice().reverse();

          return (
            <div
              key={`page-${pageIndex}`}
              ref={el => {
                if (el) pageRefs.current.set(pageIndex, el);
                else pageRefs.current.delete(pageIndex);
              }}
              className="space-y-4"
            >
              {reversedItems.map((item, index) => (
                <div
                  key={item.path}
                  ref={el => {
                    if (el) itemRefs.current.set(item.path, el);
                    else itemRefs.current.delete(item.path);
                  }}
                >
                  <FileCard
                    file={item}
                    showTimestamp={true}
                    priority={pageIndex === 0 && index === reversedItems.length - 1}
                  />
                </div>
              ))}
            </div>
          );
        })}

        {/* Pending items (local-first) - always at the bottom (newest) */}
        {visiblePendingItems.length > 0 && (
          <div className="space-y-4">
            {visiblePendingItems.map((item) => (
              <PendingItemCard
                key={item.id}
                item={item}
                onCancel={cancelUpload}
              />
            ))}
          </div>
        )}
      </div>

      {/* Initial loading state */}
      {isInitialLoad && loadingPages.size > 0 && (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-muted-foreground">Loading inbox...</p>
        </div>
      )}
    </div>
  );
}
