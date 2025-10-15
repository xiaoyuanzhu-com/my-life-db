'use client';

import { Card, CardContent } from './ui/Card';
import { Button } from './ui/Button';
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
    <Card hover className="group">
      <CardContent className="space-y-3">
        <div>
          <h3 className="font-medium text-gray-900 line-clamp-2">
            {displayTitle}
          </h3>
          {displayContent && (
            <p className="mt-2 text-sm text-gray-600 line-clamp-3 whitespace-pre-wrap">
              {displayContent}
            </p>
          )}
        </div>

        {entry.metadata.tags && entry.metadata.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.metadata.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800"
              >
                #{tag}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <span className="text-xs text-gray-500">{timeAgo}</span>

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
                variant="ghost"
                onClick={() => onDelete(entry.metadata.id)}
                className="text-red-600 hover:bg-red-50"
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
