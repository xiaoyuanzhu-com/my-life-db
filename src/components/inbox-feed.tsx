'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { FileCard } from './FileCard';
import type { InboxResponse } from '@/app/api/inbox/route';

interface InboxFeedProps {
  onRefresh?: number; // Trigger refresh when this value changes
}

const BATCH_SIZE = 30;

export function InboxFeed({ onRefresh }: InboxFeedProps) {
  const [items, setItems] = useState<InboxResponse['items']>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const autoScrollRef = useRef(true);
  const scrollAdjustmentRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

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

    // Detect scroll near top (load older items)
    const scrollTop = container.scrollTop;
    const threshold = 200; // Load when 200px from top

    if (scrollTop < threshold && hasMore && !loadingRef.current) {
      loadMore();
    }
  }, [hasMore, loadMore]);

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

  // Auto-scroll to bottom when freshly loaded/refreshed
  useEffect(() => {
    const adjustment = scrollAdjustmentRef.current;
    if (adjustment) {
      const container = scrollContainerRef.current;
      if (container) {
        const heightDiff = container.scrollHeight - adjustment.prevHeight;
        container.scrollTop = adjustment.prevTop + heightDiff;
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

    container.scrollTop = container.scrollHeight;
    autoScrollRef.current = false;
  }, [items]);

  useEffect(() => {
    autoScrollRef.current = true;
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
      <div className="space-y-4 max-w-3xl md:max-w-4xl mx-auto px-4">
        {items.slice().reverse().map((item) => (
          <FileCard
            key={item.path}
            file={item}
            showTimestamp={true}
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
