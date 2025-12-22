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

  // Calculate overlay style from bounding box [x1, y1, x2, y2] normalized to [0,1]
  const getOverlayStyle = () => {
    if (!highlightedBox) return undefined;

    const [x1, y1, x2, y2] = highlightedBox;

    // Convert normalized coordinates to percentages
    const leftPct = x1 * 100;
    const topPct = y1 * 100;
    const widthPct = (x2 - x1) * 100;
    const heightPct = (y2 - y1) * 100;

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
