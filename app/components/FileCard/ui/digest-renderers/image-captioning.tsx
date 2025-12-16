/**
 * Image Captioning Renderer
 * Displays AI-generated image caption
 */

import type { DigestRendererProps } from './index';

export function ImageCaptioningRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No caption generated
      </p>
    );
  }

  return (
    <p className="mt-2 text-sm text-foreground leading-relaxed">
      {content}
    </p>
  );
}
