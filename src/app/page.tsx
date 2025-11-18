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
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
      {/* Scrollable feed area - shows either InboxFeed or SearchResults */}
      <div className="flex-1 min-h-0 overflow-hidden">
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
      <div className="flex-shrink-0 bg-background">
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
