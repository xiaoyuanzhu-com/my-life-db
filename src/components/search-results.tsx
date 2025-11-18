'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileCard } from './FileCard';
import type { SearchResponse, SearchResultItem } from '@/app/api/search/route';

interface SearchResultsProps {
  results: SearchResponse | null;
  isSearching: boolean;
  error: string | null;
}

const SEARCH_BATCH_SIZE = 30;

export function SearchResults({ results, isSearching, error }: SearchResultsProps) {
  const [mergedResults, setMergedResults] = useState<SearchResultItem[]>([]);
  const [pagination, setPagination] = useState<SearchResponse['pagination'] | null>(null);
  const [timing, setTiming] = useState<SearchResponse['timing'] | null>(null);
  const [currentQuery, setCurrentQuery] = useState('');
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const lastQueryRef = useRef<string | null>(null);

  // Sync incoming search results with local merged list
  useEffect(() => {
    if (!results) {
      setMergedResults([]);
      setPagination(null);
      setTiming(null);
      setCurrentQuery('');
      lastQueryRef.current = null;
      return;
    }

    const isNewQuery =
      results.query !== lastQueryRef.current ||
      results.pagination.offset === 0;

    if (isNewQuery) {
      setMergedResults(results.results);
    } else {
      setMergedResults(prev => {
        const prevPaths = new Set(prev.map(item => item.path));
        const additions = results.results.filter(item => !prevPaths.has(item.path));
        return [...prev, ...additions];
      });
    }

    setPagination(results.pagination);
    setTiming(results.timing);
    setCurrentQuery(results.query);
    lastQueryRef.current = results.query;
    setLoadMoreError(null);
  }, [results]);

  const hasResults = mergedResults.length > 0;
  const canLoadMore = Boolean(pagination?.hasMore);

  const loadMore = useCallback(async () => {
    if (!currentQuery || !canLoadMore || isLoadingMore) {
      return;
    }

    setIsLoadingMore(true);
    setLoadMoreError(null);

    try {
      const params = new URLSearchParams({
        q: currentQuery,
        limit: String(SEARCH_BATCH_SIZE),
        offset: String(mergedResults.length),
      });

      const response = await fetch(`/api/search?${params.toString()}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data: SearchResponse = await response.json();
      if (data.query !== currentQuery) {
        return;
      }

      setMergedResults(prev => {
        const prevPaths = new Set(prev.map(item => item.path));
        const additions = data.results.filter(item => !prevPaths.has(item.path));
        return [...prev, ...additions];
      });
      setPagination(data.pagination);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load more results';
      setLoadMoreError(message);
    } finally {
      setIsLoadingMore(false);
    }
  }, [currentQuery, canLoadMore, isLoadingMore, mergedResults.length]);

  // Observe sentinel to trigger infinite scroll
  useEffect(() => {
    const container = scrollContainerRef.current;
    const target = sentinelRef.current;

    if (!container || !target || !canLoadMore) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMore();
            break;
          }
        }
      },
      {
        root: container,
        rootMargin: '200px',
        threshold: 0,
      }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [canLoadMore, loadMore]);

  const showEmptyState =
    !isSearching &&
    !error &&
    results !== null &&
    results.results.length === 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      <div
        ref={scrollContainerRef}
        className="flex-1 h-full min-h-0 overflow-y-auto pb-4"
      >
        {!hasResults && isSearching && (
          <div className="flex flex-1 items-center justify-center min-h-full">
            <p className="text-sm text-muted-foreground">Searching…</p>
          </div>
        )}

        {!hasResults && error && !isSearching && (
          <div className="flex flex-1 items-center justify-center min-h-full">
            <p className="text-sm text-destructive">
              Failed to search related files, got error: {error}
            </p>
          </div>
        )}

        {!hasResults && showEmptyState && (
          <div className="flex flex-1 items-center justify-center min-h-full">
            <p className="text-sm text-muted-foreground">No related files</p>
          </div>
        )}

        {hasResults && (
          <div className="space-y-4 max-w-3xl md:max-w-4xl mx-auto pt-4 px-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Related files</p>
              {timing && (
                <p className="text-xs text-muted-foreground">
                  {timing.totalMs}ms
                </p>
              )}
            </div>

            {mergedResults.map((result) => (
              <FileCard
                key={result.path}
                file={result}
                showTimestamp={true}
              />
            ))}

            {loadMoreError && (
              <div className="flex flex-col items-center gap-2 text-xs text-destructive py-4">
                <p>Failed to load more results: {loadMoreError}</p>
                <button
                  type="button"
                  onClick={loadMore}
                  className="rounded-md border border-destructive/50 px-3 py-1 text-destructive hover:bg-destructive/10 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {isLoadingMore && (
              <div className="py-2 text-center">
                <p className="text-xs text-muted-foreground">Loading more…</p>
              </div>
            )}

            {canLoadMore && (
              <div ref={sentinelRef} className="h-4 w-full" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
