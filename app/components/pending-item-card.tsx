/**
 * Card component for displaying pending (local) inbox items
 * Matches FileCard layout: timestamp outside on top, card content below
 */

import { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { X, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '~/lib/utils';
import type { PendingInboxItem } from '~/lib/send-queue';
import { cardContainerClass } from './FileCard/ui/card-styles';
import { Spinner } from './ui/spinner';

/** Threshold in ms before showing spinner (3 seconds) */
const SPINNER_DELAY_MS = 3000;
/** Threshold in bytes for showing progress (1MB) */
const PROGRESS_SIZE_THRESHOLD = 1_000_000;

/**
 * Format time until next retry in human-readable format
 * e.g., "5s", "2m", "1h"
 */
function formatRetryTime(nextRetryAt: string): string {
  const now = Date.now();
  const retryTime = new Date(nextRetryAt).getTime();
  const diffMs = Math.max(0, retryTime - now);

  const seconds = Math.ceil(diffMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}

interface PendingItemCardProps {
  item: PendingInboxItem;
  onCancel: (id: string) => Promise<void>;
}

export function PendingItemCard({ item, onCancel }: PendingItemCardProps) {
  const [isCanceling, setIsCanceling] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [, setTick] = useState(0); // Force re-render for countdown updates

  // Update countdown every second when there's a retry scheduled
  useEffect(() => {
    if (!item.nextRetryAt || !item.errorMessage) return;

    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [item.nextRetryAt, item.errorMessage]);

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

  // Determine status display
  const hasError = !!item.errorMessage && item.nextRetryAt;
  const ageMs = Date.now() - new Date(item.createdAt).getTime();
  const showSpinner = ageMs >= SPINNER_DELAY_MS;
  const showProgress = item.size >= PROGRESS_SIZE_THRESHOLD;

  // Render status indicator with icon and text
  // States:
  // 1. Failed with retry: CircleAlert + "retry in Xs"
  // 2. < 3s since created: no marker
  // 3. >= 3s since created: Spinner (+ progress% if file > 1MB)
  const renderStatusIndicator = () => {
    if (hasError && item.nextRetryAt) {
      // Failed with retry scheduled: circle-alert with retry time
      const retryTimeMs = new Date(item.nextRetryAt).getTime() - Date.now();
      if (retryTimeMs <= 0) {
        // Retry time reached, show retrying state with spinner
        return <Spinner className="h-3 w-3" />;
      }
      return (
        <span className="flex items-center gap-1 text-destructive">
          <CircleAlert className="h-3 w-3" />
          retry in {formatRetryTime(item.nextRetryAt)}
        </span>
      );
    }

    if (!showSpinner) {
      // Less than 3s since created: no marker
      return null;
    }

    // >= 3s: show spinner, optionally with progress for large files
    if (showProgress && item.uploadProgress > 0) {
      return (
        <span className="flex items-center gap-1">
          <Spinner className="h-3 w-3" />
          {item.uploadProgress}%
        </span>
      );
    }

    // Spinner only
    return <Spinner className="h-3 w-3" />;
  };

  return (
    <div className="w-full flex flex-col items-end">
      {/* Timestamp + status marker outside card (like FileCard) */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2 mr-5 select-none">
        <span>{formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}</span>
        {renderStatusIndicator()}
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
        {/* Progress bar overlay - show for large files during upload */}
        {showProgress && item.uploadProgress > 0 && (
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
