/**
 * Image Objects Renderer
 * Displays detected objects sorted from top-left to bottom-right by bounding box center
 */

import type { DigestRendererProps } from './index';

/** Bounding box as [x1, y1, x2, y2] normalized to [0,1] */
export type BoundingBox = [number, number, number, number];

export interface ImageObjectsRendererProps extends DigestRendererProps {
  /** Callback when an object is clicked, passing its bounding box */
  onHighlightBoundingBox?: (box: BoundingBox | null) => void;
}

interface DetectedObject {
  id: string;
  title: string;
  name: string;
  category: string;
  description: string;
  bbox: BoundingBox;
  certainty: 'certain' | 'likely' | 'uncertain';
}

interface ImageObjectsContent {
  objects: DetectedObject[];
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

export function ImageObjectsRenderer({ content, onHighlightBoundingBox }: ImageObjectsRendererProps) {
  console.log('ImageObjectsRenderer mounted, onHighlightBoundingBox:', !!onHighlightBoundingBox);

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
    objects = data.objects ?? [];
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
    console.log('Object clicked:', obj.title, 'callback exists:', !!onHighlightBoundingBox);
    if (onHighlightBoundingBox) {
      onHighlightBoundingBox(obj.bbox);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {sortedObjects.map((obj) => (
        <button
          key={obj.id}
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
