'use client';

import { SearchResultCard } from './SearchResultCard';
import type { SearchResponse } from '@/app/api/search/route';

interface SearchResultsProps {
  results: SearchResponse | null;
  isSearching: boolean;
  error: string | null;
}

export function SearchResults({ results, isSearching, error }: SearchResultsProps) {
  // Only show if we have actual results (non-empty)
  if (!results || results.results.length === 0 || isSearching || error) {
    return null;
  }

  return (
    <div className="mt-4 w-full">
      <div className="space-y-3">
        {/* Results header */}
        <div className="flex items-center justify-between">
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
        <div className="space-y-2">
          {results.results.map((result) => (
            <SearchResultCard key={result.path} result={result} />
          ))}
        </div>

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
