import { getSettings } from '~/.server/config/storage';
import { getLogger } from '~/.server/log/logger';

const log = getLogger({ module: 'VendorHAID' });
const DEFAULT_MODEL = 'Qwen/Qwen3-Embedding-0.6B';
const DEFAULT_BASE_URL = 'http://172.16.2.11:3003';
const DEFAULT_CHROME_CDP_URL = 'http://172.16.2.2:9223/';

export interface HaidSpeechRecognitionOptions {
  audioPath: string;
  model?: string;
  diarization?: boolean;
  lib?: string;
  minSpeakers?: number;
  maxSpeakers?: number;
}

export interface HaidSpeechRecognitionWord {
  word: string;
  start: number;
  end: number;
  speaker: string | null;
}

export interface HaidSpeechRecognitionSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
  words: HaidSpeechRecognitionWord[];
}

export interface HaidSpeechRecognitionSpeaker {
  speaker_id: string;
  embedding: number[];  // 512 floats
  total_duration: number;
  segment_count: number;
}

export interface HaidSpeechRecognitionResponse {
  request_id: string;
  processing_time_ms: number;
  text: string;
  language: string;
  model: string;
  segments: HaidSpeechRecognitionSegment[];
  speakers?: HaidSpeechRecognitionSpeaker[];
}

export interface HaidEmbeddingOptions {
  texts: string[];
  model?: string;
}

export interface HaidEmbeddingResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export interface HaidCrawlOptions {
  url: string;
  screenshot?: boolean;
  timeoutMs?: number;
  pageTimeout?: number;
}

export interface HaidCrawlMetadata {
  title?: string;
  description?: string;
  author?: string;
  publishedDate?: string;
  image?: string;
  siteName?: string;
  domain?: string;
}

export interface HaidCrawlResponse {
  url: string;
  redirectedTo?: string | null;
  html?: string | null;
  markdown?: string | null;
  metadata?: HaidCrawlMetadata;
  screenshot?: {
    base64: string;
    mimeType: string;
  } | null;
}

export async function crawlUrlWithHaid(
  options: HaidCrawlOptions
): Promise<HaidCrawlResponse> {
  if (!options.url) {
    throw new Error('crawlUrlWithHaid requires a URL');
  }

  const config = await resolveHaidConfig();
  const endpoint = `${config.baseUrl}/api/crawl`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      url: options.url,
      screenshot: options.screenshot ?? true,
      screenshot_fullpage: false,
      screenshot_width: 1920,
      screenshot_height: 1080,
      page_timeout: options.pageTimeout ?? 120000,
      chrome_cdp_url: config.chromeCdpUrl,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HAID crawl error (${response.status}): ${errorText || response.statusText}`);
  }

  // Check if response is actually JSON
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    const responseText = await response.text();
    log.error({
      endpoint,
      contentType,
      responsePreview: responseText.substring(0, 200)
    }, 'HAID returned non-JSON response');
    throw new Error(`HAID returned ${contentType || 'unknown'} instead of JSON. Response: ${responseText.substring(0, 200)}`);
  }

  const data = await response.json();

  const result = {
    url: data.url ?? options.url,
    redirectedTo: data.redirectedTo ?? data.redirect_url ?? null,
    html: data.html ?? null,
    markdown: data.markdown ?? data.text ?? null,
    metadata: normalizeMetadata(data),
    screenshot: normalizeScreenshot(data),
  };

  log.info({
    url: options.url,
    hasHtml: Boolean(result.html),
    hasMarkdown: Boolean(result.markdown),
    hasScreenshot: Boolean(result.screenshot),
    screenshotKeys: data.screenshot ? Object.keys(data.screenshot) : null,
  }, 'crawl response processed');

  return result;
}

export async function callHaidEmbedding(
  options: HaidEmbeddingOptions
): Promise<HaidEmbeddingResponse> {
  if (!options.texts || options.texts.length === 0) {
    throw new Error('HAID embedding requires at least one text');
  }

  const config = await resolveHaidConfig();
  const endpoint = `${config.baseUrl}/api/text-to-embedding`;
  const model = options.model || process.env.HAID_EMBEDDING_MODEL || DEFAULT_MODEL;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      texts: options.texts,
      model,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HAID embedding error (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();
  const embeddings = extractEmbeddings(data);
  if (!embeddings.length) {
    throw new Error('HAID embedding response did not include embeddings');
  }

  const dimensions = data.dimensions ?? (embeddings[0] ? embeddings[0].length : 0);

  return {
    embeddings,
    model: data.model ?? model,
    dimensions,
  };
}

const DEFAULT_ASR_MODEL = 'large-v3';

export async function speechRecognitionWithHaid(
  options: HaidSpeechRecognitionOptions
): Promise<HaidSpeechRecognitionResponse> {
  if (!options.audioPath) {
    throw new Error('HAID speech recognition requires an audio file path');
  }

  const config = await resolveHaidConfig();
  const endpoint = `${config.baseUrl}/api/automatic-speech-recognition`;

  // Read audio file and convert to base64
  const fs = await import('fs');
  const audioBuffer = fs.readFileSync(options.audioPath);
  const audioBase64 = audioBuffer.toString('base64');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      audio: audioBase64,
      model: options.model ?? DEFAULT_ASR_MODEL,
      diarization: options.diarization ?? true,
      lib: options.lib ?? 'whisperx',
      min_speakers: options.minSpeakers ?? 1,
      max_speakers: options.maxSpeakers ?? 4,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HAID speech recognition error (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();

  log.info({
    audioPath: options.audioPath,
    hasSegments: Array.isArray(data.segments),
    segmentCount: Array.isArray(data.segments) ? data.segments.length : 0,
  }, 'speech recognition completed');

  return data;
}

function normalizeMetadata(raw: any): HaidCrawlMetadata | undefined {
  if (!raw) return undefined;
  const metadata = raw.metadata ?? {};
  return {
    title: metadata.title ?? raw.title ?? undefined,
    description: metadata.description ?? raw.description ?? undefined,
    author: metadata.author ?? raw.author ?? undefined,
    publishedDate: metadata.publishedDate ?? raw.publishedDate ?? undefined,
    image: metadata.image ?? raw.image ?? undefined,
    siteName: metadata.siteName ?? raw.siteName ?? undefined,
    domain: metadata.domain ?? raw.domain ?? undefined,
  };
}

function normalizeScreenshot(raw: any): HaidCrawlResponse['screenshot'] {
  // HAID API returns screenshot_base64 field directly
  if (typeof raw?.screenshot_base64 === 'string' && raw.screenshot_base64.length > 0) {
    log.debug({ screenshotLength: raw.screenshot_base64.length }, 'screenshot extracted from HAID response');
    return {
      base64: raw.screenshot_base64,
      mimeType: 'image/png',
    };
  }
  log.warn({ hasScreenshotBase64: Boolean(raw?.screenshot_base64), type: typeof raw?.screenshot_base64 }, 'no screenshot_base64 in HAID response');
  return null;
}

function extractEmbeddings(payload: any): number[][] {
  if (Array.isArray(payload?.embeddings)) {
    return payload.embeddings as number[][];
  }

  if (Array.isArray(payload?.vectors)) {
    return payload.vectors as number[][];
  }

  if (Array.isArray(payload?.data)) {
    return payload.data
      .map((item: any) => item?.embedding)
      .filter((embedding: unknown): embedding is number[] => Array.isArray(embedding));
  }

  log.warn({ payload }, 'unable to detect embeddings array in HAID response');
  return [];
}

export interface HaidImageOcrOptions {
  imagePath: string;
  model?: string;
  outputFormat?: 'text' | 'markdown';
}

export interface HaidImageOcrResponse {
  request_id: string;
  processing_time_ms: number;
  text: string;
  model: string;
  output_format: string;
}

const DEFAULT_OCR_MODEL = 'deepseek-ai/DeepSeek-OCR';

export async function imageOcrWithHaid(
  options: HaidImageOcrOptions
): Promise<HaidImageOcrResponse> {
  if (!options.imagePath) {
    throw new Error('HAID image OCR requires an image file path');
  }

  const config = await resolveHaidConfig();
  const endpoint = `${config.baseUrl}/api/image-ocr`;

  // Read image file and convert to base64
  const fs = await import('fs');
  const imageBuffer = fs.readFileSync(options.imagePath);
  const imageBase64 = imageBuffer.toString('base64');

  const model = options.model || DEFAULT_OCR_MODEL;
  const outputFormat = options.outputFormat || 'text';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      output_format: outputFormat,
      image: imageBase64,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HAID image OCR error (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();

  log.info({
    imagePath: options.imagePath,
    processingTimeMs: data.processing_time_ms,
    textLength: data.text?.length ?? 0,
  }, 'image OCR completed');

  return data;
}

export interface HaidImageCaptioningOptions {
  imagePath: string;
  model?: string;
  prompt?: string;
}

export interface HaidImageCaptioningResponse {
  request_id: string;
  processing_time_ms: number;
  caption: string;
  model: string;
}

const DEFAULT_CAPTIONING_MODEL = 'deepseek-ai/DeepSeek-OCR';
const DEFAULT_CAPTIONING_PROMPT = 'Describe this image in detail.';

export async function imageCaptioningWithHaid(
  options: HaidImageCaptioningOptions
): Promise<HaidImageCaptioningResponse> {
  if (!options.imagePath) {
    throw new Error('HAID image captioning requires an image file path');
  }

  const config = await resolveHaidConfig();
  const endpoint = `${config.baseUrl}/api/image-captioning`;

  // Read image file and convert to base64
  const fs = await import('fs');
  const imageBuffer = fs.readFileSync(options.imagePath);
  const imageBase64 = imageBuffer.toString('base64');

  const model = options.model || DEFAULT_CAPTIONING_MODEL;
  const prompt = options.prompt || DEFAULT_CAPTIONING_PROMPT;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      prompt,
      image: imageBase64,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HAID image captioning error (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();

  log.info({
    imagePath: options.imagePath,
    processingTimeMs: data.processing_time_ms,
    captionLength: data.caption?.length ?? 0,
  }, 'image captioning completed');

  return data;
}

// ============================================================================
// SAM (Segment Anything Model) API
// ============================================================================

export interface HaidSamRle {
  size: [number, number]; // [height, width]
  counts: number[];
}

export interface HaidSamMask {
  rle: HaidSamRle;
  score: number;
  box: [number, number, number, number]; // [x1, y1, x2, y2] in pixels
}

export interface HaidSamOptions {
  imageBase64: string;
  prompt?: string; // Text prompt or 'auto' for automatic segmentation
  lib?: string;
  confidenceThreshold?: number;
  maxMasks?: number;
  // Auto mode options
  pointsPerSide?: number;
  pointsPerBatch?: number;
  autoIouThreshold?: number;
  autoMinAreaRatio?: number;
}

export interface HaidSamResponse {
  request_id: string;
  processing_time_ms: number;
  model: string;
  prompt: string;
  image_width: number;
  image_height: number;
  masks: HaidSamMask[];
}

const DEFAULT_SAM_LIB = 'facebookresearch/sam3';

export async function segmentImageWithHaid(
  options: HaidSamOptions
): Promise<HaidSamResponse> {
  if (!options.imageBase64) {
    throw new Error('HAID SAM requires a base64-encoded image');
  }

  const config = await resolveHaidConfig();
  const endpoint = `${config.baseUrl}/api/sam`;

  const requestBody: Record<string, unknown> = {
    image: options.imageBase64,
    prompt: options.prompt ?? 'auto',
    lib: options.lib ?? DEFAULT_SAM_LIB,
  };

  // Add threshold and max masks if provided
  if (options.confidenceThreshold !== undefined) {
    requestBody.confidence_threshold = options.confidenceThreshold;
  }
  if (options.maxMasks !== undefined) {
    requestBody.max_masks = options.maxMasks;
  }

  // Add auto mode options if using auto segmentation
  if (!options.prompt || options.prompt === 'auto') {
    if (options.pointsPerSide !== undefined) {
      requestBody.points_per_side = options.pointsPerSide;
    }
    if (options.pointsPerBatch !== undefined) {
      requestBody.points_per_batch = options.pointsPerBatch;
    }
    if (options.autoIouThreshold !== undefined) {
      requestBody.auto_iou_threshold = options.autoIouThreshold;
    }
    if (options.autoMinAreaRatio !== undefined) {
      requestBody.auto_min_area_ratio = options.autoMinAreaRatio;
    }
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HAID SAM error (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();

  log.info({
    prompt: options.prompt ?? 'auto',
    processingTimeMs: data.processing_time_ms,
    maskCount: data.masks?.length ?? 0,
    imageSize: `${data.image_width}x${data.image_height}`,
  }, 'SAM segmentation completed');

  return data;
}

async function resolveHaidConfig(): Promise<{
  baseUrl: string;
  apiKey?: string;
  chromeCdpUrl?: string;
}> {
  let baseUrl = process.env.HAID_BASE_URL;
  let chromeCdpUrl = process.env.HAID_CHROME_CDP_URL;

  try {
    const settings = await getSettings();
    baseUrl = baseUrl || settings.vendors?.homelabAi?.baseUrl || DEFAULT_BASE_URL;
    chromeCdpUrl = chromeCdpUrl || settings.vendors?.homelabAi?.chromeCdpUrl || DEFAULT_CHROME_CDP_URL;
  } catch (error) {
    log.warn({ err: error }, 'failed to load HAID base URL from settings, using defaults');
    baseUrl = baseUrl || DEFAULT_BASE_URL;
    chromeCdpUrl = chromeCdpUrl || DEFAULT_CHROME_CDP_URL;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: process.env.HAID_API_KEY,
    chromeCdpUrl,
  };
}
