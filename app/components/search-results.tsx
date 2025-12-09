'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCard } from './FileCard';
import type { SearchResponse, SearchResultItem } from '~/app/api/search/route';

interface SearchResultsProps {
  results: SearchResponse | null;
  isSearching: boolean;
  error: string | null;
}

const SEARCH_BATCH_SIZE = 30;

export function SearchResults({ results, isSearching, error }: SearchResultsProps) {
  const [mergedResults, setMergedResults] = useState<SearchResultItem[]>([]);
  const [pagination, setPagination] = useState<SearchResponse['pagination'] | null>(null);
  const [currentQuery, setCurrentQuery] = useState('');
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastQueryRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const autoScrollRef = useRef(true);
  const scrollAdjustmentRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const highlightTerms = useMemo(() => {
    if (!currentQuery.trim()) {
      return [];
    }

    return Array.from(
      new Set(
        currentQuery
          .split(/\s+/)
          .map(term => term.replace(/^['"]|['"]$/g, '').trim())
          .filter(term => term.length > 0)
      )
    );
  }, [currentQuery]);

  // Sync incoming search results with local merged list
  useEffect(() => {
    if (!results) {
      setMergedResults([]);
      setPagination(null);
      setCurrentQuery('');
      lastQueryRef.current = null;
      setIsLoadingMore(false);
      loadingRef.current = false;
      autoScrollRef.current = true;
      scrollAdjustmentRef.current = null;
      return;
    }

    const isNewQuery =
      results.query !== lastQueryRef.current ||
      results.pagination.offset === 0;

    if (isNewQuery) {
      setMergedResults(results.results);
      autoScrollRef.current = true;
      scrollAdjustmentRef.current = null;
      setIsLoadingMore(false);
      loadingRef.current = false;
    } else {
      setMergedResults(prev => {
        const prevPaths = new Set(prev.map(item => item.path));
        const additions = results.results.filter(item => !prevPaths.has(item.path));
        return [...prev, ...additions];
      });
    }

    setPagination(results.pagination);
    setCurrentQuery(results.query);
    lastQueryRef.current = results.query;
    setLoadMoreError(null);
  }, [results]);

  const orderedResults = useMemo(() => {
    return mergedResults
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [mergedResults]);

  const hasResults = orderedResults.length > 0;
  const canLoadMore = Boolean(pagination?.hasMore);

  const loadMore = useCallback(async () => {
    if (!currentQuery || !canLoadMore || isLoadingMore || loadingRef.current) {
      return;
    }

    loadingRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    autoScrollRef.current = false;

    const container = scrollContainerRef.current;
    if (container) {
      scrollAdjustmentRef.current = {
        prevHeight: container.scrollHeight,
        prevTop: container.scrollTop,
      };
    }

    try {
      const offset = mergedResults.length;
      const params = new URLSearchParams({
        q: currentQuery,
        limit: String(SEARCH_BATCH_SIZE),
        offset: String(offset),
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
      loadingRef.current = false;
    }
  }, [currentQuery, canLoadMore, isLoadingMore, mergedResults.length]);

  // Keep user anchored when older results prepend, or auto-scroll for new queries
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const adjustment = scrollAdjustmentRef.current;
    if (adjustment) {
      const heightDiff = container.scrollHeight - adjustment.prevHeight;
      container.scrollTop = adjustment.prevTop + heightDiff;
      scrollAdjustmentRef.current = null;
      return;
    }

    if (!autoScrollRef.current) {
      return;
    }

    // Use double requestAnimationFrame to ensure DOM has been fully painted and laid out
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight;
          autoScrollRef.current = false;
        }
      });
    });
  }, [mergedResults]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    autoScrollRef.current = false;

    const threshold = 200;
    if (container.scrollTop < threshold) {
      loadMore();
    }
  }, [loadMore]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const showEmptyState =
    !isSearching &&
    !error &&
    results !== null &&
    results.results.length === 0;

  return (
    <div
      ref={scrollContainerRef}
      className="h-full overflow-y-auto pb-4"
    >
      <div>
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
            {(isLoadingMore || loadMoreError) && (
              <div className="py-2 text-center text-xs">
                {isLoadingMore && (
                  <p className="text-muted-foreground">Loading older results…</p>
                )}
                {loadMoreError && (
                  <div className="flex flex-col items-center gap-2 text-destructive">
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
              </div>
            )}

            {orderedResults.map((result, index, array) => (
              <FileCard
                key={result.path}
                file={result}
                showTimestamp={true}
                highlightTerms={highlightTerms}
                matchContext={result.matchContext}
                priority={index === array.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
