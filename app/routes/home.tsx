import { useState, useCallback, useEffect, useRef } from "react";
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
    results: SearchResponse | null;
    isSearching: boolean;
    error: string | null;
  }>({
    results: null,
    isSearching: false,
    error: null,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const [inputMaxHeight, setInputMaxHeight] = useState<number | null>(null);
  const [lastSuccessfulResults, setLastSuccessfulResults] = useState<SearchResponse | null>(null);

  useEffect(() => {
    if (searchState.results && searchState.results.results.length > 0) {
      setLastSuccessfulResults(searchState.results);
    } else if (searchState.results !== null && searchState.results.results.length === 0) {
      setLastSuccessfulResults(null);
    }
  }, [searchState.results]);

  const hasCurrentResults = searchState.results !== null && searchState.results.results.length > 0;
  const isSearchingWithPreviousResults = searchState.isSearching && lastSuccessfulResults !== null;
  const showSearchResults = hasCurrentResults || isSearchingWithPreviousResults;
  const displayResults = hasCurrentResults ? searchState.results : lastSuccessfulResults;

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
            <SearchResults results={displayResults} isSearching={searchState.isSearching} error={searchState.error} />
          </div>
        )}
      </div>

      <div className="flex-none bg-background">
        <div className="max-w-3xl md:max-w-4xl mx-auto w-full px-4 md:px-4 py-4">
          <PinnedTags onTagClick={handlePinnedTagClick} onRefresh={refreshTrigger} />
          <OmniInput
            onEntryCreated={handleEntryCreated}
            onSearchStateChange={setSearchState}
            maxHeight={inputMaxHeight ?? undefined}
            searchStatus={{
              isSearching: searchState.isSearching,
              hasNoResults:
                searchState.results !== null && searchState.results.results.length === 0 && !searchState.isSearching,
              hasError: searchState.error !== null && !searchState.isSearching,
              resultCount:
                hasCurrentResults && !searchState.isSearching && searchState.results
                  ? searchState.results.results.length
                  : undefined,
            }}
          />
        </div>
      </div>
    </div>
  );
}
