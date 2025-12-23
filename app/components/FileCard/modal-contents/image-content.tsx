import { useRef, useEffect, useState, useCallback } from 'react';
import type { FileWithDigests } from '~/types/file-card';
import { getFileContentUrl } from '../utils';
import type { HighlightRegion } from '../ui/digest-renderers';
import {
  prepareHighlightState,
  renderHighlightFrame,
  ANIMATION_DURATION,
  type AnimatedHighlightState,
} from '../ui/animated-highlight';

interface ImageContentProps {
  file: FileWithDigests;
  /** Whether digests panel is showing (disables click-to-close) */
  showDigests?: boolean;
  /** Callback when image is clicked (for close behavior) */
  onClose?: () => void;
  /** Region to highlight on the image (bbox + optional RLE mask) */
  highlightedRegion?: HighlightRegion | null;
}

export function ImageContent({ file, showDigests, onClose, highlightedRegion }: ImageContentProps) {
  const src = getFileContentUrl(file);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
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

  // Animate highlight with SAM3-style glowing effect (works for both RLE and bbox)
  useEffect(() => {
    if (!canvasRef.current || !imageDimensions || !highlightedRegion) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Cancel any existing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    // Clear the canvas
    canvas.width = imageDimensions.width;
    canvas.height = imageDimensions.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Prepare the highlight state (expensive computation done once)
    const state: AnimatedHighlightState = prepareHighlightState(
      highlightedRegion,
      imageDimensions.width,
      imageDimensions.height
    );

    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;

      renderHighlightFrame(
        canvas,
        state,
        imageDimensions.width,
        imageDimensions.height,
        elapsed
      );

      // Keep animating until animation completes, then render one final frame
      if (elapsed < ANIMATION_DURATION) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        // Render final resting state
        renderHighlightFrame(
          canvas,
          state,
          imageDimensions.width,
          imageDimensions.height,
          ANIMATION_DURATION + 1000 // Ensure we're past animation
        );
        animationRef.current = null;
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [highlightedRegion, imageDimensions]);

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
          {/* Highlight overlay (rendered to canvas with glowing animation) */}
          {/* Works for both RLE masks and bbox fallback */}
          {highlightedRegion && imageDimensions && (
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 pointer-events-none"
              style={{
                width: imageDimensions.width,
                height: imageDimensions.height,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
