/**
 * Image OCR Renderer
 * Displays text extracted from images
 */

import type { DigestRendererProps } from './index';

export function ImageOcrRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No text detected
      </p>
    );
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No text detected in image
      </p>
    );
  }

  return (
    <div className="mt-2 p-2 rounded bg-muted/50">
      <p className="text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">
        {trimmed}
      </p>
    </div>
  );
}
