'use client';

import { useState } from 'react';
import { OmniInput } from '@/components/omni-input';
import { InboxFeed } from '@/components/inbox-feed';
import { SearchResults } from '@/components/search-results';
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

  // Determine if search is active (show search results instead of inbox)
  const isSearchActive = searchState.results !== null || searchState.isSearching || searchState.error !== null;

  const handleEntryCreated = () => {
    // Trigger inbox refresh by updating the trigger value
    setRefreshTrigger(prev => prev + 1);
  };

  return (
    <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
      {/* Scrollable feed area - shows either InboxFeed or SearchResults */}
      <div className="flex-1 overflow-y-auto">
        {isSearchActive ? (
          <SearchResults
            results={searchState.results}
            isSearching={searchState.isSearching}
            error={searchState.error}
          />
        ) : (
          <InboxFeed onRefresh={refreshTrigger} />
        )}
      </div>

      {/* Fixed input at bottom */}
      <div className="flex-none bg-background">
        <div className="max-w-3xl md:max-w-4xl mx-auto w-full px-4 py-4">
          <OmniInput
            onEntryCreated={handleEntryCreated}
            onSearchStateChange={setSearchState}
          />
        </div>
      </div>
    </div>
  );
}
