import { useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import type { FileWithDigests } from '~/types/file-card';
import { getFileContentUrl } from '../utils';
import { ImageLightbox } from '~/components/ui/image-lightbox';

interface ImageContentProps {
  file: FileWithDigests;
  /** Callback when image is clicked (for close behavior) */
  onClose?: () => void;
}

export function ImageContent({ file, onClose }: ImageContentProps) {
  const src = getFileContentUrl(file);
  const imgRef = useRef<HTMLImageElement>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  return (
    <>
      <div className="w-full h-full rounded-lg bg-background flex items-center justify-center">
        <div
          className="w-full h-full flex items-center justify-center cursor-pointer p-4 group relative"
          onClick={() => setLightboxOpen(true)}
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
            {/* Expand icon overlay */}
            <div className="absolute top-2 right-2 bg-black/40 text-white rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <Maximize2 className="h-4 w-4" />
            </div>
          </div>
        </div>
      </div>
      {lightboxOpen && (
        <ImageLightbox
          images={[{ src, alt: file.name }]}
          initialIndex={0}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}
