import { Upload, X } from 'lucide-react';
import { cn } from '~/lib/utils';

interface FileAttachmentsProps {
  files: File[];
  onRemove: (index: number) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1000;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

export function FileAttachments({ files, onRemove }: FileAttachmentsProps) {
  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 px-4 pb-2 max-h-48 overflow-y-auto">
      {files.map((file, index) => (
        <div
          key={index}
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
      ))}
    </div>
  );
}
