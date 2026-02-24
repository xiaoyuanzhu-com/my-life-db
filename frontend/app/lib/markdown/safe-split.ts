/**
 * Find the last safe character offset to split markdown text,
 * ensuring the split does not fall inside an open code fence.
 *
 * Returns a character offset such that `text.slice(0, offset)` ends
 * outside any code fence, making it safe to parse independently.
 *
 * If the entire text is inside a code fence (e.g. streaming a large
 * ```html block), returns 0 — meaning everything stays in the "new"
 * portion and the split is effectively skipped.
 */
export function findSafeSplitPoint(text: string): number {
  const lines = text.split('\n')
  let inCodeBlock = false
  let lastSafeEnd = 0
  let pos = 0

  for (const line of lines) {
    pos += line.length + 1 // +1 for the \n separator
    // Code fences: at least three backticks at the start of a line.
    // trimEnd() handles trailing whitespace after closing ```.
    if (/^```/.test(line.trimEnd())) {
      inCodeBlock = !inCodeBlock
    }
    if (!inCodeBlock) {
      lastSafeEnd = pos
    }
  }

  // Clamp to text length (the final line may not have a trailing \n)
  return Math.min(lastSafeEnd, text.length)
}
