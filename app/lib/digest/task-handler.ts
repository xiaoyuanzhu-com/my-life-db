/**
 * Digest Processing Helpers
 * Direct access to digest coordinator for API endpoints and background processing
 */

import { defineTaskHandler } from '~/lib/task-queue/handler-registry';
import { DigestCoordinator } from './coordinator';
import { findFilesNeedingDigestion } from './file-selection';
import { getLogger } from '~/lib/log/logger';

const log = getLogger({ module: 'DigestTaskHandler' });

/**
 * Payload for digest_batch task
 */
export interface DigestBatchPayload {
  limit?: number; // Maximum number of files to process
}

/**
 * Task handler: Process a batch of files needing digestion
 * Finds files with pending/failed digests and processes them
 * This is used by the DigestSupervisor for background processing
 */
export const digestBatchHandler = defineTaskHandler<DigestBatchPayload>({
  type: 'digest_batch',
  module: 'digest/task-handler',
  handler: async (payload) => {
    const limit = payload.limit ?? 50;

    log.info({ limit }, 'finding files needing digestion');

    const filesToProcess = findFilesNeedingDigestion(limit);

    if (filesToProcess.length === 0) {
      log.info({}, 'no files need digestion');
      return;
    }

    log.info({ count: filesToProcess.length }, 'processing files');

    const coordinator = new DigestCoordinator();

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

/**
 * Process a file through all digesters directly
 * Use this for API endpoints that need immediate digest processing
 *
 * @param filePath - Relative path from DATA_ROOT
 * @param options - Processing options
 * @param options.reset - If true, clear existing digests before processing
 * @param options.digester - If provided, only reset and reprocess this specific digester
 */
export async function processFileDigests(
  filePath: string,
  options?: { reset?: boolean; digester?: string }
): Promise<void> {
  const coordinator = new DigestCoordinator();
  await coordinator.processFile(filePath, options);
}
