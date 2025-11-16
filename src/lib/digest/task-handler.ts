/**
 * Task Queue Handler for Digest Processing
 * Integrates digest coordinator with the task queue system
 */

import { defineTaskHandler } from '@/lib/task-queue/handler-registry';
import { DigestCoordinator } from './coordinator';
import { findFilesNeedingDigestion } from './file-selection';
import { getDatabase } from '@/lib/db/connection';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DigestTaskHandler' });

/**
 * Payload for digest_file task
 */
export interface DigestFilePayload {
  filePath: string;
}

/**
 * Payload for digest_batch task
 */
export interface DigestBatchPayload {
  limit?: number; // Maximum number of files to process
}

/**
 * Task handler: Process a single file through digest system
 */
export const digestFileHandler = defineTaskHandler<DigestFilePayload>({
  type: 'digest_file',
  module: 'digest/task-handler',
  handler: async (payload) => {
    const { filePath } = payload;

    log.info({ filePath }, 'processing file');

    const db = getDatabase();
    const coordinator = new DigestCoordinator(db);

    await coordinator.processFile(filePath);

    log.info({ filePath }, 'file processing complete');
  },
});

/**
 * Task handler: Process a batch of files needing digestion
 * Finds files with pending/failed digests and processes them
 */
export const digestBatchHandler = defineTaskHandler<DigestBatchPayload>({
  type: 'digest_batch',
  module: 'digest/task-handler',
  handler: async (payload) => {
    const limit = payload.limit ?? 50;

    log.info({ limit }, 'finding files needing digestion');

    const db = getDatabase();
    const filesToProcess = findFilesNeedingDigestion(db, limit);

    if (filesToProcess.length === 0) {
      log.info({}, 'no files need digestion');
      return;
    }

    log.info({ count: filesToProcess.length }, 'processing files');

    const coordinator = new DigestCoordinator(db);

    for (const filePath of filesToProcess) {
      try {
        await coordinator.processFile(filePath);
      } catch (error) {
        log.error({ filePath, error }, 'failed to process file');
        // Continue to next file
      }
    }

    log.info({ processed: filesToProcess.length }, 'batch processing complete');
  },
});
