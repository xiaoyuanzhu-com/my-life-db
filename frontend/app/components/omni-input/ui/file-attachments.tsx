import { useState, useEffect, useRef } from 'react';
import { Upload, X, Loader2, Check } from 'lucide-react';
import { cn } from '~/lib/utils';
import type { PendingInboxItem } from '~/lib/send-queue';

interface FileAttachmentsProps {
  files: File[];
  onRemove: (index: number) => void;
  uploadingItems?: PendingInboxItem[];
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1000;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function UploadingFileItem({ item }: { item: PendingInboxItem }) {
  const [phase, setPhase] = useState<'entering' | 'active' | 'exiting'>('entering');
  const mountedRef = useRef(true);

  // Animate in on mount
  useEffect(() => {
    mountedRef.current = true;
    const timer = setTimeout(() => {
      if (mountedRef.current) setPhase('active');
    }, 10);
    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, []);

  // Start exit animation when completed
  useEffect(() => {
    if (item.status === 'uploaded' && phase === 'active') {
      // Small delay to ensure completion state is visible
      const timer = setTimeout(() => {
        if (mountedRef.current) setPhase('exiting');
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [item.status, phase]);

  const isComplete = item.status === 'uploaded';
  const hasError = !!item.errorMessage;
  const progress = item.uploadProgress;

  return (
    <div
      className={cn(
        'flex items-center gap-2 relative overflow-hidden rounded-md p-2',
        'transition-all duration-300 ease-out',
        phase === 'entering' && 'opacity-0 translate-y-1',
        phase === 'active' && 'opacity-100 translate-y-0',
        phase === 'exiting' && 'opacity-0 -translate-y-1'
      )}
    >
      {/* Progress bar - fills from left */}
      <div
        className={cn(
          'absolute inset-0 rounded-md transition-all ease-out',
          isComplete ? 'duration-200' : 'duration-150',
          hasError ? 'bg-destructive/15' : isComplete ? 'bg-green-500/20' : 'bg-primary/10'
        )}
        style={{ width: `${progress}%` }}
      />

      {/* Icon - simple: spinner while uploading, check when done */}
      <div className="relative z-10 flex-shrink-0">
        {isComplete ? (
          <Check className="h-4 w-4 text-green-600" />
        ) : (
          <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
        )}
      </div>

      {/* Filename only - no percentage, cleaner look */}
      <span className="text-sm truncate flex-1 relative z-10">{item.filename}</span>

      {/* Error indicator */}
      {hasError && (
        <span className="text-xs text-destructive whitespace-nowrap relative z-10">
          retry...
        </span>
      )}
    </div>
  );
}

function PendingFileItem({
  file,
  index,
  onRemove
}: {
  file: File;
  index: number;
  onRemove: (index: number) => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 relative overflow-hidden',
        'bg-muted rounded-md p-2'
      )}
    >
      <Upload className="h-4 w-4 text-muted-foreground flex-shrink-0 relative z-10" />
      <div className="flex-1 min-w-0 flex items-center gap-2 relative z-10">
        <span className="text-sm truncate flex-1">{file.name}</span>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatFileSize(file.size)}
        </span>
      </div>
      <button
        type="button"
        onClick={() => onRemove(index)}
        className="hover:bg-background rounded-full p-1 transition-colors flex-shrink-0 relative z-10"
        aria-label="Remove file"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function FileAttachments({
  files,
  onRemove,
  uploadingItems = []
}: FileAttachmentsProps) {
  // Show all items including uploaded (they animate out before deletion)
  if (files.length === 0 && uploadingItems.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 px-4 pb-2 max-h-48 overflow-y-auto">
      {/* Uploading/completed items first */}
      {uploadingItems.map((item) => (
        <UploadingFileItem key={item.id} item={item} />
      ))}

      {/* Pending files (not yet sent) */}
      {files.map((file, index) => (
        <PendingFileItem
          key={`pending-${index}`}
          file={file}
          index={index}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
