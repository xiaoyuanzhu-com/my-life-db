import type { SearchResultItem } from '~/types/search';
import { renderHighlightedSnippet } from './text-highlight';

type MatchContextProps = {
  context: NonNullable<SearchResultItem['matchContext']>;
};

/**
 * Display search match context below card content
 * Handles both semantic and keyword matches
 *
 * Width behavior:
 * - No width set - fills parent width as a block element
 * - Parent card should set min-w-[calc(50vw-40px)] to ensure readability
 * - When MatchContext causes card to expand, file content should center (handled by parent)
 */
export function MatchContext({ context }: MatchContextProps) {
  const baseClasses =
    'border-t border-border bg-background/80 px-4 py-3 text-xs text-foreground/80';

  // Handle semantic match context
  if (context.source === 'semantic') {
    const scorePercent = context.score ? Math.round(context.score * 100) : null;
    return (
      <div className={baseClasses}>
        <p className="mb-1 font-semibold text-muted-foreground">
          Semantic match{scorePercent !== null ? ` (${scorePercent}% similar)` : ''}
          {context.sourceType && ` · ${context.sourceType}`}
        </p>
        <div className="text-xs text-foreground leading-relaxed italic break-words">
          {context.snippet}
        </div>
      </div>
    );
  }

  // Handle digest match context (keyword)
  // Snippet may contain <em> tags from Meilisearch (for fuzzy matches)
  const snippetWithHighlights = renderHighlightedSnippet(context.snippet);

  return (
    <div className={baseClasses}>
      <p className="mb-1 font-semibold text-muted-foreground">
        Matched in {context.digest?.label ?? 'content'}
      </p>
      <div className="text-xs text-foreground leading-relaxed break-words">
        {snippetWithHighlights}
      </div>
    </div>
  );
}
