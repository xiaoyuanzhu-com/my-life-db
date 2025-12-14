/**
 * Card component for displaying pending (local) inbox items
 * Shows upload status, progress, and allows cancel action
 */

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { X, FileText, Image, File, Loader2, Check, AlertCircle, Clock } from 'lucide-react';
import { cn } from '~/lib/utils';
import type { PendingInboxItem } from '~/lib/send-queue';

interface PendingItemCardProps {
  item: PendingInboxItem;
  onCancel: (id: string) => Promise<void>;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) {
    return Image;
  }
  if (mimeType === 'text/markdown' || mimeType.startsWith('text/')) {
    return FileText;
  }
  return File;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1000;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

export function PendingItemCard({ item, onCancel }: PendingItemCardProps) {
  const [isCanceling, setIsCanceling] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);

  // Generate preview for images and text
  useState(() => {
    if (item.type.startsWith('image/')) {
      const url = URL.createObjectURL(item.blob);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }

    if (item.type === 'text/markdown' || item.type.startsWith('text/')) {
      item.blob.text().then((text) => {
        setTextPreview(text.slice(0, 500));
      });
    }
  });

  const handleCancel = async () => {
    setIsCanceling(true);
    try {
      await onCancel(item.id);
    } finally {
      setIsCanceling(false);
    }
  };

  const FileIcon = getFileIcon(item.type);
  const isUploading = item.status === 'uploading' && item.uploadProgress > 0;
  const hasError = !!item.errorMessage;

  // Status indicator
  let StatusIcon = Clock;
  let statusColor = 'text-muted-foreground';
  let statusText = 'Saved';

  if (isUploading) {
    StatusIcon = Loader2;
    statusColor = 'text-primary';
    statusText = `${item.uploadProgress}%`;
  } else if (hasError) {
    StatusIcon = AlertCircle;
    statusColor = 'text-destructive';
    statusText = 'Error';
  } else if (item.status === 'uploaded') {
    StatusIcon = Check;
    statusColor = 'text-green-500';
    statusText = 'Done';
  }

  return (
    <div className="group relative rounded-lg bg-card p-4">
      {/* Progress bar background */}
      {isUploading && (
        <div
          className="absolute inset-0 bg-primary/5 rounded-lg transition-all duration-300"
          style={{ width: `${item.uploadProgress}%` }}
        />
      )}

      <div className="relative z-10">
        {/* Header with status */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusIcon className={cn('h-3 w-3', statusColor, isUploading && 'animate-spin')} />
            <span className={statusColor}>{statusText}</span>
            <span>-</span>
            <span>{formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</span>
          </div>

          {/* Cancel button */}
          <button
            onClick={handleCancel}
            disabled={isCanceling}
            className={cn(
              'p-1 rounded-full hover:bg-muted transition-colors',
              'opacity-0 group-hover:opacity-100 focus:opacity-100',
              isCanceling && 'opacity-50 cursor-not-allowed'
            )}
            aria-label="Cancel upload"
          >
            {isCanceling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Content preview */}
        {previewUrl ? (
          // Image preview
          <div className="rounded-md overflow-hidden">
            <img
              src={previewUrl}
              alt={item.filename}
              className="max-h-64 w-full object-contain bg-muted"
            />
          </div>
        ) : textPreview ? (
          // Text preview
          <div className="text-sm text-foreground/90 whitespace-pre-wrap line-clamp-6">
            {textPreview}
          </div>
        ) : (
          // Generic file
          <div className="flex items-center gap-3 p-3 bg-muted rounded-md">
            <FileIcon className="h-8 w-8 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{item.filename}</p>
              <p className="text-xs text-muted-foreground">{formatFileSize(item.size)}</p>
            </div>
          </div>
        )}

        {/* Error message */}
        {hasError && (
          <div className="mt-2 text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            <span>{item.errorMessage}</span>
            {item.nextRetryAt && (
              <span className="text-muted-foreground">
                - Retrying {formatDistanceToNow(new Date(item.nextRetryAt), { addSuffix: true })}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
