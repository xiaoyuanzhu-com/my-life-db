import type { FileWithDigests } from '~/types/file-card';
import { getFileContentUrl } from '../utils';

interface ImageContentProps {
  file: FileWithDigests;
  /** Whether digests panel is showing (disables click-to-close) */
  showDigests?: boolean;
  /** Callback when image is clicked (for close behavior) */
  onClose?: () => void;
}

export function ImageContent({ file, showDigests, onClose }: ImageContentProps) {
  const src = getFileContentUrl(file);

  return (
    <div
      className="w-full h-full flex items-center justify-center cursor-pointer"
      onClick={() => !showDigests && onClose?.()}
    >
      <img
        src={src}
        alt={file.name}
        className="object-contain"
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          width: 'auto',
          height: 'auto',
        }}
      />
    </div>
  );
}
