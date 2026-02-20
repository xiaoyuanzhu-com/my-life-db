import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { FileCard } from './FileCard';
import { PendingFileCard } from './pending-file-card';
import type { InboxResponse, InboxItem } from '~/types/api';
import type { PageData } from '~/types/inbox-feed';
import { FEED_CONSTANTS } from '~/types/inbox-feed';
import { useSendQueue } from '~/lib/send-queue';
import { ModalNavigationProvider } from '~/contexts/modal-navigation-context';
import { api } from '~/lib/api';

interface InboxFeedProps {
  onRefresh?: number;
  scrollToCursor?: string;
  onScrollComplete?: () => void;
}

/**
 * Hook to track newly arrived items for animation.
 * Items that appear in a refresh but weren't in the previous data are "new".
 *
 * Two-phase animation to prevent flash:
 * 1. pendingPaths: items start hidden (opacity: 0)
 * 2. animatingPaths: animation plays (slide up + fade in)
 */
function useNewItemsAnimation() {
  // Items waiting for animation to start (hidden)
  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());
  // Items currently animating (slide up)
  const [animatingPaths, setAnimatingPaths] = useState<Set<string>>(new Set());
  // Previous paths to detect new arrivals
  const previousPathsRef = useRef<Set<string>>(new Set());
  // Flag to skip animation on initial load
  const isInitialLoadRef = useRef(true);

  // Called when fresh data arrives - detect new items
  const detectNewItems = useCallback((items: InboxItem[]) => {
    const currentPaths = new Set(items.map(item => item.path));

    // On initial load, just record paths without animating
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      previousPathsRef.current = currentPaths;
      return;
    }

    // Find paths that are new (in current but not in previous)
    const newlyArrived = new Set<string>();
    for (const path of currentPaths) {
      if (!previousPathsRef.current.has(path)) {
        newlyArrived.add(path);
      }
    }

    // Update state if there are new items
    if (newlyArrived.size > 0) {
      // Phase 1: Mark as pending (hidden)
      setPendingPaths(newlyArrived);

      // Phase 2: Start animation on next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setPendingPaths(new Set());
          setAnimatingPaths(newlyArrived);

          // Clear animation state after animation completes
          setTimeout(() => {
            setAnimatingPaths(new Set());
          }, 400);
        });
      });
    }

    // Update previous paths for next comparison
    previousPathsRef.current = currentPaths;
  }, []);

  // Returns animation class for an item
  const getAnimationClass = useCallback((path: string) => {
    if (pendingPaths.has(path)) {
      return 'animate-new-item-initial'; // Hidden, waiting
    }
    if (animatingPaths.has(path)) {
      return 'animate-slide-up-fade'; // Animating in
    }
    return '';
  }, [pendingPaths, animatingPaths]);

  return { detectNewItems, getAnimationClass };
}

// Animation duration for delete collapse (must match CSS)
const DELETE_ANIMATION_MS = 300;

/**
 * Hook to manage optimistic delete state with animation.
 * Tracks deleted paths and provides handlers for FileCard.
 *
 * Delete flow:
 * 1. Item added to animatingPaths (triggers collapse animation)
 * 2. After animation, item moved to deletedPaths (removed from DOM)
 *
 * When fresh data is loaded, we reconcile the optimistic state:
 * - If the path is in fresh data, remove from deletedPaths (file was re-added)
 * - If the path is not in fresh data, remove from deletedPaths (confirmed deleted)
 */
function useOptimisticDelete() {
  // Set of paths currently animating out
  const [animatingPaths, setAnimatingPaths] = useState<Set<string>>(new Set());
  // Set of paths that have been optimistically deleted (hidden from DOM)
  const [deletedPaths, setDeletedPaths] = useState<Set<string>>(new Set());
  // Store items for potential restore (keyed by path)
  const deletedItemsRef = useRef<Map<string, InboxItem>>(new Map());

  const handleDelete = useCallback((path: string, item: InboxItem) => {
    // Store the item for potential restore
    deletedItemsRef.current.set(path, item);
    // Start animation
    setAnimatingPaths(prev => new Set(prev).add(path));

    // After animation completes, move to deleted set
    setTimeout(() => {
      setAnimatingPaths(prev => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      setDeletedPaths(prev => new Set(prev).add(path));
    }, DELETE_ANIMATION_MS);
  }, []);

  const handleRestore = useCallback((path: string) => {
    // Remove from both sets (cancel animation if in progress)
    setAnimatingPaths(prev => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    setDeletedPaths(prev => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    // Clean up stored item
    deletedItemsRef.current.delete(path);
  }, []);

  const isDeleted = useCallback((path: string) => {
    return deletedPaths.has(path);
  }, [deletedPaths]);

  const isAnimatingOut = useCallback((path: string) => {
    return animatingPaths.has(path);
  }, [animatingPaths]);

  // Clear optimistic state when fresh data arrives
  // This ensures re-added files show up correctly
  const clearOptimisticState = useCallback(() => {
    setAnimatingPaths(new Set());
    setDeletedPaths(new Set());
    deletedItemsRef.current.clear();
  }, []);

  return {
    deletedPaths,
    animatingPaths,
    handleDelete,
    handleRestore,
    isDeleted,
    isAnimatingOut,
    clearOptimisticState,
  };
}

const { BATCH_SIZE, MAX_PAGES, SCROLL_THRESHOLD, DEFAULT_ITEM_HEIGHT } = FEED_CONSTANTS;

// Use 100vh for bottom stick threshold (1 full viewport height)
const getBottomStickThreshold = () => typeof window !== 'undefined' ? window.innerHeight : 800;

/**
 * Parse cursor string to extract path
 * Cursor format: epoch_ms:path (e.g., "1706799426123:inbox/photo.jpg")
 */
function parseCursorPath(cursor: string): string | null {
  const idx = cursor.indexOf(':')
  if (idx === -1) return null
  // Verify the part before : is a number (epoch ms)
  const ts = cursor.substring(0, idx)
  if (!/^\d+$/.test(ts)) return null
  return cursor.substring(idx + 1)
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

  // Optimistic delete state
  const { deletedPaths, handleDelete, handleRestore, isAnimatingOut, clearOptimisticState } = useOptimisticDelete();

  // New items animation
  const { detectNewItems, getAnimationClass } = useNewItemsAnimation();

  // Filter pending items to only show non-uploaded ones
  const visiblePendingItems = useMemo(() =>
    pendingItems
      .filter(item => item.status !== 'uploaded')
      .sort((a, b) => a.createdAt - b.createdAt),
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
  // Ref-based loading guard for loadNewestPage to avoid race conditions
  const loadingNewestPageRef = useRef(false);
  // Flag to queue a refresh if one arrives while loading
  const pendingRefreshRef = useRef(false);
  // Lock to prevent handleScroll from re-enabling stickToBottom during pin navigation
  const navigatingToCursorRef = useRef(false);

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

  // Load newest page (initial load or refresh)
  // Uses ref-based guard to prevent race conditions
  const loadNewestPage = useCallback(async () => {
    // Use ref for synchronous check - prevents race condition
    if (loadingNewestPageRef.current) {
      // Queue a refresh for when current load completes
      pendingRefreshRef.current = true;
      return;
    }

    loadingNewestPageRef.current = true;
    pendingRefreshRef.current = false;
    setLoadingPages(prev => new Set(prev).add(0));
    setError(null);

    try {
      const response = await api.get(`/api/inbox?limit=${BATCH_SIZE}`);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: InboxResponse = await response.json();

      const pageData: PageData = {
        pageIndex: 0,
        items: data.items,
        cursors: data.cursors,
        hasMore: data.hasMore,
        loadedAt: Date.now(),
      };

      // Detect new items for animation before updating state
      detectNewItems(data.items);

      setPages(new Map([[0, pageData]]));
      setIsInitialLoad(false);
      setError(null); // Clear any previous error on success
      // Clear optimistic delete state - fresh data is the source of truth
      // This ensures re-added files (from another device) show up correctly
      clearOptimisticState();
    } catch (err) {
      console.error('Failed to load inbox:', err);
      setError(err instanceof Error ? err.message : 'Failed to load inbox');
      // Keep existing pages (stale data) - don't clear them on error
      // Only mark initial load complete if we have some data to show
      if (pages.size > 0) {
        setIsInitialLoad(false);
      }
    } finally {
      setLoadingPages(prev => {
        const next = new Set(prev);
        next.delete(0);
        return next;
      });
      loadingNewestPageRef.current = false;

      // If a refresh was queued while we were loading, do it now
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        // Use setTimeout to avoid recursion in the same call stack
        setTimeout(() => loadNewestPage(), 0);
      }
    }
  }, [pages.size, clearOptimisticState, detectNewItems]);

  // Load older page
  const loadOlderPage = useCallback(async (fromPageIndex: number) => {
    const fromPage = pages.get(fromPageIndex);
    if (!fromPage || !fromPage.hasMore.older || !fromPage.cursors.last) return;

    const newPageIndex = fromPageIndex + 1;
    if (loadingPages.has(newPageIndex)) return;

    captureScrollAnchor();
    setLoadingPages(prev => new Set(prev).add(newPageIndex));

    try {
      const response = await api.get(
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
      const response = await api.get(
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
      const response = await api.get(
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
    const container = scrollContainerRef.current;
    if (!element || !container) {
      console.warn(`Cannot scroll to ${path}: element or container not found`);
      return;
    }

    stickToBottomRef.current = false;

    // Calculate target scroll position manually to center the element
    const scrollToCenter = () => {
      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const elementOffsetTop = elementRect.top - containerRect.top + container.scrollTop;
      const targetScrollTop = elementOffsetTop - (container.clientHeight / 2) + (element.offsetHeight / 2);
      return Math.max(0, targetScrollTop);
    };

    // Scroll to the element
    const targetScrollTop = scrollToCenter();
    container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });

    // Re-adjust after content might have loaded (images, etc.)
    // This handles the case where scrollHeight changes during scroll
    const checkAndCorrect = () => {
      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const elementCenterY = elementRect.top + elementRect.height / 2;
      const containerCenterY = containerRect.top + containerRect.height / 2;
      const offset = Math.abs(elementCenterY - containerCenterY);

      // If element is not reasonably centered (more than 100px off), re-scroll
      if (offset > 100) {
        const newTarget = scrollToCenter();
        container.scrollTo({ top: newTarget, behavior: 'smooth' });
      }
    };

    // Check and correct after initial scroll and potential content load
    setTimeout(checkAndCorrect, 300);
    setTimeout(checkAndCorrect, 600);

    // Highlight animation
    element.style.transition = 'background-color 0.3s ease';
    element.style.backgroundColor = 'hsl(var(--primary) / 0.1)';
    setTimeout(() => {
      element.style.backgroundColor = '';
    }, 1500);

    // Clear navigation lock after scroll completes
    setTimeout(() => {
      navigatingToCursorRef.current = false;
    }, 800);

    if (onScrollComplete) {
      setTimeout(onScrollComplete, 800);
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
    const nearBottom = distanceFromBottom < getBottomStickThreshold();

    if (nearBottom) {
      // Don't re-enable stickToBottom during pin navigation
      if (!navigatingToCursorRef.current) {
        stickToBottomRef.current = true;
      }
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

    // Lock navigation to prevent handleScroll from re-enabling stickToBottom
    navigatingToCursorRef.current = true;

    // Immediately disable stick-to-bottom to prevent other effects from
    // scrolling to bottom while we're trying to scroll to a specific item
    stickToBottomRef.current = false;

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

      // Only scroll to bottom if stickToBottomRef is true
      // This is the single source of truth for "should we stick to bottom"
      if (stickToBottomRef.current) {
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

  // Calculate total server items (used for error/empty state checks)
  const totalItems = Array.from(pages.values()).reduce((sum, page) => sum + page.items.length, 0);

  // Render pages - compute sorted indices before early returns to satisfy React hooks rules
  const sortedPageIndices = [...pageIndices].sort((a, b) => b - a); // Descending: oldest (highest) first

  // Compute flat list of files in display order (oldest first) for modal navigation
  // This matches the render order: oldest pages first, items reversed within each page
  // Must be called unconditionally (before early returns) to satisfy React hooks rules
  const allFilesForNavigation = useMemo(() => {
    const files: InboxItem[] = [];
    for (const pageIndex of sortedPageIndices) {
      const page = pages.get(pageIndex);
      if (!page) continue;
      // Reverse items within page for chat order, filter deleted items
      const reversedItems = page.items
        .filter(item => !deletedPaths.has(item.path))
        .slice()
        .reverse();
      files.push(...reversedItems);
    }
    return files;
  }, [sortedPageIndices, pages, deletedPaths]);

  // Error state - only block UI if no data to show at all
  if (error && visiblePendingItems.length === 0 && totalItems === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-destructive">Failed to load inbox: {error}</p>
      </div>
    );
  }

  // Empty state (only if no server items AND no pending items)
  if (totalItems === 0 && visiblePendingItems.length === 0 && !isInitialLoad && loadingPages.size === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">No items in inbox</p>
      </div>
    );
  }

  return (
    <ModalNavigationProvider files={allFilesForNavigation}>
      <div
        ref={scrollContainerRef}
        className="h-full overflow-y-auto pb-4"
      >
        {/* Offline/error banner when server unreachable but we have content to show */}
        {error && (totalItems > 0 || visiblePendingItems.length > 0) && (
          <div className="py-2 text-center bg-muted/50">
            <p className="text-xs text-muted-foreground">Offline - showing cached data</p>
          </div>
        )}

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
            // Filter out optimistically deleted items
            const reversedItems = page.items
              .filter(item => !deletedPaths.has(item.path))
              .slice()
              .reverse();

            return (
              <div
                key={`page-${pageIndex}`}
                ref={el => {
                  if (el) pageRefs.current.set(pageIndex, el);
                  else pageRefs.current.delete(pageIndex);
                }}
                className="space-y-4"
              >
                {reversedItems.map((item, index) => {
                  // Delete animation takes priority over new item animation
                  const animClass = isAnimatingOut(item.path)
                    ? 'animate-collapse-fade'
                    : getAnimationClass(item.path);
                  return (
                    <div
                      key={item.path}
                      ref={el => {
                        if (el) itemRefs.current.set(item.path, el);
                        else itemRefs.current.delete(item.path);
                      }}
                      className={animClass}
                    >
                      <FileCard
                        file={item}
                        showTimestamp={true}
                        priority={pageIndex === 0 && index === reversedItems.length - 1}
                        onDeleted={() => handleDelete(item.path, item)}
                        onRestoreItem={() => handleRestore(item.path)}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Pending items (local-first) - always at the bottom (newest) */}
          {visiblePendingItems.length > 0 && (
            <div className="space-y-4">
              {visiblePendingItems.map((item) => (
                <PendingFileCard
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
    </ModalNavigationProvider>
  );
}
