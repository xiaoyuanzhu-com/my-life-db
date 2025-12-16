/**
 * Tags Renderer
 * Displays AI-generated tags as chips/pills
 */

import type { DigestRendererProps } from './index';

interface TagsContent {
  tags?: string[];
  textSource?: string;
}

export function TagsRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No tags generated
      </p>
    );
  }

  let tags: string[] = [];
  try {
    const data: TagsContent = JSON.parse(content);
    tags = data.tags ?? [];
  } catch {
    // Try parsing as plain array
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        tags = parsed.map(String);
      }
    } catch {
      // Not valid JSON
      return (
        <p className="text-sm text-muted-foreground italic">
          Invalid tag data
        </p>
      );
    }
  }

  if (tags.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No tags generated
      </p>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {tags.map((tag, i) => (
        <span
          key={i}
          className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary/15 text-primary"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}
