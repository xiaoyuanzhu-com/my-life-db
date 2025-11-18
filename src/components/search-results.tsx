'use client';

import { useEffect, useState } from 'react';
import { FileCard } from './FileCard';
import type { SearchResponse } from '@/app/api/search/route';

interface SearchResultsProps {
  results: SearchResponse | null;
  isSearching: boolean;
  error: string | null;
}

function SearchingIndicator() {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev + 1) % 4);
    }, 400);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-sm text-muted-foreground">
        Searching{'.'.repeat(dots)}
      </p>
    </div>
  );
}

export function SearchResults({ results, isSearching, error }: SearchResultsProps) {
  // Show searching indicator
  if (isSearching) {
    return <SearchingIndicator />;
  }

  // Show error state
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <p className="text-sm text-destructive">
          Failed to search related files, got error: {error}
        </p>
      </div>
    );
  }

  // Show empty state
  if (results && results.results.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <p className="text-sm text-muted-foreground">
          No related files
        </p>
      </div>
    );
  }

  // Don't show anything if no results yet
  if (!results) {
    return null;
  }

  // Show results
  return (
    <div className="flex-1 overflow-y-auto px-4 pb-4">
      <div className="space-y-4 max-w-3xl mx-auto">
        {/* Results header */}
        <div className="flex items-center justify-between pt-4">
          <p className="text-sm text-muted-foreground">
            Related files
          </p>
          {results.timing && (
            <p className="text-xs text-muted-foreground">
              {results.timing.totalMs}ms
            </p>
          )}
        </div>

        {/* Result cards */}
        {results.results.map((result) => (
          <FileCard
            key={result.path}
            file={result}
            showTimestamp={true}
          />
        ))}

        {/* Load more button */}
        {results.pagination.hasMore && (
          <button
            type="button"
            className="w-full py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Load more results
          </button>
        )}
      </div>
    </div>
  );
}
