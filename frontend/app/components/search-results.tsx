import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCard } from './FileCard';
import type { SearchResponse, SearchResultItem } from '~/types/api';
import { ModalNavigationProvider } from '~/contexts/modal-navigation-context';

interface SearchResultsProps {
  keywordResults: SearchResponse | null;
  semanticResults: SearchResponse | null;
  isKeywordSearching: boolean;
  isSemanticSearching: boolean;
  keywordError: string | null;
  semanticError: string | null;
  onLocateInFeed?: (path: string, createdAt: string) => void;
}

const SEARCH_BATCH_SIZE = 30;

export function SearchResults({
  keywordResults,
  semanticResults,
  isKeywordSearching,
  isSemanticSearching,
  keywordError,
  semanticError,
  onLocateInFeed,
}: SearchResultsProps) {
  // Track accumulated results from each source (for pagination)
  const [accumulatedKeyword, setAccumulatedKeyword] = useState<SearchResultItem[]>([]);
  const [accumulatedSemantic, setAccumulatedSemantic] = useState<SearchResultItem[]>([]);
  const [keywordPagination, setKeywordPagination] = useState<SearchResponse['pagination'] | null>(null);
  const [semanticPagination, setSemanticPagination] = useState<SearchResponse['pagination'] | null>(null);
  const [currentQuery, setCurrentQuery] = useState('');
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastQueryRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const autoScrollRef = useRef(true);
  const scrollAdjustmentRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const keywordAbortRef = useRef<AbortController | null>(null);
  const semanticAbortRef = useRef<AbortController | null>(null);

  // Derive query from available results (used for display in future if needed)
  const _query = keywordResults?.query || semanticResults?.query || '';

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

  // Sync keyword results
  useEffect(() => {
    if (!keywordResults) {
      setAccumulatedKeyword([]);
      setKeywordPagination(null);
      return;
    }

    const isNewQuery =
      keywordResults.query !== lastQueryRef.current ||
      keywordResults.pagination.offset === 0;

    if (isNewQuery) {
      setAccumulatedKeyword(keywordResults.results);
      autoScrollRef.current = true;
      scrollAdjustmentRef.current = null;
    } else {
      setAccumulatedKeyword(prev => {
        const prevPaths = new Set(prev.map(item => item.path));
        const additions = keywordResults.results.filter(item => !prevPaths.has(item.path));
        return [...prev, ...additions];
      });
    }

    setKeywordPagination(keywordResults.pagination);
    setCurrentQuery(keywordResults.query);
    lastQueryRef.current = keywordResults.query;
  }, [keywordResults]);

  // Sync semantic results
  useEffect(() => {
    if (!semanticResults) {
      setAccumulatedSemantic([]);
      setSemanticPagination(null);
      return;
    }

    const isNewQuery =
      semanticResults.query !== lastQueryRef.current ||
      semanticResults.pagination.offset === 0;

    if (isNewQuery) {
      setAccumulatedSemantic(semanticResults.results);
      autoScrollRef.current = true;
      scrollAdjustmentRef.current = null;
    } else {
      setAccumulatedSemantic(prev => {
        const prevPaths = new Set(prev.map(item => item.path));
        const additions = semanticResults.results.filter(item => !prevPaths.has(item.path));
        return [...prev, ...additions];
      });
    }

    setSemanticPagination(semanticResults.pagination);
    if (!currentQuery) {
      setCurrentQuery(semanticResults.query);
      lastQueryRef.current = semanticResults.query;
    }
  }, [semanticResults, currentQuery]);

  // Reset when both are cleared
  useEffect(() => {
    if (!keywordResults && !semanticResults) {
      setAccumulatedKeyword([]);
      setAccumulatedSemantic([]);
      setKeywordPagination(null);
      setSemanticPagination(null);
      setCurrentQuery('');
      lastQueryRef.current = null;
      setIsLoadingMore(false);
      loadingRef.current = false;
      autoScrollRef.current = true;
      scrollAdjustmentRef.current = null;
    }
  }, [keywordResults, semanticResults]);

  // Merge results: dedupe by path, sort by createdAt
  const mergedResults = useMemo(() => {
    const pathMap = new Map<string, SearchResultItem>();

    // Add keyword results first (priority)
    for (const item of accumulatedKeyword) {
      pathMap.set(item.path, item);
    }

    // Add semantic results (only new paths)
    for (const item of accumulatedSemantic) {
      if (!pathMap.has(item.path)) {
        pathMap.set(item.path, item);
      }
    }

    return Array.from(pathMap.values());
  }, [accumulatedKeyword, accumulatedSemantic]);

  const orderedResults = useMemo(() => {
    return mergedResults
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [mergedResults]);

  const hasResults = orderedResults.length > 0;
  const isSearching = isKeywordSearching || isSemanticSearching;
  const canLoadMore = Boolean(keywordPagination?.hasMore || semanticPagination?.hasMore);
  const error = (keywordError && semanticError) ? (keywordError || semanticError) : null;

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

    // Cancel any previous load more requests
    keywordAbortRef.current?.abort();
    semanticAbortRef.current?.abort();

    const keywordController = new AbortController();
    const semanticController = new AbortController();
    keywordAbortRef.current = keywordController;
    semanticAbortRef.current = semanticController;

    let keywordDone = false;
    let semanticDone = false;
    let hasError = false;

    const checkComplete = () => {
      if (keywordDone && semanticDone) {
        setIsLoadingMore(false);
        loadingRef.current = false;
      }
    };

    // Fire keyword load more if it has more
    if (keywordPagination?.hasMore) {
      const keywordOffset = accumulatedKeyword.length;
      const params = new URLSearchParams({
        q: currentQuery,
        types: 'keyword',
        limit: String(SEARCH_BATCH_SIZE),
        offset: String(keywordOffset),
      });

      fetch(`/api/search?${params.toString()}`, { signal: keywordController.signal })
        .then(async (response) => {
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
          }
          return response.json();
        })
        .then((data: SearchResponse) => {
          if (keywordController.signal.aborted || data.query !== currentQuery) return;
          setAccumulatedKeyword(prev => {
            const prevPaths = new Set(prev.map(item => item.path));
            const additions = data.results.filter(item => !prevPaths.has(item.path));
            return [...prev, ...additions];
          });
          setKeywordPagination(data.pagination);
        })
        .catch((err) => {
          if (err instanceof Error && err.name === 'AbortError') return;
          console.error('Load more keyword error:', err);
          if (!hasError) {
            hasError = true;
            setLoadMoreError(err instanceof Error ? err.message : 'Failed to load more results');
          }
        })
        .finally(() => {
          keywordDone = true;
          checkComplete();
        });
    } else {
      keywordDone = true;
    }

    // Fire semantic load more if it has more
    if (semanticPagination?.hasMore) {
      const semanticOffset = accumulatedSemantic.length;
      const params = new URLSearchParams({
        q: currentQuery,
        types: 'semantic',
        limit: String(SEARCH_BATCH_SIZE),
        offset: String(semanticOffset),
      });

      fetch(`/api/search?${params.toString()}`, { signal: semanticController.signal })
        .then(async (response) => {
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `HTTP ${response.status}`);
          }
          return response.json();
        })
        .then((data: SearchResponse) => {
          if (semanticController.signal.aborted || data.query !== currentQuery) return;
          setAccumulatedSemantic(prev => {
            const prevPaths = new Set(prev.map(item => item.path));
            const additions = data.results.filter(item => !prevPaths.has(item.path));
            return [...prev, ...additions];
          });
          setSemanticPagination(data.pagination);
        })
        .catch((err) => {
          if (err instanceof Error && err.name === 'AbortError') return;
          console.error('Load more semantic error:', err);
          if (!hasError) {
            hasError = true;
            setLoadMoreError(err instanceof Error ? err.message : 'Failed to load more results');
          }
        })
        .finally(() => {
          semanticDone = true;
          checkComplete();
        });
    } else {
      semanticDone = true;
    }

    // If neither has more, we're done immediately
    checkComplete();
  }, [currentQuery, canLoadMore, isLoadingMore, keywordPagination?.hasMore, semanticPagination?.hasMore, accumulatedKeyword.length, accumulatedSemantic.length]);

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
    (keywordResults !== null || semanticResults !== null) &&
    !hasResults;

  return (
    <ModalNavigationProvider files={orderedResults}>
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
                  matchedObject={result.matchedObject}
                  priority={index === array.length - 1}
                  onLocateInFeed={onLocateInFeed ? () => onLocateInFeed(result.path, result.createdAt) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalNavigationProvider>
  );
}
