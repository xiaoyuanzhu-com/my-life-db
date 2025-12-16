/**
 * Digest Renderer Registry
 * Maps digest types to specialized rendering components
 */

import type { ComponentType } from 'react';
import { UrlCrawlScreenshotRenderer } from './url-crawl-screenshot';
import { UrlCrawlContentRenderer } from './url-crawl-content';
import { UrlCrawlSummaryRenderer } from './url-crawl-summary';
import { TagsRenderer } from './tags';
import { SpeechRecognitionRenderer } from './speech-recognition';
import { ImageCaptioningRenderer } from './image-captioning';
import { ImageOcrRenderer } from './image-ocr';
import { SearchKeywordRenderer } from './search-keyword';
import { SearchSemanticRenderer } from './search-semantic';
import { FallbackRenderer } from './fallback';

export interface DigestRendererProps {
  content: string | null;
  sqlarName?: string | null;
  filePath: string;
}

type DigestRenderer = ComponentType<DigestRendererProps>;

const renderers: Record<string, DigestRenderer> = {
  'url-crawl-screenshot': UrlCrawlScreenshotRenderer,
  'url-crawl-content': UrlCrawlContentRenderer,
  'url-crawl-summary': UrlCrawlSummaryRenderer,
  'tags': TagsRenderer,
  'speech-recognition': SpeechRecognitionRenderer,
  'image-captioning': ImageCaptioningRenderer,
  'image-ocr': ImageOcrRenderer,
  'search-keyword': SearchKeywordRenderer,
  'search-semantic': SearchSemanticRenderer,
};

/**
 * Get the renderer component for a digest type
 */
export function getDigestRenderer(digestType: string): DigestRenderer {
  return renderers[digestType] ?? FallbackRenderer;
}

export { FallbackRenderer };
