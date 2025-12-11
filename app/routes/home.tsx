import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { OmniInput } from "~/components/omni-input";
import { InboxFeed } from "~/components/inbox-feed";
import { SearchResults } from "~/components/search-results";
import { PinnedTags } from "~/components/pinned-tags";
import { useInboxNotifications } from "~/hooks/use-inbox-notifications";
import type { SearchResponse } from "~/routes/api.search";

export default function HomePage() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [scrollToPath, setScrollToPath] = useState<string | undefined>(undefined);
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

  const handlePinnedTagClick = useCallback((path: string) => {
    setScrollToPath(path);
  }, []);

  const handleScrollComplete = useCallback(() => {
    setScrollToPath(undefined);
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
          <InboxFeed onRefresh={refreshTrigger} scrollToPath={scrollToPath} onScrollComplete={handleScrollComplete} />
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
            />
          </div>
        )}
      </div>

      <div className="flex-none bg-background">
        <div className="max-w-3xl md:max-w-4xl mx-auto w-full px-4 md:px-4 py-4">
          <PinnedTags onTagClick={handlePinnedTagClick} onRefresh={refreshTrigger} />
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
          />
        </div>
      </div>
    </div>
  );
}
