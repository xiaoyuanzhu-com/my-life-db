/**
 * Wrapper component to render PendingInboxItem using FileCard
 *
 * Converts local pending items to FileWithDigests format and manages
 * blob URL lifecycle. Also displays upload status overlay.
 */

import { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { X, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '~/lib/utils';
import { FileCard } from './FileCard';
import { Spinner } from './ui/spinner';
import type { PendingInboxItem } from '~/lib/send-queue';
import { usePendingItemAsFile } from '~/lib/send-queue';

/** Threshold in ms before showing spinner (3 seconds) */
const SPINNER_DELAY_MS = 3000;

/**
 * Format time until next retry in human-readable format
 */
function formatRetryTime(nextRetryAtMs: number): string {
  const diffMs = Math.max(0, nextRetryAtMs - Date.now());

  const seconds = Math.ceil(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}

interface PendingFileCardProps {
  item: PendingInboxItem;
  onCancel: (id: string) => Promise<void>;
}

export function PendingFileCard({ item, onCancel }: PendingFileCardProps) {
  const [isCanceling, setIsCanceling] = useState(false);
  const [, setTick] = useState(0); // Force re-render for countdown updates

  // Convert pending item to FileWithDigests
  const file = usePendingItemAsFile(item);

  // Update countdown every second when there's a retry scheduled
  useEffect(() => {
    if (!item.nextRetryAt || !item.errorMessage) return;

    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [item.nextRetryAt, item.errorMessage]);

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
  const ageMs = Date.now() - item.createdAt;
  const showSpinner = ageMs >= SPINNER_DELAY_MS;

  // Render status indicator
  const renderStatusIndicator = () => {
    if (hasError && item.nextRetryAt) {
      const retryTimeMs = item.nextRetryAt - Date.now();
      if (retryTimeMs <= 0) {
        return <Spinner className="h-3 w-3" />;
      }
      return (
        <span className="flex items-center gap-1 text-destructive">
          <CircleAlert className="h-3 w-3" />
          retry in {formatRetryTime(item.nextRetryAt)}
        </span>
      );
    }

    if (!showSpinner) return null;

    return <Spinner className="h-3 w-3" />;
  };

  return (
    <div className="w-full flex flex-col items-end">
      {/* Custom timestamp row with status and cancel button */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2 mr-5 select-none">
        <span>{formatDistanceToNow(item.createdAt, { addSuffix: true })}</span>
        {renderStatusIndicator()}
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

      {/* Use FileCard for content rendering */}
      <FileCard
        file={file}
        showTimestamp={false}
      />
    </div>
  );
}
