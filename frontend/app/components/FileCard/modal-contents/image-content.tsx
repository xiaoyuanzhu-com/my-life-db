import { useRef } from 'react';
import type { FileWithDigests } from '~/types/file-card';
import { getFileContentUrl } from '../utils';

interface ImageContentProps {
  file: FileWithDigests;
  /** Callback when image is clicked (for close behavior) */
  onClose?: () => void;
}

export function ImageContent({ file, onClose }: ImageContentProps) {
  const src = getFileContentUrl(file);
  const imgRef = useRef<HTMLImageElement>(null);

  return (
    <div className="w-full h-full rounded-lg bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] flex items-center justify-center">
      <div
        className="w-full h-full flex items-center justify-center cursor-pointer p-4"
        onClick={() => onClose?.()}
      >
        <div className="relative">
          <img
            ref={imgRef}
            src={src}
            alt={file.name}
            className="object-contain block rounded"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              width: 'auto',
              height: 'auto',
            }}
          />
        </div>
      </div>
    </div>
  );
}
