import 'server-only';
import type { ChunkDescriptor } from './types';

export interface ChunkerOptions {
  targetTokens: number;
  maxTokens: number;
  overlapRatio: number;
  minOverlapTokens: number;
  maxOverlapTokens: number;
}

const DEFAULT_OPTIONS: ChunkerOptions = {
  targetTokens: 900,
  maxTokens: 1200,
  overlapRatio: 0.15,
  minOverlapTokens: 80,
  maxOverlapTokens: 180,
};

interface BlockSegment {
  text: string;
  start: number;
  end: number;
  tokenCount: number;
}

interface BaseChunk {
  text: string;
  start: number;
  end: number;
  tokenCount: number;
  wordCount: number;
}

export function chunkMarkdownContent(
  content: string,
  options?: Partial<ChunkerOptions>
): ChunkDescriptor[] {
  const normalized = normalizeContent(content);
  if (!normalized) return [];

  const config: ChunkerOptions = { ...DEFAULT_OPTIONS, ...options };
  const segments = buildSegments(normalized);
  if (segments.length === 0) {
    return [];
  }

  const baseChunks = buildBaseChunks(segments, config);
  const chunkCount = baseChunks.length;
  if (chunkCount === 0) return [];

  const result: ChunkDescriptor[] = [];
  let previousUniqueText = '';

  baseChunks.forEach((chunk, index) => {
    let overlapTokens = 0;
    let overlapText = '';
    if (index > 0 && previousUniqueText) {
      overlapTokens = clamp(
        Math.round(chunk.tokenCount * config.overlapRatio),
        config.minOverlapTokens,
        config.maxOverlapTokens
      );
      overlapText = sliceTrailingTokens(previousUniqueText, overlapTokens);
    }

    const combinedText = overlapText
      ? `${overlapText.trimEnd()}\n\n${chunk.text}`.trim()
      : chunk.text;

    result.push({
      chunkIndex: index,
      chunkCount,
      text: combinedText,
      spanStart: chunk.start,
      spanEnd: chunk.end,
      overlapTokens,
      wordCount: countWords(combinedText),
      tokenCount: estimateTokenCount(combinedText),
    });

    previousUniqueText = chunk.text;
  });

  return result;
}

function normalizeContent(content: string): string {
  if (!content) return '';
  const normalized = content.replace(/\r\n/g, '\n').trim();
  return normalized;
}

function buildSegments(content: string): BlockSegment[] {
  const segments: BlockSegment[] = [];
  const lines = content.split('\n');
  let buffer = '';
  let bufferStart = 0;
  let cursor = 0;

  const flushBuffer = () => {
    if (!buffer.trim()) {
      buffer = '';
      return;
    }
    const end = bufferStart + buffer.length;
    const segment: BlockSegment = {
      text: buffer.trimEnd(),
      start: bufferStart,
      end,
      tokenCount: estimateTokenCount(buffer),
    };
    segments.push(segment);
    buffer = '';
  };

  lines.forEach((line, index) => {
    const lineWithNewline = index < lines.length - 1 ? `${line}\n` : line;
    const trimmed = line.trim();
    const lineStart = cursor;
    cursor += lineWithNewline.length;

    const isHeading = trimmed.startsWith('#');
    const isBlank = trimmed.length === 0;

    if (!buffer) {
      bufferStart = lineStart;
    }

    if (isHeading && buffer.trim()) {
      flushBuffer();
      bufferStart = lineStart;
    }

    buffer += lineWithNewline;

    if (isBlank) {
      flushBuffer();
    }
  });

  flushBuffer();
  return segments;
}

function buildBaseChunks(segments: BlockSegment[], options: ChunkerOptions): BaseChunk[] {
  const chunks: BaseChunk[] = [];
  let currentSegments: BlockSegment[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (currentSegments.length === 0) return;
    const text = currentSegments.map(seg => seg.text).join('\n\n').trim();
    if (!text) {
      currentSegments = [];
      currentTokens = 0;
      return;
    }
    const start = currentSegments[0].start;
    const end = currentSegments[currentSegments.length - 1].end;
    chunks.push({
      text,
      start,
      end,
      tokenCount: estimateTokenCount(text),
      wordCount: countWords(text),
    });
    currentSegments = [];
    currentTokens = 0;
  };

  for (const segment of segments) {
    const wouldExceed = currentTokens + segment.tokenCount > options.maxTokens;
    if (wouldExceed && currentSegments.length > 0) {
      flush();
    }

    currentSegments.push(segment);
    currentTokens += segment.tokenCount;

    if (currentTokens >= options.targetTokens) {
      flush();
    }
  }

  flush();
  return chunks;
}

function estimateTokenCount(text: string): number {
  if (!text.trim()) return 0;
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sliceTrailingTokens(text: string, tokenBudget: number): string {
  if (!text.trim() || tokenBudget <= 0) return '';
  const tokens: Array<{ start: number; end: number }> = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({ start: match.index, end: match.index + match[0].length });
  }
  if (tokens.length === 0) return '';
  const startIndex = tokens[Math.max(0, tokens.length - tokenBudget)].start;
  return text.slice(startIndex).trimStart();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
