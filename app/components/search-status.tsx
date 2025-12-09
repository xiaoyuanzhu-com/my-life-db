'use client';

import { useEffect, useState } from 'react';

interface SearchStatusProps {
  isSearching: boolean;
  hasNoResults: boolean;
  hasError: boolean;
  resultCount?: number;
}

export function SearchStatus({ isSearching, hasNoResults, hasError, resultCount }: SearchStatusProps) {
  const [dots, setDots] = useState(0);

  // Animate dots for searching state
  useEffect(() => {
    if (!isSearching) {
      setDots(0);
      return;
    }

    const interval = setInterval(() => {
      setDots(prev => (prev + 1) % 4); // 0, 1, 2, 3, then back to 0
    }, 500);

    return () => clearInterval(interval);
  }, [isSearching]);

  if (isSearching) {
    return (
      <div className="text-xs text-muted-foreground flex items-center">
        <span>Searching</span>
        <span className="inline-block w-3 text-left">{'.'.repeat(dots)}</span>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="text-xs text-destructive">
        Search failed
      </div>
    );
  }

  // Show result count when search is complete (either with or without results)
  if (hasNoResults || (resultCount !== undefined && resultCount >= 0)) {
    const count = resultCount ?? 0;
    return (
      <div className="text-xs text-muted-foreground">
        {count} related {count === 1 ? 'file' : 'files'}
      </div>
    );
  }

  return null;
}
