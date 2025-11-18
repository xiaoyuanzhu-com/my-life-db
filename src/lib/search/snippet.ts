/**
 * Build a short snippet around the first match of any search term.
 * Returns ellipsized text like "...foo bar..." for digest previews.
 */
export function buildMatchSnippet(
  text: string,
  terms: string[],
  options?: {
    contextRadius?: number;
    maxLength?: number;
  }
): { snippet: string; matchFound: boolean } {
  const source = text ?? '';
  const cleanedTerms = Array.from(
    new Set(
      terms
        .map((term) => term.trim())
        .filter((term) => term.length > 0)
        .map((term) => term.toLowerCase())
    )
  );

  if (!source.trim()) {
    return { snippet: '', matchFound: false };
  }

  const collapsed = collapseWhitespace(source);
  const normalized = collapsed.toLowerCase();
  const radius = options?.contextRadius ?? 80;
  const hardLimit = options?.maxLength ?? 200;

  let matchIndex = -1;
  let matchLength = 0;

  for (const term of cleanedTerms) {
    if (!term) continue;
    const idx = normalized.indexOf(term);
    if (idx === -1) {
      continue;
    }
    if (matchIndex === -1 || idx < matchIndex) {
      matchIndex = idx;
      matchLength = term.length;
    }
  }

  if (matchIndex === -1) {
    const snippet = collapsed.length > hardLimit
      ? `${collapsed.slice(0, hardLimit).trim()}...`
      : collapsed;
    return { snippet, matchFound: false };
  }

  const start = Math.max(matchIndex - radius, 0);
  const end = Math.min(matchIndex + matchLength + radius, collapsed.length);

  let snippet = collapsed.slice(start, end).trim();
  const prefixed = start > 0;
  const suffixed = end < collapsed.length;

  if (prefixed) {
    snippet = `...${snippet}`;
  }
  if (suffixed) {
    snippet = `${snippet}...`;
  }

  if (snippet.length > hardLimit) {
    snippet = `${snippet.slice(0, hardLimit).trim()}...`;
  }

  return { snippet, matchFound: true };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
