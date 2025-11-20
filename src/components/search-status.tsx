'use client';

import { useEffect, useState } from 'react';

interface SearchStatusProps {
  isSearching: boolean;
  hasNoResults: boolean;
  hasError: boolean;
}

export function SearchStatus({ isSearching, hasNoResults, hasError }: SearchStatusProps) {
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

  if (hasNoResults) {
    return (
      <div className="text-xs text-muted-foreground">
        No related files
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

  return null;
}
