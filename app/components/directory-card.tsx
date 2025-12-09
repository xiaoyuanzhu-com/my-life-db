'use client';

import { Card, CardContent } from './ui/card';
import type { Directory } from '~/types';

interface DirectoryCardProps {
  directory: Directory;
}

export function DirectoryCard({ directory }: DirectoryCardProps) {
  const { metadata, entryCount, subdirectories } = directory;

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardContent className="space-y-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-2xl">
                {metadata.icon || '📁'}
              </div>
              <div>
                <h3 className="font-semibold text-foreground">{metadata.name}</h3>
                {metadata.description && (
                  <p className="text-sm text-muted-foreground line-clamp-1">
                    {metadata.description}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm text-muted-foreground pt-2 border-t">
            <span>{entryCount} {entryCount === 1 ? 'entry' : 'entries'}</span>
            {subdirectories.length > 0 && (
              <span>{subdirectories.length} {subdirectories.length === 1 ? 'folder' : 'folders'}</span>
            )}
          </div>
        </CardContent>
      </Card>
  );
}
