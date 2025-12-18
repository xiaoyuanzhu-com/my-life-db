import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { OmniInput } from "~/components/omni-input";
import { InboxFeed } from "~/components/inbox-feed";
import { SearchResults } from "~/components/search-results";
import { PinnedTags } from "~/components/pinned-tags";
import { MultiSelectActionBar } from "~/components/multi-select-action-bar";
import { SelectionProvider, useSelectionMode } from "~/contexts/selection-context";
import { useInboxNotifications } from "~/hooks/use-inbox-notifications";
import { cn } from "~/lib/utils";
import type { SearchResponse } from "~/routes/api.search";

export default function HomePage() {
  return (
    <SelectionProvider>
      <HomePageContent />
    </SelectionProvider>
  );
}

function HomePageContent() {
  const { isSelectionMode, clearSelection } = useSelectionMode();
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [scrollToCursor, setScrollToCursor] = useState<string | undefined>(undefined);
  const [searchState, setSearchState] = useState<{
    keywordResults: SearchResponse | null;
    semanticResults: SearchResponse | null;
    isKeywordSearching: boolean;
    isSemanticSearching: boolean;
    keywordError: string | null;
    semanticError: string | null;
  }>({
    keywordResults: null,
    semanticResults: null,
    isKeywordSearching: false,
    isSemanticSearching: false,
    keywordError: null,
    semanticError: null,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const [inputMaxHeight, setInputMaxHeight] = useState<number | null>(null);
  const [lastSuccessfulResults, setLastSuccessfulResults] = useState<SearchResponse | null>(null);
  const [clearSearchTrigger, setClearSearchTrigger] = useState(0);

  // Derive combined state from keyword and semantic results
  const isSearching = searchState.isKeywordSearching || searchState.isSemanticSearching;
  const hasAnyResults =
    (searchState.keywordResults?.results?.length ?? 0) > 0 ||
    (searchState.semanticResults?.results?.length ?? 0) > 0;
  const bothFailed =
    searchState.keywordError !== null &&
    searchState.semanticError !== null &&
    !searchState.isKeywordSearching &&
    !searchState.isSemanticSearching;
  const error = bothFailed ? (searchState.keywordError || searchState.semanticError) : null;

  // Get the query from whichever result is available
  const currentQuery = searchState.keywordResults?.query || searchState.semanticResults?.query || '';

  // Calculate deduplicated result count (same merge logic as SearchResults)
  const mergedResultCount = useMemo(() => {
    const keywordResults = searchState.keywordResults?.results ?? [];
    const semanticResults = searchState.semanticResults?.results ?? [];

    if (keywordResults.length === 0 && semanticResults.length === 0) {
      return 0;
    }

    const paths = new Set<string>();
    for (const item of keywordResults) {
      paths.add(item.path);
    }
    for (const item of semanticResults) {
      paths.add(item.path);
    }
    return paths.size;
  }, [searchState.keywordResults?.results, searchState.semanticResults?.results]);

  useEffect(() => {
    if (hasAnyResults) {
      // Create a merged result for lastSuccessfulResults tracking
      const mergedForTracking: SearchResponse = {
        results: [],
        pagination: { total: 0, limit: 30, offset: 0, hasMore: false },
        query: currentQuery,
        timing: { totalMs: 0, searchMs: 0, enrichMs: 0 },
        sources: [],
      };
      setLastSuccessfulResults(mergedForTracking);
    } else if (
      searchState.keywordResults !== null ||
      searchState.semanticResults !== null
    ) {
      // Both returned but empty
      if (!hasAnyResults && !isSearching) {
        setLastSuccessfulResults(null);
      }
    }
  }, [searchState.keywordResults, searchState.semanticResults, hasAnyResults, isSearching, currentQuery]);

  const hasCurrentResults = hasAnyResults;
  const isSearchingWithPreviousResults = isSearching && lastSuccessfulResults !== null;
  const showSearchResults = hasCurrentResults || isSearchingWithPreviousResults;

  const handleEntryCreated = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleInboxChange = useCallback(() => {
    setRefreshTrigger((prev) => prev + 1);
  }, []);

  const handlePinnedTagClick = useCallback((cursor: string) => {
    setScrollToCursor(cursor);
  }, []);

  const handleScrollComplete = useCallback(() => {
    setScrollToCursor(undefined);
  }, []);

  const handleLocateInFeed = useCallback((path: string, createdAt: string) => {
    // Clear search results and input
    setClearSearchTrigger((prev) => prev + 1);
    setLastSuccessfulResults(null);

    // Build cursor and trigger scroll
    const cursor = `${createdAt}:${path}`;
    setScrollToCursor(cursor);
  }, []);

  useInboxNotifications({
    onInboxChange: handleInboxChange,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateMaxHeight = () => {
      const nextHeight = container.clientHeight / 2;
      setInputMaxHeight((prev) => (prev === nextHeight ? prev : nextHeight));
    };

    updateMaxHeight();

    const resizeObserver = new ResizeObserver(() => {
      updateMaxHeight();
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden flex flex-col">
      <div className="flex-1 overflow-hidden relative">
        <div className={`absolute inset-0 overflow-y-auto ${showSearchResults ? "invisible" : "visible"}`}>
          <InboxFeed onRefresh={refreshTrigger} scrollToCursor={scrollToCursor} onScrollComplete={handleScrollComplete} />
        </div>

        {showSearchResults && (
          <div className="absolute inset-0 overflow-y-auto">
            <SearchResults
              keywordResults={searchState.keywordResults}
              semanticResults={searchState.semanticResults}
              isKeywordSearching={searchState.isKeywordSearching}
              isSemanticSearching={searchState.isSemanticSearching}
              keywordError={searchState.keywordError}
              semanticError={searchState.semanticError}
              onLocateInFeed={handleLocateInFeed}
            />
          </div>
        )}
      </div>

      <div className="flex-none bg-background">
        <div className="max-w-3xl md:max-w-4xl mx-auto w-full px-4 md:px-4 py-4">
          <PinnedTags onTagClick={handlePinnedTagClick} onRefresh={refreshTrigger} />

          {/* Animated container for OmniInput / MultiSelectActionBar */}
          <div className="relative overflow-hidden">
            {/* OmniInput - visible when not in selection mode */}
            <div
              className={cn(
                "transition-all duration-200 ease-out",
                isSelectionMode
                  ? "opacity-0 -translate-y-4 h-0 pointer-events-none"
                  : "opacity-100 translate-y-0"
              )}
            >
              <OmniInput
                onEntryCreated={handleEntryCreated}
                onSearchResultsChange={setSearchState}
                maxHeight={inputMaxHeight ?? undefined}
                searchStatus={{
                  isSearching,
                  hasNoResults: !hasAnyResults && !isSearching && (searchState.keywordResults !== null || searchState.semanticResults !== null),
                  hasError: error !== null,
                  resultCount: hasCurrentResults ? mergedResultCount : undefined,
                }}
                clearSearchTrigger={clearSearchTrigger}
              />
            </div>

            {/* MultiSelectActionBar - visible in selection mode */}
            <div
              className={cn(
                "transition-all duration-200 ease-out",
                isSelectionMode
                  ? "opacity-100 translate-y-0"
                  : "opacity-0 translate-y-4 h-0 pointer-events-none"
              )}
            >
              <MultiSelectActionBar
                onDeleted={() => {
                  setRefreshTrigger((prev) => prev + 1);
                  clearSelection();
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
