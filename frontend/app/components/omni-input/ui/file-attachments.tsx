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
  const [isVisible, setIsVisible] = useState(false);
  const mountedRef = useRef(true);

  // Animate in on mount
  useEffect(() => {
    mountedRef.current = true;
    const timer = setTimeout(() => {
      if (mountedRef.current) setIsVisible(true);
    }, 10);
    return () => {
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, []);

  const isUploading = item.status === 'uploading';
  const isComplete = item.status === 'uploaded';
  const hasError = !!item.errorMessage;
  const progress = item.uploadProgress;

  return (
    <div
      className={cn(
        'flex items-center gap-2 relative overflow-hidden rounded-md p-2 transition-all duration-300',
        'bg-primary/10',
        !isVisible && 'opacity-0 translate-y-2',
        isVisible && 'opacity-100 translate-y-0',
        isComplete && 'opacity-50'
      )}
    >
      {/* Progress bar background */}
      <div
        className={cn(
          'absolute inset-0 transition-all duration-300 ease-out',
          hasError ? 'bg-destructive/20' : 'bg-primary/20'
        )}
        style={{ width: `${progress}%` }}
      />

      {/* Icon */}
      <div className="relative z-10 flex-shrink-0">
        {isComplete ? (
          <Check className="h-4 w-4 text-primary" />
        ) : isUploading ? (
          <Loader2 className="h-4 w-4 text-primary animate-spin" />
        ) : (
          <Upload className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      {/* File info */}
      <div className="flex-1 min-w-0 flex items-center gap-2 relative z-10">
        <span className="text-sm truncate flex-1">{item.filename}</span>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {isUploading && `${progress}%`}
          {!isUploading && !isComplete && formatFileSize(item.size)}
          {isComplete && <Check className="h-3 w-3 inline" />}
        </span>
      </div>

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
  // Filter out uploaded items (they should disappear)
  const activeUploadingItems = uploadingItems.filter(
    item => item.status !== 'uploaded'
  );

  if (files.length === 0 && activeUploadingItems.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 px-4 pb-2 max-h-48 overflow-y-auto">
      {/* Uploading items first */}
      {activeUploadingItems.map((item) => (
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
