import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';

export interface FileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: {
    name: string;
    path: string;
    mimeType?: string | null;
  };
}

export function FileModal({ open, onOpenChange, file }: FileModalProps) {
  const isImage = file.mimeType?.startsWith('image/');

  if (!isImage) {
    return null;
  }

  const src = `/raw/${file.path}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90vw] max-h-[90vh] w-fit p-0 border-none bg-transparent shadow-none overflow-hidden rounded-none"
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
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
