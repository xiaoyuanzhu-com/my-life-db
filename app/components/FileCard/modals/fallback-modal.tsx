import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import type { BaseModalProps } from '../types';

export function FallbackModal({ file, open, onOpenChange }: BaseModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{file.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-muted-foreground">Path</div>
            <div className="break-all">{file.path}</div>

            {file.mimeType && (
              <>
                <div className="text-muted-foreground">Type</div>
                <div>{file.mimeType}</div>
              </>
            )}

            {file.size !== null && (
              <>
                <div className="text-muted-foreground">Size</div>
                <div>{formatFileSize(file.size)}</div>
              </>
            )}

            <div className="text-muted-foreground">Created</div>
            <div>{new Date(file.createdAt).toLocaleString()}</div>

            <div className="text-muted-foreground">Modified</div>
            <div>{new Date(file.modifiedAt).toLocaleString()}</div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
