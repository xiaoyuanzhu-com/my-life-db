'use client';

import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { formatDistanceToNow } from 'date-fns';
import {
  FileText,
  Download,
  Sparkles,
  User,
  MapPin,
  Building,
  Lightbulb,
  CheckCircle2,
  Smile,
  Meh,
  Frown,
  AlertCircle,
} from 'lucide-react';
import type { Entry } from '@/types';
import Image from 'next/image';

interface EntryCardProps {
  entry: Entry;
  onDelete?: (entryId: string) => void;
  onMove?: (entryId: string) => void;
  onProcess?: (entryId: string) => void;
}

export function EntryCard({ entry, onDelete, onMove, onProcess }: EntryCardProps) {
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

  // Get sentiment icon
  const getSentimentIcon = () => {
    switch (entry.metadata.ai.sentiment) {
      case 'positive':
        return <Smile className="h-3.5 w-3.5 text-green-600" />;
      case 'negative':
        return <Frown className="h-3.5 w-3.5 text-red-600" />;
      case 'mixed':
        return <Meh className="h-3.5 w-3.5 text-yellow-600" />;
      default:
        return null;
    }
  };

  // Get priority badge color
  const getPriorityColor = () => {
    switch (entry.metadata.ai.priority) {
      case 'urgent':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'high':
        return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'medium':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  return (
    <Card className="group transition-shadow hover:shadow-md">
      <CardContent className="space-y-3">
        <div>
          <div className="flex items-start justify-between gap-2">
            <h3 className="flex-1 font-medium text-foreground line-clamp-2">
              {displayTitle}
            </h3>
            {entry.metadata.ai.processed && entry.metadata.ai.category && (
              <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                {entry.metadata.ai.category}
              </span>
            )}
          </div>

          {/* AI-generated summary */}
          {entry.metadata.ai.summary && (
            <div className="mt-2 flex gap-2 items-start">
              <Sparkles className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground italic line-clamp-2">
                {entry.metadata.ai.summary}
              </p>
            </div>
          )}

          {!entry.metadata.ai.summary && displayContent && (
            <p className="mt-2 text-sm text-muted-foreground line-clamp-3 whitespace-pre-wrap">
              {displayContent}
            </p>
          )}
        </div>

        {/* AI Extracted Information */}
        {entry.metadata.ai.processed && (
          <div className="space-y-2 pt-2 border-t">
            {/* Sentiment and Priority */}
            <div className="flex flex-wrap gap-2">
              {entry.metadata.ai.sentiment && entry.metadata.ai.sentiment !== 'neutral' && (
                <div className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-muted">
                  {getSentimentIcon()}
                  <span className="capitalize">{entry.metadata.ai.sentiment}</span>
                </div>
              )}
              {entry.metadata.ai.priority && entry.metadata.ai.priority !== 'low' && (
                <div className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-md border ${getPriorityColor()}`}>
                  <AlertCircle className="h-3 w-3" />
                  <span className="capitalize">{entry.metadata.ai.priority}</span>
                </div>
              )}
              {entry.metadata.ai.mood && (
                <div className="text-xs px-2 py-0.5 rounded-md bg-purple-100 text-purple-800 border border-purple-200">
                  {entry.metadata.ai.mood}
                </div>
              )}
            </div>

            {/* Entities */}
            {entry.metadata.ai.entities && (
              <div className="space-y-1">
                {entry.metadata.ai.entities.people && entry.metadata.ai.entities.people.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <User className="h-3 w-3" />
                    <span className="line-clamp-1">{entry.metadata.ai.entities.people.join(', ')}</span>
                  </div>
                )}
                {entry.metadata.ai.entities.places && entry.metadata.ai.entities.places.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <MapPin className="h-3 w-3" />
                    <span className="line-clamp-1">{entry.metadata.ai.entities.places.join(', ')}</span>
                  </div>
                )}
                {entry.metadata.ai.entities.organizations && entry.metadata.ai.entities.organizations.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Building className="h-3 w-3" />
                    <span className="line-clamp-1">{entry.metadata.ai.entities.organizations.join(', ')}</span>
                  </div>
                )}
                {entry.metadata.ai.entities.concepts && entry.metadata.ai.entities.concepts.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lightbulb className="h-3 w-3" />
                    <span className="line-clamp-1">{entry.metadata.ai.entities.concepts.join(', ')}</span>
                  </div>
                )}
              </div>
            )}

            {/* Action Items */}
            {entry.metadata.ai.actionItems && entry.metadata.ai.actionItems.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Action Items:
                </div>
                {entry.metadata.ai.actionItems.slice(0, 3).map((item, index) => (
                  <div key={index} className="text-xs text-muted-foreground pl-4 flex items-start gap-1.5">
                    <span className="shrink-0">•</span>
                    <span className="line-clamp-1">{item.task}</span>
                  </div>
                ))}
                {entry.metadata.ai.actionItems.length > 3 && (
                  <div className="text-xs text-muted-foreground pl-4">
                    +{entry.metadata.ai.actionItems.length - 3} more
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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
            {onProcess && !entry.metadata.ai.processed && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onProcess(entry.metadata.id)}
                className="gap-1.5"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Extract Info
              </Button>
            )}
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
