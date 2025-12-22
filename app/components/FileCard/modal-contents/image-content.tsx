import { useRef, useState, useEffect } from 'react';
import type { FileWithDigests } from '~/types/file-card';
import { getFileContentUrl } from '../utils';
import type { BoundingBox } from '../ui/digest-renderers';

interface ImageContentProps {
  file: FileWithDigests;
  /** Whether digests panel is showing (disables click-to-close) */
  showDigests?: boolean;
  /** Callback when image is clicked (for close behavior) */
  onClose?: () => void;
  /** Bounding box to highlight on the image */
  highlightedBox?: BoundingBox | null;
}

export function ImageContent({ file, showDigests, onClose, highlightedBox }: ImageContentProps) {
  const src = getFileContentUrl(file);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgNaturalSize, setImgNaturalSize] = useState<{ width: number; height: number } | null>(null);

  // Get natural image dimensions when loaded
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    const updateSize = () => {
      if (img.naturalWidth && img.naturalHeight) {
        setImgNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      }
    };

    if (img.complete) {
      updateSize();
    } else {
      img.addEventListener('load', updateSize);
      return () => img.removeEventListener('load', updateSize);
    }
  }, [src]);

  // Calculate overlay style based on bounding box format
  // The model may return mixed formats: x,y in pixels, width,height normalized
  const getOverlayStyle = () => {
    if (!highlightedBox || !imgNaturalSize) return undefined;

    const { x, y, width, height } = highlightedBox;
    const { width: natW, height: natH } = imgNaturalSize;

    // Detect format: if x or y > 1, they're pixels; if width/height <= 1, they're normalized
    const xIsPixel = x > 1;
    const yIsPixel = y > 1;
    const wIsNormalized = width <= 1;
    const hIsNormalized = height <= 1;

    // Convert everything to percentages
    const leftPct = xIsPixel ? (x / natW) * 100 : x * 100;
    const topPct = yIsPixel ? (y / natH) * 100 : y * 100;
    const widthPct = wIsNormalized ? width * 100 : (width / natW) * 100;
    const heightPct = hIsNormalized ? height * 100 : (height / natH) * 100;

    return {
      left: `${leftPct}%`,
      top: `${topPct}%`,
      width: `${widthPct}%`,
      height: `${heightPct}%`,
    };
  };

  const overlayStyle = getOverlayStyle();

  return (
    <div className="w-full h-full rounded-lg bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] flex items-center justify-center">
      <div
        className="w-full h-full flex items-center justify-center cursor-pointer p-4"
        onClick={() => !showDigests && onClose?.()}
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
          {/* Bounding box overlay */}
          {highlightedBox && overlayStyle && (
            <div
              className="absolute pointer-events-none animate-pulse-glow"
              style={overlayStyle}
            />
          )}
        </div>
      </div>
    </div>
  );
}
