import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps } from '../types';
import { fetchFullContent } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';

interface TextModalProps extends BaseModalProps {
  previewText: string;
  fullContent: string | null;
  onFullContentLoaded: (content: string) => void;
}

export function TextModal({
  file,
  open,
  onOpenChange,
  previewText,
  fullContent,
  onFullContentLoaded,
}: TextModalProps) {
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (open && !fullContent) {
      setIsLoading(true);
      fetchFullContent(file.path).then((content) => {
        if (content) {
          onFullContentLoaded(content);
        }
        setIsLoading(false);
      });
    }
  }, [open, fullContent, file.path, onFullContentLoaded]);

  const displayText = fullContent || previewText;

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
        <div className="flex-1 overflow-auto p-6">
          {isLoading ? (
            <div className="text-muted-foreground">Loading...</div>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none select-text">
              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {displayText}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
