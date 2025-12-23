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
 * Flood fill from a starting index, marking visited pixels
 * Returns the count of pixels in this region
 */
function floodFill(
  mask: Uint8Array,
  width: number,
  height: number,
  startIdx: number,
  visited: Uint8Array
): number {
  const stack: number[] = [startIdx];
  let count = 0;

  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (visited[idx]) continue;
    if (!mask[idx]) continue;

    visited[idx] = 1;
    count++;

    // Convert linear index to x, y (column-major: idx = x * height + y)
    const x = Math.floor(idx / height);
    const y = idx % height;

    // Check 8 neighbors (including diagonals)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const neighborIdx = nx * height + ny;
          if (mask[neighborIdx] && !visited[neighborIdx]) {
            stack.push(neighborIdx);
          }
        }
      }
    }
  }

  return count;
}

/**
 * Extract the largest connected region from a mask.
 * If the largest region covers >= threshold (95%) of total pixels, returns a mask with only that region.
 * Otherwise returns null (indicating we should fall back to bbox).
 */
function extractLargestRegion(
  mask: Uint8Array,
  width: number,
  height: number,
  threshold: number = 0.95
): Uint8Array | null {
  // Count total mask pixels
  let totalMaskPixels = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) totalMaskPixels++;
  }

  if (totalMaskPixels === 0) return null;

  // Find all connected regions and track the largest
  const visited = new Uint8Array(mask.length);
  let largestRegionStart = -1;
  let largestRegionSize = 0;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && !visited[i]) {
      const regionSize = floodFill(mask, width, height, i, visited);
      if (regionSize > largestRegionSize) {
        largestRegionSize = regionSize;
        largestRegionStart = i;
      }
    }
  }

  // Check if largest region covers enough of the mask
  const coverage = largestRegionSize / totalMaskPixels;

  if (coverage >= threshold) {
    // Single region or dominant region
    if (largestRegionSize === totalMaskPixels) {
      // Already a single region - use original mask
      return mask;
    }

    // Extract only the largest region by re-flood-filling
    const regionMask = new Uint8Array(mask.length);
    const regionVisited = new Uint8Array(mask.length);
    const stack: number[] = [largestRegionStart];

    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (regionVisited[idx]) continue;
      if (!mask[idx]) continue;

      regionVisited[idx] = 1;
      regionMask[idx] = 1;

      const x = Math.floor(idx / height);
      const y = idx % height;

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const neighborIdx = nx * height + ny;
            if (mask[neighborIdx] && !regionVisited[neighborIdx]) {
              stack.push(neighborIdx);
            }
          }
        }
      }
    }

    console.log(`[RLE] Using largest region: ${largestRegionSize}/${totalMaskPixels} pixels (${(coverage * 100).toFixed(1)}%)`);
    return regionMask;
  }

  // Multiple significant regions - fall back to bbox
  console.log(`[RLE] Multiple regions, largest covers only ${(coverage * 100).toFixed(1)}% - falling back to bbox`);
  return null;
}

/**
 * Create a rectangular mask from a bounding box (for bbox-only highlights)
 * Returns a mask in column-major order matching the RLE format
 */
function createBboxMask(
  bbox: [number, number, number, number],
  width: number,
  height: number
): Uint8Array {
  const [x1, y1, x2, y2] = bbox;
  const mask = new Uint8Array(width * height);

  // Convert normalized coords to pixel coords
  const px1 = Math.floor(x1 * width);
  const py1 = Math.floor(y1 * height);
  const px2 = Math.ceil(x2 * width);
  const py2 = Math.ceil(y2 * height);

  // Fill the rectangular region (column-major: idx = x * height + y)
  for (let x = px1; x < px2 && x < width; x++) {
    for (let y = py1; y < py2 && y < height; y++) {
      mask[x * height + y] = 1;
    }
  }

  return mask;
}


// Color 1: #0ea5e9 (sky blue) - fill color
const COLOR1 = { r: 14, g: 165, b: 233 };
// Color 2: #e57373 (coral red) - border color
const COLOR2 = { r: 229, g: 115, b: 115 };
// Glow color (bright white/cyan for the glowing edge)
const GLOW_COLOR = { r: 255, g: 255, b: 255 };

/**
 * Compute distance field for the mask - distance to nearest edge pixel
 * Returns a Float32Array where positive values = inside mask, negative = outside
 * The magnitude represents distance to the edge
 */
function computeDistanceField(
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  displayWidth: number,
  displayHeight: number
): Float32Array {
  const scaleX = maskWidth / displayWidth;
  const scaleY = maskHeight / displayHeight;
  const distField = new Float32Array(displayWidth * displayHeight);

  // First pass: find edge pixels and mark inside/outside
  for (let y = 0; y < displayHeight; y++) {
    for (let x = 0; x < displayWidth; x++) {
      const maskX = Math.floor(x * scaleX);
      const maskY = Math.floor(y * scaleY);
      const maskIdx = maskX * maskHeight + maskY;
      const idx = y * displayWidth + x;

      if (mask[maskIdx]) {
        // Check if this is an edge pixel
        let isEdge = false;
        for (let dy = -1; dy <= 1 && !isEdge; dy++) {
          for (let dx = -1; dx <= 1 && !isEdge; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < displayWidth && ny >= 0 && ny < displayHeight) {
              const nMaskX = Math.floor(nx * scaleX);
              const nMaskY = Math.floor(ny * scaleY);
              const nMaskIdx = nMaskX * maskHeight + nMaskY;
              if (!mask[nMaskIdx]) {
                isEdge = true;
              }
            } else {
              isEdge = true;
            }
          }
        }
        distField[idx] = isEdge ? 0 : 9999; // Edge = 0, inside = large positive
      } else {
        distField[idx] = -9999; // Outside = large negative
      }
    }
  }

  // Simple distance propagation (approximate but fast)
  // Forward pass
  for (let y = 1; y < displayHeight - 1; y++) {
    for (let x = 1; x < displayWidth - 1; x++) {
      const idx = y * displayWidth + x;
      if (distField[idx] > 0) {
        const neighbors = [
          distField[idx - displayWidth - 1] + 1.414,
          distField[idx - displayWidth] + 1,
          distField[idx - displayWidth + 1] + 1.414,
          distField[idx - 1] + 1,
        ];
        distField[idx] = Math.min(distField[idx], ...neighbors);
      }
    }
  }

  // Backward pass
  for (let y = displayHeight - 2; y > 0; y--) {
    for (let x = displayWidth - 2; x > 0; x--) {
      const idx = y * displayWidth + x;
      if (distField[idx] > 0) {
        const neighbors = [
          distField[idx + displayWidth + 1] + 1.414,
          distField[idx + displayWidth] + 1,
          distField[idx + displayWidth - 1] + 1.414,
          distField[idx + 1] + 1,
        ];
        distField[idx] = Math.min(distField[idx], ...neighbors);
      }
    }
  }

  return distField;
}

/**
 * Find the maximum distance from edge (for normalization)
 */
function findMaxDistance(distField: Float32Array): number {
  let maxDist = 0;
  for (let i = 0; i < distField.length; i++) {
    if (distField[i] > 0 && distField[i] < 9999) {
      maxDist = Math.max(maxDist, distField[i]);
    }
  }
  return maxDist || 1;
}

/**
 * Linear interpolation between two colors
 */
function lerpColor(
  c1: { r: number; g: number; b: number },
  c2: { r: number; g: number; b: number },
  t: number
): { r: number; g: number; b: number } {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
  };
}

/**
 * Compute outer distance field - distance from outside pixels to the mask edge
 */
function computeOuterDistanceField(
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  displayWidth: number,
  displayHeight: number,
  maxSearchDist: number
): Float32Array {
  const scaleX = maskWidth / displayWidth;
  const scaleY = maskHeight / displayHeight;
  const outerDistField = new Float32Array(displayWidth * displayHeight);

  // Initialize: 0 for mask pixels, large value for outside
  for (let y = 0; y < displayHeight; y++) {
    for (let x = 0; x < displayWidth; x++) {
      const maskX = Math.floor(x * scaleX);
      const maskY = Math.floor(y * scaleY);
      const maskIdx = maskX * maskHeight + maskY;
      const idx = y * displayWidth + x;
      outerDistField[idx] = mask[maskIdx] ? 0 : 9999;
    }
  }

  // Distance propagation for outside pixels
  // Forward pass
  for (let y = 1; y < displayHeight - 1; y++) {
    for (let x = 1; x < displayWidth - 1; x++) {
      const idx = y * displayWidth + x;
      if (outerDistField[idx] > 0) {
        const neighbors = [
          outerDistField[idx - displayWidth - 1] + 1.414,
          outerDistField[idx - displayWidth] + 1,
          outerDistField[idx - displayWidth + 1] + 1.414,
          outerDistField[idx - 1] + 1,
        ];
        outerDistField[idx] = Math.min(outerDistField[idx], ...neighbors);
      }
    }
  }

  // Backward pass
  for (let y = displayHeight - 2; y > 0; y--) {
    for (let x = displayWidth - 2; x > 0; x--) {
      const idx = y * displayWidth + x;
      if (outerDistField[idx] > 0) {
        const neighbors = [
          outerDistField[idx + displayWidth + 1] + 1.414,
          outerDistField[idx + displayWidth] + 1,
          outerDistField[idx + displayWidth - 1] + 1.414,
          outerDistField[idx + 1] + 1,
        ];
        outerDistField[idx] = Math.min(outerDistField[idx], ...neighbors);
      }
    }
  }

  // Cap at max search distance
  for (let i = 0; i < outerDistField.length; i++) {
    if (outerDistField[i] > maxSearchDist) {
      outerDistField[i] = maxSearchDist;
    }
  }

  return outerDistField;
}

/**
 * Render RLE mask with SAM3-style glowing animation
 *
 * Layers:
 * 1. Base layer (always visible): Color1 fill + Color2 border OUTSIDE the polygon
 * 2. Animation overlay: Expanding outline ring from center outward with Color2 glow
 *
 * The expanding ring starts small at center and grows to full size
 * Animation repeats 3 times then rests in final state
 */
function renderAnimatedMask(
  canvas: HTMLCanvasElement,
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  distField: Float32Array,
  outerDistField: Float32Array,
  maxDist: number,
  displayWidth: number,
  displayHeight: number,
  timeMs: number
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Set canvas size (only if changed to avoid flicker)
  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }

  // Scale factors
  const scaleX = maskWidth / displayWidth;
  const scaleY = maskHeight / displayHeight;

  // Create an ImageData for the mask
  const imageData = ctx.createImageData(displayWidth, displayHeight);
  const data = imageData.data;

  // Animation timing - use easing for smoothness
  const expandDuration = 1200; // 1.2s to expand
  const settleDuration = 400; // 0.4s to settle
  const cycleDuration = expandDuration + settleDuration; // 1.6s per cycle
  const totalCycles = 3;
  const totalAnimDuration = cycleDuration * totalCycles;

  // Easing function for smooth animation
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

  // Calculate animation progress with easing
  let expandProgress: number; // 0 = center only, 1 = full size
  let glowIntensity: number; // 0-1 for glow brightness

  if (timeMs >= totalAnimDuration) {
    // After 3 cycles, rest in final state
    expandProgress = 1.0;
    glowIntensity = 0;
  } else {
    // Calculate position within current cycle
    const cycleTime = timeMs % cycleDuration;

    if (cycleTime < expandDuration) {
      // Expanding phase with easing
      const t = cycleTime / expandDuration;
      expandProgress = easeOutCubic(t); // 0% to 100%
      glowIntensity = 1.0;
    } else {
      // Settling phase - fade out glow
      expandProgress = 1.0;
      const t = (cycleTime - expandDuration) / settleDuration;
      glowIntensity = 1.0 - easeOutCubic(t);
    }
  }

  // Border width in pixels (for resting state border - OUTSIDE the polygon)
  const borderWidth = 4;
  // Glow ring thickness - thicker when small (blur effect), thinner when large
  const baseGlowWidth = 12;
  const glowWidth = baseGlowWidth + (1 - expandProgress) * 32; // 12-44px
  // Outer glow spread beyond the ring
  const outerGlowSpread = 8;

  // The ring position: starts at maxDist (center) and moves to 0 (edge)
  // expandProgress=0 -> ringPosition=maxDist (at center)
  // expandProgress=1 -> ringPosition=0 (at edge)
  const ringPosition = maxDist * (1 - expandProgress);

  for (let y = 0; y < displayHeight; y++) {
    for (let x = 0; x < displayWidth; x++) {
      const maskX = Math.floor(x * scaleX);
      const maskY = Math.floor(y * scaleY);
      const maskIdx = maskX * maskHeight + maskY;
      const pixelIdx = (y * displayWidth + x) * 4;
      const distIdx = y * displayWidth + x;

      // Start with transparent
      data[pixelIdx] = 0;
      data[pixelIdx + 1] = 0;
      data[pixelIdx + 2] = 0;
      data[pixelIdx + 3] = 0;

      const isInsideMask = mask[maskIdx];
      const innerDist = distField[distIdx]; // Distance from edge (inside)
      const outerDist = outerDistField[distIdx]; // Distance from mask (outside)

      if (!isInsideMask) {
        // Outside mask
        // Draw border (outside the polygon)
        if (outerDist > 0 && outerDist <= borderWidth) {
          data[pixelIdx] = COLOR2.r;
          data[pixelIdx + 1] = COLOR2.g;
          data[pixelIdx + 2] = COLOR2.b;
          data[pixelIdx + 3] = 180;
        }

        // Outer glow during animation (beyond the ring when it's at the edge)
        if (glowIntensity > 0 && ringPosition < glowWidth && outerDist > 0 && outerDist <= outerGlowSpread + glowWidth) {
          const distFromRingEdge = outerDist;
          const glowFactor = 1 - (distFromRingEdge / (outerGlowSpread + glowWidth));
          if (glowFactor > 0) {
            const intensity = glowFactor * glowFactor * glowIntensity;
            const alpha = intensity * 120;
            const color = lerpColor(COLOR2, GLOW_COLOR, intensity * 0.4);

            // Blend with existing (border)
            const baseAlpha = data[pixelIdx + 3] / 255;
            const srcAlpha = alpha / 255;
            const outAlpha = srcAlpha + baseAlpha * (1 - srcAlpha);

            if (outAlpha > 0) {
              data[pixelIdx] = Math.round((color.r * srcAlpha + data[pixelIdx] * baseAlpha * (1 - srcAlpha)) / outAlpha);
              data[pixelIdx + 1] = Math.round((color.g * srcAlpha + data[pixelIdx + 1] * baseAlpha * (1 - srcAlpha)) / outAlpha);
              data[pixelIdx + 2] = Math.round((color.b * srcAlpha + data[pixelIdx + 2] * baseAlpha * (1 - srcAlpha)) / outAlpha);
              data[pixelIdx + 3] = Math.round(outAlpha * 255);
            }
          }
        }
        continue;
      }

      // Inside mask - always draw base layer (fill only, border is outside)
      data[pixelIdx] = COLOR1.r;
      data[pixelIdx + 1] = COLOR1.g;
      data[pixelIdx + 2] = COLOR1.b;
      data[pixelIdx + 3] = 100; // ~40% opacity

      // Animation overlay: expanding glow ring
      if (glowIntensity > 0 && innerDist >= 0) {
        // Distance from this pixel to the ring position
        const distToRing = Math.abs(innerDist - ringPosition);

        if (distToRing < glowWidth) {
          // Inside the glow ring band
          // Intensity peaks at ring center, fades toward edges
          const ringFactor = 1 - (distToRing / glowWidth);
          const intensity = ringFactor * ringFactor * glowIntensity; // Quadratic falloff

          // Blend glow color on top of base
          const glowColor = lerpColor(COLOR2, GLOW_COLOR, intensity * 0.5);
          const glowAlpha = intensity * 200;

          // Alpha compositing: blend glow on top
          const baseAlpha = data[pixelIdx + 3] / 255;
          const srcAlpha = glowAlpha / 255;
          const outAlpha = srcAlpha + baseAlpha * (1 - srcAlpha);

          if (outAlpha > 0) {
            data[pixelIdx] = Math.round((glowColor.r * srcAlpha + data[pixelIdx] * baseAlpha * (1 - srcAlpha)) / outAlpha);
            data[pixelIdx + 1] = Math.round((glowColor.g * srcAlpha + data[pixelIdx + 1] * baseAlpha * (1 - srcAlpha)) / outAlpha);
            data[pixelIdx + 2] = Math.round((glowColor.b * srcAlpha + data[pixelIdx + 2] * baseAlpha * (1 - srcAlpha)) / outAlpha);
            data[pixelIdx + 3] = Math.round(outAlpha * 255);
          }
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
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

    // Determine the mask to use
    let mask: Uint8Array;
    let maskWidth: number;
    let maskHeight: number;

    if (highlightedRegion.rle) {
      const rle = highlightedRegion.rle;
      [maskHeight, maskWidth] = rle.size;

      console.log(`[RLE] Processing mask: ${maskWidth}x${maskHeight}, counts length: ${rle.counts.length}`);

      // Decode and try to extract the largest region
      const decodedMask = decodeRle(rle);
      const extractedMask = extractLargestRegion(decodedMask, maskWidth, maskHeight);

      if (extractedMask) {
        // Use the RLE mask (either original or largest region)
        mask = extractedMask;
      } else {
        // Multiple significant regions - fall back to bbox
        console.log('[RLE] Falling back to bbox mask');
        maskWidth = imageDimensions.width;
        maskHeight = imageDimensions.height;
        mask = createBboxMask(highlightedRegion.bbox, maskWidth, maskHeight);
      }
    } else {
      // No RLE - use bbox directly
      console.log('[BBOX] Using bbox mask');
      maskWidth = imageDimensions.width;
      maskHeight = imageDimensions.height;
      mask = createBboxMask(highlightedRegion.bbox, maskWidth, maskHeight);
    }

    // Compute distance fields
    const distField = computeDistanceField(
      mask,
      maskWidth,
      maskHeight,
      imageDimensions.width,
      imageDimensions.height
    );
    const outerDistField = computeOuterDistanceField(
      mask,
      maskWidth,
      maskHeight,
      imageDimensions.width,
      imageDimensions.height,
      30 // maxSearchDist for border (4px) + glow (8px) + some margin
    );
    const maxDist = findMaxDistance(distField);

    // 3 cycles of 1.6s each = 4.8s
    const animationDuration = 4800;
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;

      renderAnimatedMask(
        canvas,
        mask,
        maskWidth,
        maskHeight,
        distField,
        outerDistField,
        maxDist,
        imageDimensions.width,
        imageDimensions.height,
        elapsed
      );

      // Keep animating until animation completes, then render one final frame
      if (elapsed < animationDuration) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        // Render final resting state (timeMs > totalAnimDuration ensures glowIntensity = 0)
        renderAnimatedMask(
          canvas,
          mask,
          maskWidth,
          maskHeight,
          distField,
          outerDistField,
          maxDist,
          imageDimensions.width,
          imageDimensions.height,
          animationDuration + 1000 // Ensure we're past animation
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
