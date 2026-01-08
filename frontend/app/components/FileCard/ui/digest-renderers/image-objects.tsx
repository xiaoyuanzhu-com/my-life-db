/**
 * Image Objects Renderer
 * Displays detected objects sorted from top-left to bottom-right by bounding box center
 */

import type { DigestRendererProps } from './index';

/** Bounding box as [x1, y1, x2, y2] normalized to [0,1] */
export type BoundingBox = [number, number, number, number];

/** RLE mask format from SAM */
export interface RleMask {
  size: [number, number]; // [height, width]
  counts: number[];
}

/** Highlight region data - includes bbox and optional RLE mask */
export interface HighlightRegion {
  bbox: BoundingBox;
  rle: RleMask | null;
}

export interface ImageObjectsRendererProps extends DigestRendererProps {
  /** Callback when an object is clicked, passing highlight region data */
  onHighlightRegion?: (region: HighlightRegion | null) => void;
}

interface DetectedObject {
  title: string;
  category: string;
  description: string;
  bbox: BoundingBox;
  rle: RleMask | null;
}

interface ImageObjectsContent {
  objects: DetectedObject[];
}

/**
 * Check if a value is a valid bounding box array
 */
function isValidBbox(box: unknown): box is BoundingBox {
  return Array.isArray(box) && box.length === 4 && box.every(n => typeof n === 'number');
}

/**
 * Calculate center point of a bounding box [x1, y1, x2, y2]
 */
function getCenter(box: BoundingBox): { cx: number; cy: number } {
  const [x1, y1, x2, y2] = box;
  return {
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
  };
}

/**
 * Sort objects from top-left to bottom-right based on center point.
 * Uses row-based sorting: objects on same approximate row (within 10% tolerance)
 * are sorted left-to-right.
 */
function sortByPosition(objects: DetectedObject[]): DetectedObject[] {
  const ROW_TOLERANCE = 0.1; // 10% tolerance for considering objects on same row

  return [...objects].sort((a, b) => {
    const centerA = getCenter(a.bbox);
    const centerB = getCenter(b.bbox);

    // If centers are on approximately the same row, sort by x
    if (Math.abs(centerA.cy - centerB.cy) < ROW_TOLERANCE) {
      return centerA.cx - centerB.cx;
    }

    // Otherwise sort by y first
    return centerA.cy - centerB.cy;
  });
}

export function ImageObjectsRenderer({ content, onHighlightRegion }: ImageObjectsRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No objects detected
      </p>
    );
  }

  let objects: DetectedObject[] = [];
  try {
    const data: ImageObjectsContent = JSON.parse(content);
    // Filter out objects with invalid bounding boxes
    objects = (data.objects ?? []).filter(obj => isValidBbox(obj.bbox));
  } catch {
    return (
      <p className="text-sm text-muted-foreground italic">
        Invalid object data
      </p>
    );
  }

  if (objects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No objects detected
      </p>
    );
  }

  const sortedObjects = sortByPosition(objects);

  const handleClick = (obj: DetectedObject) => {
    if (onHighlightRegion) {
      onHighlightRegion({ bbox: obj.bbox, rle: obj.rle });
    }
  };

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {sortedObjects.map((obj, index) => (
        <button
          key={index}
          type="button"
          className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary/15 text-primary hover:bg-primary/25 transition-colors cursor-pointer"
          title={obj.description}
          onClick={() => handleClick(obj)}
        >
          {obj.title}
        </button>
      ))}
    </div>
  );
}
