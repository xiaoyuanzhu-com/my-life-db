/**
 * Card component for displaying pending (local) inbox items
 * Matches FileCard layout: timestamp outside on top, card content below
 */

import { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { X, Loader2 } from 'lucide-react';
import { cn } from '~/lib/utils';
import type { PendingInboxItem } from '~/lib/send-queue';
import { cardContainerClass } from './FileCard/ui/card-styles';

interface PendingItemCardProps {
  item: PendingInboxItem;
  onCancel: (id: string) => Promise<void>;
}

export function PendingItemCard({ item, onCancel }: PendingItemCardProps) {
  const [isCanceling, setIsCanceling] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);

  // Generate preview for images and text
  useEffect(() => {
    if (item.type.startsWith('image/')) {
      const url = URL.createObjectURL(item.blob);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }

    if (item.type === 'text/markdown' || item.type.startsWith('text/')) {
      item.blob.text().then((text) => {
        setTextPreview(text);
      });
    }
  }, [item.blob, item.type]);

  const handleCancel = async () => {
    setIsCanceling(true);
    try {
      await onCancel(item.id);
    } finally {
      setIsCanceling(false);
    }
  };

  // Status marker text (short)
  const getStatusMarker = (): string => {
    if (item.status === 'uploading' && item.uploadProgress > 0) {
      return `${item.uploadProgress}%`;
    }
    if (item.errorMessage) {
      return 'Retry';
    }
    if (item.status === 'uploaded') {
      return 'Done';
    }
    return 'Saved';
  };

  const isUploading = item.status === 'uploading' && item.uploadProgress > 0;
  const statusMarker = getStatusMarker();

  return (
    <div className="w-full flex flex-col items-end">
      {/* Timestamp + status marker outside card (like FileCard) */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2 mr-5 select-none">
        <span>{formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</span>
        <span>·</span>
        <span className="flex items-center gap-1">
          {isUploading && <Loader2 className="h-3 w-3 animate-spin" />}
          {statusMarker}
        </span>
        {/* Cancel button inline with timestamp */}
        <button
          onClick={handleCancel}
          disabled={isCanceling}
          className={cn(
            'p-0.5 rounded hover:bg-muted-foreground/20 transition-colors',
            isCanceling && 'opacity-50 cursor-not-allowed'
          )}
          aria-label="Cancel upload"
        >
          {isCanceling ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <X className="h-3 w-3" />
          )}
        </button>
      </div>

      {/* Card content */}
      <div
        className={cn(
          cardContainerClass,
          'max-w-[calc(100%-40px)] w-fit relative'
        )}
      >
        {/* Progress bar overlay */}
        {isUploading && (
          <div
            className="absolute inset-y-0 left-0 bg-primary/10 transition-all duration-300"
            style={{ width: `${item.uploadProgress}%` }}
          />
        )}

        {/* Content */}
        <div className="relative">
          {previewUrl ? (
            // Image preview
            <div
              className="relative flex items-center justify-center"
              style={{ minWidth: 100, minHeight: 100 }}
            >
              <img
                src={previewUrl}
                alt={item.filename}
                className="object-contain"
                style={{
                  maxWidth: 'min(calc(100vw - 40px), 448px)',
                  maxHeight: 320,
                  width: 'auto',
                  height: 'auto',
                }}
              />
            </div>
          ) : textPreview ? (
            // Text preview (styled like TextCard)
            <div className="p-4 max-w-full">
              <div className="prose prose-sm dark:prose-invert max-w-none select-text">
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed font-content">
                  {textPreview.length > 500 ? (
                    <>
                      {textPreview.slice(0, 500)}
                      <span className="text-muted-foreground">...</span>
                    </>
                  ) : (
                    textPreview
                  )}
                </div>
              </div>
            </div>
          ) : (
            // Generic file preview
            <div className="p-4">
              <p className="text-sm font-medium truncate">{item.filename}</p>
              <p className="text-xs text-muted-foreground">
                {(item.size / 1000).toFixed(1)} KB
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
