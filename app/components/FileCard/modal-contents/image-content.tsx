import { useRef, useEffect, useState, useCallback } from 'react';
import type { FileWithDigests } from '~/types/file-card';
import { getFileContentUrl } from '../utils';
import type { HighlightRegion, RleMask } from '../ui/digest-renderers';

interface ImageContentProps {
  file: FileWithDigests;
  /** Whether digests panel is showing (disables click-to-close) */
  showDigests?: boolean;
  /** Callback when image is clicked (for close behavior) */
  onClose?: () => void;
  /** Region to highlight on the image (bbox + optional RLE mask) */
  highlightedRegion?: HighlightRegion | null;
}

/**
 * Decode RLE mask to a binary mask array
 * RLE format: { size: [height, width], counts: number[] }
 * counts alternates between 0s and 1s, starting with 0s
 */
function decodeRle(rle: RleMask): Uint8Array {
  const [height, width] = rle.size;
  const totalPixels = height * width;
  const mask = new Uint8Array(totalPixels);

  let idx = 0;
  let value = 0; // Start with 0s

  for (const count of rle.counts) {
    for (let i = 0; i < count && idx < totalPixels; i++) {
      mask[idx++] = value;
    }
    value = 1 - value; // Alternate between 0 and 1
  }

  return mask;
}

/**
 * Render RLE mask to a canvas as a semi-transparent overlay
 */
function renderRleMaskToCanvas(
  canvas: HTMLCanvasElement,
  rle: RleMask,
  displayWidth: number,
  displayHeight: number
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const [maskHeight, maskWidth] = rle.size;

  // Set canvas size to match display size
  canvas.width = displayWidth;
  canvas.height = displayHeight;

  // Decode the RLE mask
  const mask = decodeRle(rle);

  // Create an ImageData for the mask
  const imageData = ctx.createImageData(displayWidth, displayHeight);
  const data = imageData.data;

  // Scale factors
  const scaleX = maskWidth / displayWidth;
  const scaleY = maskHeight / displayHeight;

  // Fill the ImageData by sampling from the mask
  for (let y = 0; y < displayHeight; y++) {
    for (let x = 0; x < displayWidth; x++) {
      // Map display coordinates to mask coordinates
      const maskX = Math.floor(x * scaleX);
      const maskY = Math.floor(y * scaleY);

      // RLE mask is in column-major order (Fortran order)
      const maskIdx = maskX * maskHeight + maskY;
      const pixelIdx = (y * displayWidth + x) * 4;

      if (mask[maskIdx]) {
        // Highlight color: semi-transparent cyan/teal
        data[pixelIdx] = 0;       // R
        data[pixelIdx + 1] = 200; // G
        data[pixelIdx + 2] = 255; // B
        data[pixelIdx + 3] = 100; // A (semi-transparent)
      } else {
        // Transparent
        data[pixelIdx + 3] = 0;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

export function ImageContent({ file, showDigests, onClose, highlightedRegion }: ImageContentProps) {
  const src = getFileContentUrl(file);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);

  // Track image dimensions when loaded
  const handleImageLoad = useCallback(() => {
    if (imgRef.current) {
      setImageDimensions({
        width: imgRef.current.clientWidth,
        height: imgRef.current.clientHeight,
      });
    }
  }, []);

  // Re-measure on resize
  useEffect(() => {
    const handleResize = () => {
      if (imgRef.current) {
        setImageDimensions({
          width: imgRef.current.clientWidth,
          height: imgRef.current.clientHeight,
        });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Render RLE mask when highlighted region changes
  useEffect(() => {
    if (!canvasRef.current || !imageDimensions) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear the canvas
    canvas.width = imageDimensions.width;
    canvas.height = imageDimensions.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // If we have an RLE mask, render it
    if (highlightedRegion?.rle) {
      renderRleMaskToCanvas(
        canvas,
        highlightedRegion.rle,
        imageDimensions.width,
        imageDimensions.height
      );
    }
  }, [highlightedRegion, imageDimensions]);

  // Calculate bbox overlay style (fallback when no RLE)
  const getBboxOverlayStyle = () => {
    if (!highlightedRegion || highlightedRegion.rle) return undefined;

    const [x1, y1, x2, y2] = highlightedRegion.bbox;

    return {
      left: `${x1 * 100}%`,
      top: `${y1 * 100}%`,
      width: `${(x2 - x1) * 100}%`,
      height: `${(y2 - y1) * 100}%`,
    };
  };

  const bboxOverlayStyle = getBboxOverlayStyle();

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
            onLoad={handleImageLoad}
          />
          {/* RLE mask overlay (rendered to canvas) */}
          {highlightedRegion?.rle && imageDimensions && (
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 pointer-events-none animate-pulse-glow"
              style={{
                width: imageDimensions.width,
                height: imageDimensions.height,
              }}
            />
          )}
          {/* Bounding box overlay (fallback when no RLE) */}
          {highlightedRegion && !highlightedRegion.rle && bboxOverlayStyle && (
            <div
              className="absolute pointer-events-none animate-pulse-glow"
              style={bboxOverlayStyle}
            />
          )}
        </div>
      </div>
    </div>
  );
}
