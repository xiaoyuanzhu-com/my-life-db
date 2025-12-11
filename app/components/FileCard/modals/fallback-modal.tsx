import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps } from '../types';
import { ModalCloseButton } from '../ui/modal-close-button';

export function FallbackModal({ file, open, onOpenChange }: BaseModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90vw] h-[90vh] w-full sm:max-w-2xl p-0 flex flex-col"
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />
        <div className="flex-1 flex flex-col items-center justify-center pb-[10vh]">
          <div className="text-center space-y-2 text-sm px-6">
            <div className="break-all">{file.name}</div>
            {file.size !== null && (
              <div className="text-muted-foreground">{formatFileSize(file.size)}</div>
            )}
            <div className="text-muted-foreground">
              {new Date(file.createdAt).toLocaleString()}
            </div>
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
