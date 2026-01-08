/**
 * Doc to Markdown Renderer
 * Displays markdown text extracted from documents (Word, PDF, etc.)
 * Scrollable with same height constraint as image-ocr
 */

import type { DigestRendererProps } from './index';

export function DocToMarkdownRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No content extracted
      </p>
    );
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No content extracted from document
      </p>
    );
  }

  return (
    <div className="mt-2 p-2 rounded bg-muted/50 max-h-48 overflow-y-auto">
      <p className="text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">
        {trimmed}
      </p>
    </div>
  );
}
