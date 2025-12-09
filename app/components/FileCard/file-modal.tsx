import type { BaseModalProps } from './types';
import { getFileContentType } from './utils';
import { getModalComponent } from './modals';

export type { BaseModalProps as FileModalProps } from './types';

/**
 * FileModal - Modal dispatcher component
 *
 * Detects file content type and renders the appropriate modal component.
 * Returns null if no modal is available for the content type.
 */
export function FileModal({ file, open, onOpenChange }: BaseModalProps) {
  const contentType = getFileContentType(file);
  const ModalComponent = getModalComponent(contentType);

  if (!ModalComponent) {
    return null;
  }

  return <ModalComponent file={file} open={open} onOpenChange={onOpenChange} />;
}
