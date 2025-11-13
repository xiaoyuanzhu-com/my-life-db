import 'server-only';

import path from 'path';
import { promises as fs } from 'fs';

import { DATA_ROOT } from '@/lib/fs/storage';
import { enqueueUrlEnrichment } from './enrichUrlInboxItem';
import type { UrlDigestPipelineStage } from '@/types/digest-workflow';
import type { MessageType } from '@/types';
import { getLogger } from '@/lib/log/logger';
import { deleteDigestsForPath } from '@/lib/db/digests';
import { sqlarDeletePrefix } from '@/lib/db/sqlar';
import { getDatabase } from '@/lib/db/connection';
import { getFileByPath } from '@/lib/db/files';
import { readPrimaryText } from './digestArtifacts';
import { ingestToMeilisearch } from '@/lib/search/ingest-to-meilisearch';
import { enqueueMeiliIndex } from '@/lib/search/meili-tasks';
import { getMeiliDocumentIdForFile } from '@/lib/db/meili-documents';

const log = getLogger({ module: 'DigestWorkflow' });

const URL_PIPELINE_ORDER: UrlDigestPipelineStage[] = ['summary', 'tagging', 'slug'];

/**
 * Generic digest workflow - detects type and routes to appropriate workflow
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
export async function startDigestWorkflow(filePath: string): Promise<{ taskId: string }> {
  const file = getFileByPath(filePath);
  if (!file) {
    throw new Error('File not found');
  }

  // Detect type by reading content
  const detectedType = await detectContentType(filePath);
  log.info({ filePath, detectedType }, 'detected content type');

  // Route to appropriate workflow based on type
  switch (detectedType) {
    case 'url':
      return await startUrlDigestWorkflow(filePath);
    default:
      throw new Error(`No digest workflow available for type: ${detectedType}`);
  }
}

/**
 * Detect content type by reading file content
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
async function detectContentType(filePath: string): Promise<MessageType> {
  // Read content from file
  const content = await readPrimaryText(filePath);
  if (!content) {
    return 'text'; // Default
  }

  // Check for URL pattern (matches frontend)
  const urlPattern = /^(https?:\/\/)/i;
  if (urlPattern.test(content.trim())) {
    return 'url';
  }

  return 'text';
}

/**
 * URL-specific digest workflow
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
async function startUrlDigestWorkflow(filePath: string): Promise<{ taskId: string }> {
  const url = await resolveUrlFromFile(filePath);
  if (!url) {
    throw new Error('URL not found in file');
  }

  await clearDigestArtifacts(filePath);

  const taskId = enqueueUrlEnrichment(filePath, url, {
    pipeline: true,
    remainingStages: [...URL_PIPELINE_ORDER],
  });

  log.info({ filePath, taskId }, 'url digest workflow started');

  return { taskId };
}

/**
 * Clear all digest artifacts for a file
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
async function clearDigestArtifacts(filePath: string): Promise<void> {
  // Clear digests from database
  const db = getDatabase();
  deleteDigestsForPath(filePath);

  // Clear SQLAR artifacts (using path hash as prefix)
  const pathHash = Buffer.from(filePath).toString('base64url').slice(0, 12);
  sqlarDeletePrefix(db, `${pathHash}/`);

  log.debug({ filePath }, 'cleared digest artifacts from database');
}

/**
 * Extract URL from file content
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 */
async function resolveUrlFromFile(filePath: string): Promise<string | null> {
  // Helper function to extract URL from text content
  function firstUrlFromText(text: string | null): string | null {
    if (!text) return null;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.find(line => /^https?:\/\//i.test(line)) || null;
  }

  const absolutePath = path.join(DATA_ROOT, filePath);

  // Check if this is a single file or a folder
  let isFile = false;
  try {
    const stats = await fs.stat(absolutePath);
    isFile = stats.isFile();
  } catch {
    return null; // Path doesn't exist
  }

  if (isFile) {
    // Single file: read directly
    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      const url = firstUrlFromText(content);
      if (url) return url;
    } catch {
      // continue
    }
    return null;
  }

  // Folder: search for URL in various files
  async function readFileIfExists(name: string): Promise<string | null> {
    try {
      const content = await fs.readFile(path.join(absolutePath, name), 'utf-8');
      if (content.trim().length > 0) {
        return content;
      }
    } catch {
      // File doesn't exist or can't be read
    }
    return null;
  }

  // Try url.txt first
  const urlTxt = await readFileIfExists('url.txt');
  let url = (urlTxt || '').trim();

  // Try text.md
  if (!url) {
    const textMd = await readFileIfExists('text.md');
    url = firstUrlFromText(textMd) || url;
  }

  // Try content.md
  if (!url) {
    const contentMd = await readFileIfExists('content.md');
    url = firstUrlFromText(contentMd) || url;
  }

  // Try main-content.md
  if (!url) {
    const mainContent = await readFileIfExists('main-content.md');
    url = firstUrlFromText(mainContent) || url;
  }

  return url || null;
}

/**
 * Start a specific digest step
 *
 * @param filePath - Relative path from DATA_ROOT (e.g., 'inbox/uuid-folder')
 * @param step - Digest step to run ('index', 'summary', 'tagging', 'slug', 'crawl')
 * @returns Task ID for the step
 */
export async function startDigestStep(filePath: string, step: string): Promise<{ taskId: string }> {
  const file = getFileByPath(filePath);
  if (!file) {
    throw new Error('File not found');
  }

  log.info({ filePath, step }, 'starting digest step');

  switch (step) {
    case 'index': {
      // Ingest to Meilisearch and enqueue indexing
      await ingestToMeilisearch(filePath);
      const documentId = getMeiliDocumentIdForFile(filePath);
      const taskId = enqueueMeiliIndex([documentId]);
      if (!taskId) {
        throw new Error('Failed to enqueue indexing task');
      }
      log.info({ filePath, taskId, documentId }, 'index step enqueued');
      return { taskId };
    }

    case 'summary':
    case 'tagging':
    case 'slug':
    case 'crawl': {
      // Get URL from file
      const url = await resolveUrlFromFile(filePath);
      if (!url) {
        throw new Error('URL not found in file');
      }

      // Map step to pipeline stage
      const stageMap: Record<string, UrlDigestPipelineStage> = {
        summary: 'summary',
        tagging: 'tagging',
        slug: 'slug',
      };

      const stage = step === 'crawl' ? undefined : stageMap[step];

      // Enqueue URL enrichment for this step only
      const taskId = enqueueUrlEnrichment(filePath, url, {
        pipeline: false,
        remainingStages: stage ? [stage] : [],
      });

      log.info({ filePath, taskId, step }, 'digest step enqueued');
      return { taskId };
    }

    default:
      throw new Error(`Unknown digest step: ${step}`);
  }
}
