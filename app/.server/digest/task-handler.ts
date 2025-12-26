/**
 * Digest Processing Helpers
 * Direct access to digest coordinator for API endpoints
 */

import { DigestCoordinator } from './coordinator';

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
