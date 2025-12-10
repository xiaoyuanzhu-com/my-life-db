import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps } from '../types';
import { getRawFileUrl } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';

export function ImageModal({ file, open, onOpenChange }: BaseModalProps) {
  const src = getRawFileUrl(file.path);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] w-fit p-0 border-none bg-transparent shadow-none overflow-hidden rounded-none"
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />
        <div
          className="relative flex items-center justify-center cursor-pointer"
          onClick={() => onOpenChange(false)}
        >
          <img
            src={src}
            alt={file.name}
            className="object-contain"
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              width: 'auto',
              height: 'auto',
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
