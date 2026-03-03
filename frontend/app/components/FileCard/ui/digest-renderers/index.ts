/**
 * Digest Renderer Registry
 * Maps digest types to specialized rendering components
 */

import type { ComponentType } from 'react';
import { TagsRenderer } from './tags';
import { SpeechRecognitionRenderer } from './speech-recognition';
import { SearchKeywordRenderer } from './search-keyword';
import { SearchSemanticRenderer } from './search-semantic';
import { SpeakerEmbeddingRenderer } from './speaker-embedding';
import { SpeechRecognitionCleanupRenderer } from './speech-recognition-cleanup';
import { SpeechRecognitionSummaryRenderer } from './speech-recognition-summary';
import { FallbackRenderer } from './fallback';

export interface DigestRendererProps {
  content: string | null;
  sqlarName?: string | null;
  filePath: string;
}

type DigestRenderer = ComponentType<DigestRendererProps>;

const renderers: Record<string, DigestRenderer> = {
  'tags': TagsRenderer,
  'speech-recognition': SpeechRecognitionRenderer,
  'search-keyword': SearchKeywordRenderer,
  'search-semantic': SearchSemanticRenderer,
  'speaker-embedding': SpeakerEmbeddingRenderer,
  'speech-recognition-cleanup': SpeechRecognitionCleanupRenderer,
  'speech-recognition-summary': SpeechRecognitionSummaryRenderer,
};

/**
 * Get the renderer component for a digest type
 */
export function getDigestRenderer(digestType: string): DigestRenderer {
  return renderers[digestType] ?? FallbackRenderer;
}

export { FallbackRenderer };
