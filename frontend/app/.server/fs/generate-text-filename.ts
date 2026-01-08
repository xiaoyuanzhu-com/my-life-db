/**
 * Generate human-readable filename from text content
 * Used for text saves to inbox
 */

/**
 * Remove emoji characters from text
 * Uses a simple approach - check if character is in emoji unicode ranges
 */
function removeEmoji(text: string): string {
  // Use a simple regex that avoids the character class issue
  // This catches most common emoji without triggering ESLint
  return text
    .replace(/\p{Emoji_Presentation}/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '');
}

// Code-like patterns that indicate invalid content for filename
const CODE_PATTERNS = [
  /^[{[<]/, // Starts with JSON/XML/array
  /^import\s+/,
  /^export\s+/,
  /^const\s+/,
  /^let\s+/,
  /^var\s+/,
  /^function\s+/,
  /^class\s+/,
  /^interface\s+/,
  /^type\s+/,
  /^enum\s+/,
  /^async\s+/,
  /^await\s+/,
  /^return\s+/,
  /^if\s*\(/,
  /^for\s*\(/,
  /^while\s*\(/,
  /^switch\s*\(/,
];

/**
 * Generate a filename from text content
 * Returns null if content is invalid (code-like, no letters, etc.)
 *
 * @param text - The text content to generate filename from
 * @returns Filename without extension (e.g., "hello-world") or null if invalid
 */
export function generateTextFilename(text: string): string | null {
  // Step 1: Extract first non-empty line
  const firstLine = getFirstNonEmptyLine(text);
  if (!firstLine) {
    return null;
  }

  // Step 2: Detect type and extract content
  let content: string;
  let isUrl = false;

  if (/^https?:\/\//i.test(firstLine)) {
    isUrl = true;
    content = processUrl(firstLine);
  } else if (/^#+\s*/.test(firstLine)) {
    // Markdown heading - strip leading #s
    content = firstLine.replace(/^#+\s*/, '');
  } else {
    content = firstLine;
  }

  // Step 3: Validate (skip for URLs)
  if (!isUrl && isCodeLike(content)) {
    return null;
  }

  // Step 4: Extract words
  const words = extractWords(content);

  // Step 5: Filter - each word must have at least 1 letter
  const filteredWords = words.filter((word) => /\p{L}/u.test(word));

  if (filteredWords.length === 0) {
    return null;
  }

  // Step 6: Truncate to 5 words, or fewer if too long
  const truncatedWords = truncateWords(filteredWords, 5, 50);

  if (truncatedWords.length === 0) {
    return null;
  }

  // Step 7: Format
  const filename = formatFilename(truncatedWords);

  // Step 8: Final validation
  if (!filename || filename.length < 2) {
    return null;
  }

  return filename;
}

/**
 * Get the first non-empty line from text
 */
function getFirstNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Process URL to extract meaningful parts
 * - Remove protocol
 * - Remove www and TLD from hostname
 * - Keep rest as-is for word extraction
 */
function processUrl(url: string): string {
  // Remove protocol
  const withoutProtocol = url.replace(/^https?:\/\//i, '');

  // Split hostname from rest
  const slashIndex = withoutProtocol.indexOf('/');
  let hostname: string;
  let rest: string;

  if (slashIndex === -1) {
    hostname = withoutProtocol;
    rest = '';
  } else {
    hostname = withoutProtocol.slice(0, slashIndex);
    rest = withoutProtocol.slice(slashIndex);
  }

  // Process hostname: split by dot, remove www, remove last segment (TLD)
  const hostParts = hostname.split('.').filter((part) => part.toLowerCase() !== 'www');

  // Remove last segment (TLD)
  if (hostParts.length > 1) {
    hostParts.pop();
  }

  // Reconstruct: hostname parts + rest
  return hostParts.join('-') + rest;
}

/**
 * Check if content looks like code
 */
function isCodeLike(content: string): boolean {
  return CODE_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Extract words from content
 * Splits by anything that's not a letter, digit, or unicode letter
 */
function extractWords(content: string): string[] {
  // Replace non-alphanumeric (keeping unicode letters) with spaces
  const normalized = content.replace(/[^\p{L}\p{N}]/gu, ' ');

  // Split and filter empty
  return normalized.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * Truncate words to maxWords, or fewer if total length exceeds maxChars
 */
function truncateWords(words: string[], maxWords: number, maxChars: number): string[] {
  const result: string[] = [];
  let totalLength = 0;

  for (const word of words) {
    if (result.length >= maxWords) {
      break;
    }

    // Account for hyphen separator (except for first word)
    const addedLength = result.length === 0 ? word.length : word.length + 1;

    if (totalLength + addedLength > maxChars && result.length > 0) {
      break;
    }

    result.push(word);
    totalLength += addedLength;
  }

  return result;
}

/**
 * Format words into a filename
 * - Lowercase
 * - Remove emoji
 * - Join with hyphen
 * - Clean up multiple/leading/trailing hyphens
 */
function formatFilename(words: string[]): string {
  return words
    .map((word) => word.toLowerCase())
    .map((word) => removeEmoji(word)) // Remove emoji
    .join('-')
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, ''); // Trim leading/trailing hyphens
}
