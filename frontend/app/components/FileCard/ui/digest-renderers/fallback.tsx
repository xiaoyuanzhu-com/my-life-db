/**
 * Fallback Renderer
 * Generic renderer for unknown digest types
 */

import type { DigestRendererProps } from './index';

export function FallbackRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return null;
  }

  // Try to parse as JSON for structured display
  try {
    const parsed = JSON.parse(content);

    // Array of strings (like tags)
    if (Array.isArray(parsed)) {
      return (
        <div className="mt-2 flex flex-wrap gap-1">
          {parsed.map((item, i) => (
            <span
              key={i}
              className="px-2 py-0.5 text-xs bg-muted rounded-full text-foreground"
            >
              {String(item)}
            </span>
          ))}
        </div>
      );
    }

    // Object - show formatted JSON
    if (typeof parsed === 'object' && parsed !== null) {
      return (
        <pre className="mt-2 text-xs text-muted-foreground overflow-auto max-h-32 p-2 bg-muted/50 rounded font-mono">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    }
  } catch {
    // Not JSON, display as text
  }

  // Plain text content
  return (
    <p className="mt-2 text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap">
      {content}
    </p>
  );
}
