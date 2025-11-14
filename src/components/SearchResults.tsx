'use client';

import { SearchResultCard } from './SearchResultCard';
import type { SearchResponse } from '@/app/api/search/route';

interface SearchResultsProps {
  results: SearchResponse | null;
  isSearching: boolean;
  error: string | null;
}

export function SearchResults({ results, isSearching, error }: SearchResultsProps) {
  // Don't show anything if not searching and no results
  if (!isSearching && !results && !error) {
    return null;
  }

  return (
    <div className="mt-4 w-full">
      {/* Loading State */}
      {isSearching && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Searching...</p>
          {/* Skeleton loaders */}
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-lg bg-muted/50 p-4 animate-pulse"
            >
              <div className="h-4 bg-muted-foreground/10 rounded w-3/4 mb-2"></div>
              <div className="h-3 bg-muted-foreground/10 rounded w-1/2 mb-2"></div>
              <div className="h-3 bg-muted-foreground/10 rounded w-full"></div>
            </div>
          ))}
        </div>
      )}

      {/* Error State */}
      {error && !isSearching && (
        <div className="rounded-lg bg-destructive/10 p-4">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Results */}
      {results && !isSearching && (
        <div className="space-y-3">
          {/* Results header */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {results.results.length === 0 ? (
                <>No results found for &quot;{results.query}&quot;</>
              ) : (
                <>
                  Found {results.pagination.total.toLocaleString()} result
                  {results.pagination.total !== 1 ? 's' : ''} for &quot;{results.query}&quot;
                </>
              )}
            </p>
            {results.timing && (
              <p className="text-xs text-muted-foreground">
                {results.timing.totalMs}ms
              </p>
            )}
          </div>

          {/* Result cards */}
          {results.results.length > 0 && (
            <div className="space-y-2">
              {results.results.map((result) => (
                <SearchResultCard key={result.path} result={result} />
              ))}
            </div>
          )}

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
      )}
    </div>
  );
}
