'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { FileCard } from './FileCard';
import type { InboxResponse } from '@/app/api/inbox/route';

interface InboxFeedProps {
  onRefresh?: number; // Trigger refresh when this value changes
}

const BATCH_SIZE = 30;
const BOTTOM_STICK_THRESHOLD = 48;

export function InboxFeed({ onRefresh }: InboxFeedProps) {
  const [items, setItems] = useState<InboxResponse['items']>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const autoScrollRef = useRef(true);
  const scrollAdjustmentRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollMetricsRef = useRef<{ scrollTop: number; scrollHeight: number; clientHeight: number } | null>(null);
  const logScrollState = useCallback((context: string) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    lastScrollMetricsRef.current = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    };
    // eslint-disable-next-line no-console
    console.log('[InboxFeed]', context, {
      items: items.length,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      distanceFromBottom,
    });
  }, [items.length]);

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
    } catch (err) {
      console.error('Failed to load inbox:', err);
      setError(err instanceof Error ? err.message : 'Failed to load inbox');
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

      const offset = items.length;
      const response = await fetch(`/api/inbox?limit=${BATCH_SIZE}&offset=${offset}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: InboxResponse = await response.json();

      // Append older items to the beginning of the array (since we display newest at bottom)
      setItems(prev => {
        const next = [...prev, ...data.items];
        setHasMore(next.length < data.total);
        return next;
      });
    } catch (err) {
      console.error('Failed to load more:', err);
      setError(err instanceof Error ? err.message : 'Failed to load more');
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
    }
  }, [items.length, hasMore]);

  // Scroll handler for infinite scroll
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottomRef.current = distanceFromBottom < BOTTOM_STICK_THRESHOLD;
    logScrollState('onScroll');

    // Detect scroll near top (load older items)
    const scrollTop = container.scrollTop;
    const threshold = 200; // Load when 200px from top

    if (scrollTop < threshold && hasMore && !loadingRef.current) {
      loadMore();
    }
  }, [hasMore, loadMore, logScrollState]);

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
        logScrollState('resize observer');
      }
    });

    observer.observe(container);
    if (content) {
      observer.observe(content);
    }
    return () => observer.disconnect();
  }, [logScrollState]);

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
        logScrollState('after adjustment');
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
        logScrollState('auto-scroll raf');
      }
    });
    autoScrollRef.current = false;
    stickToBottomRef.current = true;
  }, [items, logScrollState]);

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
          <FileCard
            key={item.path}
            file={item}
            showTimestamp={true}
            priority={index === array.length - 1}
          />
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
