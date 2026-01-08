/**
 * Document to Markdown Conversion
 * Uses HAID service to convert documents (PDF, Word, PowerPoint, Excel, EPUB) to markdown
 */

import { getSettings } from '~/.server/config/storage';
import { getLogger } from '~/.server/log/logger';
import { promises as fs } from 'fs';
import path from 'path';

const log = getLogger({ module: 'DocToMarkdown' });
const DEFAULT_BASE_URL = 'http://172.16.2.11:3003';
const DEFAULT_LIB = 'microsoft/markitdown';

export interface DocToMarkdownOptions {
  filePath: string;
  filename: string;
  lib?: string;
}

export interface DocToMarkdownResponse {
  requestId: string;
  processingTimeMs: number;
  markdown: string;
  model: string;
}

/**
 * Convert a document file to markdown using HAID service
 */
export async function convertDocToMarkdown(
  options: DocToMarkdownOptions
): Promise<DocToMarkdownResponse> {
  if (!options.filePath) {
    throw new Error('convertDocToMarkdown requires a filePath');
  }

  if (!options.filename) {
    throw new Error('convertDocToMarkdown requires a filename');
  }

  // Read file and convert to base64
  const fullPath = path.join(process.env.MY_DATA_DIR || './data', options.filePath);
  const fileBuffer = await fs.readFile(fullPath);
  const base64Data = fileBuffer.toString('base64');

  log.debug(
    {
      filePath: options.filePath,
      filename: options.filename,
      fileSize: fileBuffer.length,
      base64Size: base64Data.length,
    },
    'converting document to markdown'
  );

  const config = await resolveHaidConfig();
  const endpoint = `${config.baseUrl}/api/doc-to-markdown`;
  const lib = options.lib || DEFAULT_LIB;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      lib,
      filename: options.filename,
      file: base64Data,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HAID doc-to-markdown error (${response.status}): ${errorText || response.statusText}`
    );
  }

  // Check if response is actually JSON
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    const responseText = await response.text();
    log.error(
      {
        endpoint,
        contentType,
        responsePreview: responseText.substring(0, 200),
      },
      'HAID returned non-JSON response'
    );
    throw new Error(
      `HAID returned ${contentType || 'unknown'} instead of JSON. Response: ${responseText.substring(0, 200)}`
    );
  }

  const data = await response.json();

  if (!data.markdown) {
    throw new Error('HAID doc-to-markdown response did not include markdown');
  }

  const result = {
    requestId: data.request_id ?? 'unknown',
    processingTimeMs: data.processing_time_ms ?? 0,
    markdown: data.markdown,
    model: data.model ?? lib,
  };

  log.info(
    {
      filePath: options.filePath,
      filename: options.filename,
      requestId: result.requestId,
      processingTimeMs: result.processingTimeMs,
      markdownLength: result.markdown.length,
    },
    'document converted to markdown'
  );

  return result;
}

async function resolveHaidConfig(): Promise<{
  baseUrl: string;
  apiKey?: string;
}> {
  let baseUrl = process.env.HAID_BASE_URL;

  try {
    const settings = await getSettings();
    baseUrl = baseUrl || settings.vendors?.homelabAi?.baseUrl || DEFAULT_BASE_URL;
  } catch (error) {
    log.warn({ err: error }, 'failed to load HAID base URL from settings, using defaults');
    baseUrl = baseUrl || DEFAULT_BASE_URL;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: process.env.HAID_API_KEY,
  };
}
