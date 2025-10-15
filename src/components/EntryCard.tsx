'use client';

import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { formatDistanceToNow } from 'date-fns';
import { FileText, Download, Image as ImageIcon } from 'lucide-react';
import type { Entry } from '@/types';
import Image from 'next/image';

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

  // Check if attachment is an image
  const isImage = (mimeType: string) => mimeType.startsWith('image/');

  // Get file path for download
  const getFilePath = (filename: string) => {
    // Construct path: /api/files/{date}/{id}/{filename}
    return `/api/files/${entry.date}/${entry.metadata.id}/${filename}`;
  };

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

        {/* Attachments */}
        {entry.metadata.attachments && entry.metadata.attachments.length > 0 && (
          <div className="space-y-2">
            {/* Image attachments - show full images */}
            {entry.metadata.attachments.filter(att => isImage(att.mimeType)).length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {entry.metadata.attachments
                  .filter(att => isImage(att.mimeType))
                  .map((attachment, index) => (
                    <a
                      key={index}
                      href={getFilePath(attachment.filename)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="relative aspect-video rounded-md overflow-hidden bg-muted hover:opacity-90 transition-opacity group/image flex items-center justify-center"
                    >
                      <Image
                        src={getFilePath(attachment.filename)}
                        alt={attachment.filename}
                        fill
                        className="object-contain"
                        sizes="(max-width: 768px) 50vw, 33vw"
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover/image:bg-black/10 transition-colors" />
                    </a>
                  ))}
              </div>
            )}

            {/* Non-image attachments - show as list */}
            {entry.metadata.attachments.filter(att => !isImage(att.mimeType)).length > 0 && (
              <div className="space-y-1">
                {entry.metadata.attachments
                  .filter(att => !isImage(att.mimeType))
                  .map((attachment, index) => (
                    <a
                      key={index}
                      href={getFilePath(attachment.filename)}
                      download
                      className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted hover:bg-muted/80 transition-colors text-sm group/file"
                    >
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <span className="flex-1 truncate">{attachment.filename}</span>
                      <span className="text-xs text-muted-foreground">
                        {(attachment.size / 1024).toFixed(1)} KB
                      </span>
                      <Download className="h-4 w-4 text-muted-foreground opacity-0 group-hover/file:opacity-100 transition-opacity" />
                    </a>
                  ))}
              </div>
            )}
          </div>
        )}

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
