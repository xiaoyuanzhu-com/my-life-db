/**
 * Doc to Screenshot Renderer
 * Displays the screenshot captured from a document (Word, PDF, etc.)
 * Same height constraint as doc-to-markdown for consistency
 */

import type { DigestRendererProps } from './index';
import { getSqlarUrl } from '../../utils';

export function DocToScreenshotRenderer({ sqlarName }: DigestRendererProps) {
  if (!sqlarName) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No screenshot available
      </p>
    );
  }

  const screenshotUrl = getSqlarUrl(sqlarName);

  return (
    <div className="mt-2 flex justify-center">
      <img
        src={screenshotUrl}
        alt="Document screenshot"
        className="max-w-full max-h-48 object-contain rounded border border-border bg-muted"
        loading="lazy"
      />
    </div>
  );
}
