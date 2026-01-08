/**
 * Client-side filename generation for text items
 * Mirrors the server-side logic in app/.server/fs/generate-text-filename.ts
 */

/**
 * Remove emoji characters from text
 */
function removeEmoji(text: string): string {
  return text
    .replace(/\p{Emoji_Presentation}/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '');
}

// Code-like patterns that indicate invalid content for filename
const CODE_PATTERNS = [
  /^[{[<]/,
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
 */
export function generateTextFilename(text: string): string | null {
  const firstLine = getFirstNonEmptyLine(text);
  if (!firstLine) {
    return null;
  }

  let content: string;
  let isUrl = false;

  if (/^https?:\/\//i.test(firstLine)) {
    isUrl = true;
    content = processUrl(firstLine);
  } else if (/^#+\s*/.test(firstLine)) {
    content = firstLine.replace(/^#+\s*/, '');
  } else {
    content = firstLine;
  }

  if (!isUrl && isCodeLike(content)) {
    return null;
  }

  const words = extractWords(content);
  const filteredWords = words.filter((word) => /\p{L}/u.test(word));

  if (filteredWords.length === 0) {
    return null;
  }

  const truncatedWords = truncateWords(filteredWords, 5, 50);

  if (truncatedWords.length === 0) {
    return null;
  }

  const filename = formatFilename(truncatedWords);

  if (!filename || filename.length < 2) {
    return null;
  }

  return filename;
}

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

function processUrl(url: string): string {
  const withoutProtocol = url.replace(/^https?:\/\//i, '');
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

  const hostParts = hostname.split('.').filter((part) => part.toLowerCase() !== 'www');

  if (hostParts.length > 1) {
    hostParts.pop();
  }

  return hostParts.join('-') + rest;
}

function isCodeLike(content: string): boolean {
  return CODE_PATTERNS.some((pattern) => pattern.test(content));
}

function extractWords(content: string): string[] {
  const normalized = content.replace(/[^\p{L}\p{N}]/gu, ' ');
  return normalized.split(/\s+/).filter((word) => word.length > 0);
}

function truncateWords(words: string[], maxWords: number, maxChars: number): string[] {
  const result: string[] = [];
  let totalLength = 0;

  for (const word of words) {
    if (result.length >= maxWords) {
      break;
    }

    const addedLength = result.length === 0 ? word.length : word.length + 1;

    if (totalLength + addedLength > maxChars && result.length > 0) {
      break;
    }

    result.push(word);
    totalLength += addedLength;
  }

  return result;
}

function formatFilename(words: string[]): string {
  return words
    .map((word) => word.toLowerCase())
    .map((word) => removeEmoji(word))
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Deduplicate filename within a batch
 * Uses macOS-style naming: file.md, file 2.md, file 3.md
 */
export function deduplicateFilename(filename: string, usedNames: Set<string>): string {
  if (!usedNames.has(filename)) {
    return filename;
  }

  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  const baseName = ext ? filename.slice(0, filename.lastIndexOf('.')) : filename;

  let counter = 2;
  while (true) {
    const candidateName = `${baseName} ${counter}${ext}`;
    if (!usedNames.has(candidateName)) {
      return candidateName;
    }
    counter++;
  }
}
