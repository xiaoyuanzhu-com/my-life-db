'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { FileCard } from './FileCard';
import type { InboxResponse } from '@/app/api/inbox/route';

interface InboxFeedProps {
  onRefresh?: number; // Trigger refresh when this value changes
  scrollToPath?: string; // Path to scroll to
  onScrollComplete?: () => void; // Called after scroll completes
}

const BATCH_SIZE = 30;
const BOTTOM_STICK_THRESHOLD = 48;

export function InboxFeed({ onRefresh, scrollToPath, onScrollComplete }: InboxFeedProps) {
  const [items, setItems] = useState<InboxResponse['items']>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [currentOffset, setCurrentOffset] = useState(0); // Track current batch offset
  const [totalItems, setTotalItems] = useState(0); // Track total items count
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const autoScrollRef = useRef(true);
  const scrollAdjustmentRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollMetricsRef = useRef<{ scrollTop: number; scrollHeight: number; clientHeight: number } | null>(null);
  const itemRefsRef = useRef<Map<string, HTMLDivElement>>(new Map()); // Track DOM elements by path
  const updateScrollMetrics = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    lastScrollMetricsRef.current = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    };
  }, []);

  // Load initial batch
  const loadInitialBatch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    loadingRef.current = true;

    try {
      const response = await fetch(`/api/inbox?limit=${BATCH_SIZE}&offset=0`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: InboxResponse = await response.json();
      setItems(data.items);
      setHasMore(data.items.length < data.total);
      setCurrentOffset(0);
      setTotalItems(data.total);
    } catch (err) {
      console.error('Failed to load inbox:', err);
      setError(err instanceof Error ? err.message : 'Failed to load inbox');
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Load batch containing a specific item
  const loadBatchContainingItem = useCallback(async (path: string) => {
    setIsLoading(true);
    setError(null);
    loadingRef.current = true;
    autoScrollRef.current = false;

    try {
      // Get item position
      const positionResponse = await fetch(`/api/inbox/position?path=${encodeURIComponent(path)}`);
      if (!positionResponse.ok) {
        throw new Error(`Failed to get position for ${path}`);
      }

      const positionData = await positionResponse.json();
      const { batchOffset, total } = positionData;

      // Load the batch containing this item
      const response = await fetch(`/api/inbox?limit=${BATCH_SIZE}&offset=${batchOffset}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: InboxResponse = await response.json();
      setItems(data.items);
      setCurrentOffset(batchOffset);
      setTotalItems(total);

      // Determine if there are more items to load
      const hasMoreOlder = batchOffset + data.items.length < total;
      setHasMore(hasMoreOlder);

      return path; // Return path for scrolling
    } catch (err) {
      console.error('Failed to load batch:', err);
      setError(err instanceof Error ? err.message : 'Failed to load batch');
      return null;
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Load more items (older)
  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore) return;

    loadingRef.current = true;
    setIsLoading(true);
    autoScrollRef.current = false;

    try {
      const container = scrollContainerRef.current;
      if (container) {
        scrollAdjustmentRef.current = {
          prevHeight: container.scrollHeight,
          prevTop: container.scrollTop,
        };
      }

      const offset = currentOffset + items.length;
      const response = await fetch(`/api/inbox?limit=${BATCH_SIZE}&offset=${offset}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: InboxResponse = await response.json();

      // Append older items to the end of the array
      setItems(prev => {
        const next = [...prev, ...data.items];
        const hasMoreOlder = offset + data.items.length < totalItems;
        setHasMore(hasMoreOlder);
        return next;
      });
    } catch (err) {
      console.error('Failed to load more:', err);
      setError(err instanceof Error ? err.message : 'Failed to load more');
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, [currentOffset, items.length, hasMore, totalItems]);

  // Load more items (newer) - load items with smaller offset
  const loadMoreNewer = useCallback(async () => {
    if (loadingRef.current || currentOffset === 0) return; // Can't load newer than offset 0

    loadingRef.current = true;
    setIsLoading(true);
    autoScrollRef.current = false;

    try {
      const container = scrollContainerRef.current;
      if (container) {
        scrollAdjustmentRef.current = {
          prevHeight: container.scrollHeight,
          prevTop: container.scrollTop,
        };
      }

      // Calculate new offset (move backwards by BATCH_SIZE)
      const newOffset = Math.max(0, currentOffset - BATCH_SIZE);
      const response = await fetch(`/api/inbox?limit=${BATCH_SIZE}&offset=${newOffset}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: InboxResponse = await response.json();

      // Prepend newer items to the beginning of the array
      setItems(prev => {
        const next = [...data.items, ...prev];
        setCurrentOffset(newOffset);
        return next;
      });
    } catch (err) {
      console.error('Failed to load more newer:', err);
      setError(err instanceof Error ? err.message : 'Failed to load more');
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, [currentOffset]);

  // Scroll to specific item
  const scrollToItem = useCallback((path: string) => {
    const element = itemRefsRef.current.get(path);
    if (!element) {
      console.warn(`Cannot scroll to ${path}: element not found`);
      return;
    }

    // Scroll to element with smooth behavior
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Add highlight animation
    element.style.transition = 'background-color 0.3s ease';
    element.style.backgroundColor = 'hsl(var(--primary) / 0.1)';
    setTimeout(() => {
      element.style.backgroundColor = '';
    }, 1000);

    // Disable auto-scroll and bottom-stick
    autoScrollRef.current = false;
    stickToBottomRef.current = false;

    // Call completion callback
    if (onScrollComplete) {
      setTimeout(onScrollComplete, 500);
    }
  }, [onScrollComplete]);

  // Handle scrollToPath prop changes
  useEffect(() => {
    if (!scrollToPath) return;

    const handleScrollToPath = async () => {
      // Check if item is already loaded
      const itemExists = items.some(item => item.path === scrollToPath);

      if (itemExists) {
        // Item is already in current batch, just scroll to it
        setTimeout(() => scrollToItem(scrollToPath), 100);
      } else {
        // Load batch containing the item
        const loadedPath = await loadBatchContainingItem(scrollToPath);
        if (loadedPath) {
          // Wait for render, then scroll
          setTimeout(() => scrollToItem(loadedPath), 200);
        }
      }
    };

    handleScrollToPath();
  }, [scrollToPath, items, loadBatchContainingItem, scrollToItem]);

  // Scroll handler for infinite scroll
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    stickToBottomRef.current = distanceFromBottom < BOTTOM_STICK_THRESHOLD;
    updateScrollMetrics();

    const threshold = 200; // Load when 200px from boundary

    // Detect scroll near top (load older items)
    if (scrollTop < threshold && hasMore && !loadingRef.current) {
      loadMore();
    }

    // Detect scroll near bottom (load newer items)
    if (distanceFromBottom < threshold && currentOffset > 0 && !loadingRef.current) {
      loadMoreNewer();
    }
  }, [hasMore, currentOffset, loadMore, loadMoreNewer, updateScrollMetrics]);

  // Initial load
  useEffect(() => {
    loadInitialBatch();
  }, [loadInitialBatch, onRefresh]);

  // Attach scroll listener
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Keep view pinned to bottom while content height changes (e.g., image loads)
  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      if (!container) return;

      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const prev = lastScrollMetricsRef.current;
      const prevDistance = prev ? prev.scrollHeight - prev.scrollTop - prev.clientHeight : null;
      const heightIncreased = prev ? container.scrollHeight > prev.scrollHeight : false;
      const wasAtBottom = prevDistance !== null ? prevDistance < BOTTOM_STICK_THRESHOLD : stickToBottomRef.current;

      if (stickToBottomRef.current || (wasAtBottom && heightIncreased) || distanceFromBottom < BOTTOM_STICK_THRESHOLD) {
        container.scrollTop = container.scrollHeight;
        updateScrollMetrics();
      }
    });

    observer.observe(container);
    if (content) {
      observer.observe(content);
    }
    return () => observer.disconnect();
  }, [updateScrollMetrics]);

  // Auto-scroll to bottom when freshly loaded/refreshed
  useEffect(() => {
    if (items.length === 0) {
      // Wait for first real batch before locking auto-scroll
      return;
    }

    const adjustment = scrollAdjustmentRef.current;
    if (adjustment) {
      const container = scrollContainerRef.current;
      if (container) {
        const heightDiff = container.scrollHeight - adjustment.prevHeight;
        container.scrollTop = adjustment.prevTop + heightDiff;
        updateScrollMetrics();
      }
      scrollAdjustmentRef.current = null;
      return;
    }

    if (!autoScrollRef.current) {
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    // Use requestAnimationFrame to ensure content is fully rendered before scrolling
    requestAnimationFrame(() => {
      if (container) {
        container.scrollTop = container.scrollHeight;
        updateScrollMetrics();
      }
    });
    autoScrollRef.current = false;
    stickToBottomRef.current = true;
  }, [items, updateScrollMetrics]);

  useEffect(() => {
    autoScrollRef.current = true;
    stickToBottomRef.current = true;
  }, [onRefresh]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-destructive">Failed to load inbox: {error}</p>
      </div>
    );
  }

  if (items.length === 0 && !isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">No items in inbox</p>
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      className="h-full overflow-y-auto pb-4"
    >
      {/* Loading indicator at top */}
      {isLoading && items.length > 0 && (
        <div className="py-4 text-center">
          <p className="text-xs text-muted-foreground">Loading...</p>
        </div>
      )}

      {/* Inbox items - displayed in reverse order (oldest first, newest last) */}
      <div ref={contentRef} className="space-y-4 max-w-3xl md:max-w-4xl mx-auto px-4">
        {items.slice().reverse().map((item, index, array) => (
          <div
            key={item.path}
            ref={(el) => {
              if (el) {
                itemRefsRef.current.set(item.path, el);
              } else {
                itemRefsRef.current.delete(item.path);
              }
            }}
          >
            <FileCard
              file={item}
              showTimestamp={true}
              priority={index === array.length - 1}
            />
          </div>
        ))}
      </div>

      {/* Initial loading state */}
      {isLoading && items.length === 0 && (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-muted-foreground">Loading inbox...</p>
        </div>
      )}

    </div>
  );
}
