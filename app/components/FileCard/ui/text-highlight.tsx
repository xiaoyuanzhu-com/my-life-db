import type { ReactNode } from 'react';

/**
 * Highlight matching terms in text
 * Returns React elements with <mark> tags for matches
 */
export function highlightMatches(text: string, terms: string[]): ReactNode {
  const escapedTerms = Array.from(new Set(
    terms
      .map(term => term.trim())
      .filter(term => term.length > 0)
      .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  ));

  if (escapedTerms.length === 0) {
    return text;
  }

  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  const parts = text.split(regex);

  return parts.map((part, index) => {
    const isMatch = index % 2 === 1;
    if (!isMatch) {
      return <span key={`text-${index}`}>{part}</span>;
    }

    return (
      <mark
        key={`match-${index}`}
        className="rounded-sm bg-yellow-300/90 px-0.5 py-0 text-slate-900 ring-1 ring-yellow-400 dark:bg-yellow-200/95 dark:text-slate-900 dark:ring-yellow-300"
      >
        {part}
      </mark>
    );
  });
}

/**
 * Render a snippet with <em> tags from Meilisearch as React mark elements.
 * Handles fuzzy match highlights like "docube" → "<em>Docume</em>ntation"
 */
export function renderHighlightedSnippet(snippet: string): ReactNode {
  const parts = snippet.split(/(<em>|<\/em>)/);
  const elements: ReactNode[] = [];
  let isHighlight = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part === '<em>') {
      isHighlight = true;
    } else if (part === '</em>') {
      isHighlight = false;
    } else if (part) {
      if (isHighlight) {
        elements.push(
          <mark
            key={`match-${i}`}
            className="rounded-sm bg-yellow-300/90 px-0.5 py-0 text-slate-900 ring-1 ring-yellow-400 dark:bg-yellow-200/95 dark:text-slate-900 dark:ring-yellow-300"
          >
            {part}
          </mark>
        );
      } else {
        elements.push(<span key={`text-${i}`}>{part}</span>);
      }
    }
  }

  return <>{elements}</>;
}
