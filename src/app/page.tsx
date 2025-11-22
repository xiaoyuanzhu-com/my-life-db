'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { OmniInput } from '@/components/omni-input';
import { InboxFeed } from '@/components/inbox-feed';
import { SearchResults } from '@/components/search-results';
import { useInboxNotifications } from '@/hooks/use-inbox-notifications';
import type { SearchResponse } from '@/app/api/search/route';

export default function HomePage() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);
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

  // Track the last successful search results to keep them visible during searching
  const [lastSuccessfulResults, setLastSuccessfulResults] = useState<SearchResponse | null>(null);

  // Update last successful results when we get new results
  useEffect(() => {
    if (searchState.results && searchState.results.results.length > 0) {
      setLastSuccessfulResults(searchState.results);
    } else if (searchState.results !== null && searchState.results.results.length === 0) {
      // Clear last results when we get explicit no-results response
      setLastSuccessfulResults(null);
    }
  }, [searchState.results]);

  // Show search results only when actively searching with previous results OR has current results
  const hasCurrentResults = searchState.results !== null && searchState.results.results.length > 0;
  const isSearchingWithPreviousResults = searchState.isSearching && lastSuccessfulResults !== null;
  const showSearchResults = hasCurrentResults || isSearchingWithPreviousResults;

  // Use current results if available, otherwise show last successful results while searching
  const displayResults = hasCurrentResults ? searchState.results : lastSuccessfulResults;

  const handleEntryCreated = () => {
    // Trigger inbox refresh by updating the trigger value
    setRefreshTrigger(prev => prev + 1);
  };

  // Handle inbox changes from real-time notifications
  const handleInboxChange = useCallback(() => {
    setRefreshTrigger(prev => prev + 1);
  }, []);

  // Setup real-time notifications (auto-refresh only)
  useInboxNotifications({
    onInboxChange: handleInboxChange,
  });

  // Cap the input area to half of the available page container height
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateMaxHeight = () => {
      const nextHeight = container.clientHeight / 2;
      setInputMaxHeight(prev => (prev === nextHeight ? prev : nextHeight));
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
      {/* Scrollable feed area - shows either SearchResults or InboxFeed */}
      <div className="flex-1 overflow-hidden relative">
        {/* Keep InboxFeed always mounted to avoid reloading */}
        <div className={`absolute inset-0 overflow-y-auto ${showSearchResults ? 'invisible' : 'visible'}`}>
          <InboxFeed onRefresh={refreshTrigger} />
        </div>

        {/* Show SearchResults when needed */}
        {showSearchResults && (
          <div className="absolute inset-0 overflow-y-auto">
            <SearchResults
              results={displayResults}
              isSearching={searchState.isSearching}
              error={searchState.error}
            />
          </div>
        )}
      </div>

      {/* Fixed input at bottom */}
      <div className="flex-none bg-background">
        <div className="max-w-3xl md:max-w-4xl mx-auto w-full px-4 md:px-4 py-4">
          <OmniInput
            onEntryCreated={handleEntryCreated}
            onSearchStateChange={setSearchState}
            maxHeight={inputMaxHeight ?? undefined}
            searchStatus={{
              isSearching: searchState.isSearching,
              hasNoResults: searchState.results !== null && searchState.results.results.length === 0 && !searchState.isSearching,
              hasError: searchState.error !== null && !searchState.isSearching,
              resultCount: hasCurrentResults && !searchState.isSearching && searchState.results ? searchState.results.results.length : undefined,
            }}
          />
        </div>
      </div>
    </div>
  );
}
