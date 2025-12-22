/**
 * Image Objects Renderer
 * Displays detected objects sorted from top-left to bottom-right by bounding box center
 */

import type { DigestRendererProps } from './index';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageObjectsRendererProps extends DigestRendererProps {
  /** Callback when an object is clicked, passing its bounding box */
  onHighlightBoundingBox?: (box: BoundingBox | null) => void;
}

interface DetectedObject {
  name: string;
  description: string;
  category: string;
  bounding_box: BoundingBox;
  confidence?: number;
}

interface ImageObjectsContent {
  objects: DetectedObject[];
}

/**
 * Calculate center point of a bounding box
 */
function getCenter(box: BoundingBox): { cx: number; cy: number } {
  return {
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
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
    const centerA = getCenter(a.bounding_box);
    const centerB = getCenter(b.bounding_box);

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
    console.log('Object clicked:', obj.name, 'callback exists:', !!onHighlightBoundingBox);
    if (onHighlightBoundingBox) {
      onHighlightBoundingBox(obj.bounding_box);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {sortedObjects.map((obj, i) => (
        <button
          key={i}
          type="button"
          className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary/15 text-primary hover:bg-primary/25 transition-colors cursor-pointer"
          title={obj.description}
          onClick={() => handleClick(obj)}
        >
          {obj.name}
        </button>
      ))}
    </div>
  );
}
