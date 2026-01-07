import { useEffect, useState, useCallback } from 'react';
import { Pin, X } from 'lucide-react';
import { cn } from '~/lib/utils';
import type { PinnedItem } from '~/types/pin';

interface PinnedTagsProps {
  onTagClick: (cursor: string) => void;
  onRefresh?: number;
}

export function PinnedTags({ onTagClick, onRefresh }: PinnedTagsProps) {
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([]);

  const loadPinnedItems = useCallback(async () => {
    try {
      const response = await fetch('/api/inbox/pinned');
      if (response.status === 401) {
        // Auth required but not authenticated - redirect to login (only if not already there)
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
        return;
      }
      if (response.ok) {
        const data = await response.json();
        setPinnedItems(data.items);
      }
    } catch (error) {
      console.error('Failed to load pinned items:', error);
    }
  }, []);

  useEffect(() => {
    loadPinnedItems();
  }, [loadPinnedItems, onRefresh]);

  const handleUnpin = useCallback(async (path: string, e: React.MouseEvent) => {
    e.stopPropagation();

    try {
      const response = await fetch('/api/library/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });

      if (response.ok) {
        setPinnedItems(prev => prev.filter(item => item.path !== path));
      }
    } catch (error) {
      console.error('Failed to unpin:', error);
      loadPinnedItems();
    }
  }, [loadPinnedItems]);

  if (pinnedItems.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 pb-3">
      {pinnedItems.map(item => (
        <div
          key={item.path}
          className={cn(
            "group flex items-center gap-1.5 px-3 py-1.5 rounded-full cursor-pointer",
            "bg-primary/10 hover:bg-primary/20",
            "border border-primary/20 hover:border-primary/30",
            "transition-colors duration-150",
            "max-w-xs"
          )}
          onClick={() => onTagClick(item.cursor)}
        >
          <Pin className="h-3 w-3 text-primary flex-shrink-0" />
          <span className="text-xs font-medium text-primary truncate">
            {item.displayText}
          </span>
          <button
            onClick={(e) => handleUnpin(item.path, e)}
            className={cn(
              "ml-1 p-0.5 rounded-full",
              "opacity-0 group-hover:opacity-100",
              "hover:bg-primary/20",
              "transition-opacity duration-150"
            )}
            aria-label="Unpin"
          >
            <X className="h-3 w-3 text-primary" />
          </button>
        </div>
      ))}
    </div>
  );
}
