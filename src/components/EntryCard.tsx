'use client';

import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { formatDistanceToNow } from 'date-fns';
import type { Entry } from '@/types';

interface EntryCardProps {
  entry: Entry;
  onDelete?: (entryId: string) => void;
  onMove?: (entryId: string) => void;
}

export function EntryCard({ entry, onDelete, onMove }: EntryCardProps) {
  const createdDate = new Date(entry.metadata.createdAt);
  const timeAgo = formatDistanceToNow(createdDate, { addSuffix: true });

  // Extract first line as title or truncate content
  const displayTitle = entry.metadata.title ||
    entry.content.split('\n')[0].substring(0, 80) +
    (entry.content.split('\n')[0].length > 80 ? '...' : '');

  const displayContent = entry.metadata.title
    ? entry.content.substring(0, 200) + (entry.content.length > 200 ? '...' : '')
    : entry.content.split('\n').slice(1).join('\n').substring(0, 200) + (entry.content.length > 200 ? '...' : '');

  return (
    <Card className="group transition-shadow hover:shadow-md">
      <CardContent className="space-y-3">
        <div>
          <h3 className="font-medium text-foreground line-clamp-2">
            {displayTitle}
          </h3>
          {displayContent && (
            <p className="mt-2 text-sm text-muted-foreground line-clamp-3 whitespace-pre-wrap">
              {displayContent}
            </p>
          )}
        </div>

        {entry.metadata.tags && entry.metadata.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.metadata.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary"
              >
                #{tag}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-xs text-muted-foreground">{timeAgo}</span>

          <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            {onMove && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onMove(entry.metadata.id)}
              >
                Move
              </Button>
            )}
            {onDelete && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => onDelete(entry.metadata.id)}
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
